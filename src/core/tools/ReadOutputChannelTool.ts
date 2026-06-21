import * as fs from "fs/promises"
import * as path from "path"

import { Task } from "../task/Task"

import { BaseTool, ToolCallbacks } from "./BaseTool"

/** Default byte limit for a read (40KB). */
const DEFAULT_LIMIT = 40 * 1024
/** Hard cap on returned bytes — a read can never be unlimited. */
const MAX_LIMIT = 256 * 1024
/** Maximum number of channels reported in list mode. */
const MAX_LIST = 300
/** Chunk size used for streaming reads/scans (bounded memory). */
const CHUNK_SIZE = 64 * 1024

/** Severity levels recognised in VS Code log lines, ordered least→most severe. */
const SEVERITY_RANK: Record<string, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warning: 3,
	warn: 3,
	error: 4,
}
/** Matches the first `[level]` token VS Code's LogOutputChannel emits per line. */
const LEVEL_TOKEN = /\[(trace|debug|info|warning|warn|error)\]/i

type ChannelTier = "core" | "window" | "extension" | "output"

interface DiscoveredChannel {
	/** Friendly id used to address the channel in read mode (its display name). */
	id: string
	tier: ChannelTier
	/** For extension-backed channels: the owning `publisher.extension` folder. */
	owner?: string
	/** Absolute path of the backing `.log` file. */
	file: string
	relPath: string
	size: number
	mtimeMs: number
}

/**
 * Parameters accepted by the read_output_channel tool.
 *
 * All parameters are optional. With no `channel`, the tool lists the output
 * channels available in the current VS Code session; with a `channel`, it reads
 * that channel's backing log file.
 */
interface ReadOutputChannelParams {
	/** Channel id/name to read. Omit to list all channels (list mode). */
	channel?: string
	/** Regex (case-insensitive) line filter applied in read mode. */
	search?: string
	/** Minimum severity to include (read mode): trace|debug|info|warning|error. */
	severity?: string
	/** Read the most-recent bytes first (default true). Ignored when `offset` is set. */
	tail?: boolean
	/** Byte offset to start reading from (pagination). Overrides `tail`. */
	offset?: number
	/** Maximum bytes to return. Default 40KB, hard-capped at 256KB. */
	limit?: number
}

/**
 * ReadOutputChannelTool lets the agent list and read VS Code Output panel
 * channels.
 *
 * ## Why this reads files, not the API
 *
 * VS Code's `OutputChannel` is **write-only** — the extension API exposes no way
 * to read a channel's content or enumerate channels other extensions registered.
 * However, VS Code persists essentially every channel to disk under its per-session
 * logs directory:
 *
 *   <logs>/<session>/                         core services (main, telemetry, …)
 *   <logs>/<session>/window<N>/               window-level logs (renderer, network)
 *   <logs>/<session>/window<N>/exthost/<pub.ext>/<Name>.log            LogOutputChannels
 *   <logs>/<session>/window<N>/exthost/output_logging_<ts>/<n>-<Name>.log  plain channels
 *
 * This tool resolves the **current session** root from `context.logUri`, walks it
 * for `*.log` files, and reads them. It is therefore scoped to the active session
 * (a window reload starts a new session directory).
 *
 * ## Modes
 *
 * - **List** (no `channel`): enumerate channels with tier, size and last-modified.
 * - **Read** (`channel` set): return that channel's content, with optional
 *   `search` (regex line filter), `severity` (min-level filter), `tail`/`offset`
 *   pagination, and a hard `limit` byte cap.
 *
 * Read-only meta-operation — belongs to the `read` tool group.
 */
export class ReadOutputChannelTool extends BaseTool<"read_output_channel"> {
	readonly name = "read_output_channel" as const

	async execute(params: ReadOutputChannelParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks
		const { channel, search, severity } = params

		// Validate severity early so a bad value fails fast with a clear message.
		let minSeverity: number | undefined
		if (severity !== undefined && severity !== null && `${severity}`.trim() !== "") {
			const key = `${severity}`.trim().toLowerCase()
			if (!(key in SEVERITY_RANK)) {
				task.consecutiveMistakeCount++
				task.recordToolError("read_output_channel")
				task.didToolFailInCurrentTurn = true
				const msg = `Invalid severity "${severity}". Expected one of: trace, debug, info, warning, error.`
				await task.say("error", msg)
				pushToolResult(`Error: ${msg}`)
				return
			}
			minSeverity = SEVERITY_RANK[key]
		}

		try {
			const sessionRoot = await this.resolveSessionRoot(task)
			if (!sessionRoot) {
				const msg =
					"Could not locate the VS Code logs directory for this session (context.logUri is unavailable — e.g. in a headless host). No output channels can be read."
				await task.say("error", msg)
				pushToolResult(`Error: ${msg}`)
				return
			}

			const channels = await this.discoverChannels(sessionRoot)

			const didApprove = await this.askToolApproval(callbacks, {
				tool: "readOutputChannel",
				content: channel
					? `Read output channel "${channel}"`
					: `List output channels (${channels.length} found)`,
			})
			if (!didApprove) return

			task.consecutiveMistakeCount = 0

			if (!channel || `${channel}`.trim() === "") {
				pushToolResult(this.formatChannelList(channels))
				return
			}

			const match = this.resolveChannel(channels, `${channel}`.trim())
			if (match.kind === "none") {
				const msg = `No output channel matching "${channel}" in the current session. Call read_output_channel with no channel to list available channels.`
				pushToolResult(msg)
				return
			}
			if (match.kind === "ambiguous") {
				const candidates = match.candidates.map((c) => `  • ${c.id} (${c.tier})`).join("\n")
				pushToolResult(`Multiple channels match "${channel}". Be more specific:\n${candidates}`)
				return
			}

			const content = await this.readChannel(match.channel, params, search, minSeverity)
			pushToolResult(content)
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			await task.say("error", `Error reading output channel: ${msg}`)
			task.didToolFailInCurrentTurn = true
			pushToolResult(`Error reading output channel: ${msg}`)
		}
	}

	/**
	 * Resolve the current session's logs root from `context.logUri`.
	 *
	 * `logUri` points at the extension's own log folder, e.g.
	 * `<logs>/<session>/window1/exthost/<publisher.ext>`. We climb until the
	 * parent directory is named `logs`, which makes the current directory the
	 * session root. Falls back to three-levels-up if the heuristic fails.
	 */
	private async resolveSessionRoot(task: Task): Promise<string | undefined> {
		const provider = await task.providerRef.deref()
		const logPath: string | undefined = provider?.context?.logUri?.fsPath
		if (!logPath) return undefined

		let dir = logPath
		for (let i = 0; i < 6; i++) {
			const parent = path.dirname(dir)
			if (path.basename(parent).toLowerCase() === "logs") return dir
			if (parent === dir) break
			dir = parent
		}
		// Fallback: <session>/window/exthost/<pub.ext> → up 3.
		const fallback = path.dirname(path.dirname(path.dirname(logPath)))
		try {
			await fs.access(fallback)
			return fallback
		} catch {
			return undefined
		}
	}

	/** Recursively walk the session root collecting every `*.log` file. */
	private async discoverChannels(sessionRoot: string): Promise<DiscoveredChannel[]> {
		const out: DiscoveredChannel[] = []

		const walk = async (dir: string): Promise<void> => {
			let entries: import("fs").Dirent[]
			try {
				entries = await fs.readdir(dir, { withFileTypes: true })
			} catch {
				return
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name)
				if (entry.isDirectory()) {
					await walk(full)
				} else if (entry.isFile() && entry.name.endsWith(".log")) {
					try {
						const stats = await fs.stat(full)
						out.push(this.classify(sessionRoot, full, stats.size, stats.mtimeMs))
					} catch {
						// Ignore files that vanish mid-walk.
					}
				}
			}
		}

		await walk(sessionRoot)
		out.sort((a, b) => a.tier.localeCompare(b.tier) || a.id.localeCompare(b.id))
		return out
	}

	/** Derive a channel's tier, owner and friendly id from its path. */
	private classify(sessionRoot: string, file: string, size: number, mtimeMs: number): DiscoveredChannel {
		const relPath = path.relative(sessionRoot, file)
		const segments = relPath.split(path.sep)
		const base = path.basename(file, ".log")

		let tier: ChannelTier
		let owner: string | undefined
		let id = base

		if (segments.length === 1) {
			tier = "core"
		} else if (segments.some((s) => s.startsWith("output_logging"))) {
			// Plain OutputChannel: filename is `<index>-<Channel Name>.log`.
			tier = "output"
			id = base.replace(/^\d+-/, "")
		} else {
			const exthostIdx = segments.indexOf("exthost")
			if (exthostIdx >= 0 && segments.length > exthostIdx + 1) {
				tier = "extension"
				owner = segments[exthostIdx + 1]
			} else {
				tier = "window"
			}
		}

		return { id, tier, owner, file, relPath, size, mtimeMs }
	}

	/** Resolve a user-supplied channel string to a single discovered channel. */
	private resolveChannel(
		channels: DiscoveredChannel[],
		query: string,
	):
		| { kind: "ok"; channel: DiscoveredChannel }
		| { kind: "ambiguous"; candidates: DiscoveredChannel[] }
		| { kind: "none" } {
		const q = query.toLowerCase()
		// Exact match on id, relative path, or backing filename.
		const exact = channels.filter(
			(c) =>
				c.id.toLowerCase() === q || c.relPath.toLowerCase() === q || path.basename(c.file).toLowerCase() === q,
		)
		if (exact.length === 1) return { kind: "ok", channel: exact[0] }
		if (exact.length > 1) return { kind: "ambiguous", candidates: exact }

		// Fall back to substring match on the friendly id.
		const partial = channels.filter((c) => c.id.toLowerCase().includes(q))
		if (partial.length === 1) return { kind: "ok", channel: partial[0] }
		if (partial.length > 1) return { kind: "ambiguous", candidates: partial }
		return { kind: "none" }
	}

	/** Render the list-mode output. */
	private formatChannelList(channels: DiscoveredChannel[]): string {
		if (channels.length === 0) {
			return "No output channels found for the current VS Code session."
		}
		const shown = channels.slice(0, MAX_LIST)
		const lines = shown.map((c) => {
			const owner = c.owner ? ` [${c.owner}]` : ""
			return `${c.id}\t(${c.tier}${owner}, ${this.formatBytes(c.size)})`
		})
		const header = [
			`Output channels in the current session (${channels.length}${
				channels.length > MAX_LIST ? `, showing first ${MAX_LIST}` : ""
			}):`,
			"Pass `channel` (the name before the tab) to read one. Tiers: core, window, extension, output (Output-panel channels).",
			"",
		]
		return header.concat(lines).join("\n")
	}

	/** Read a single channel's content honouring filters and pagination. */
	private async readChannel(
		channel: DiscoveredChannel,
		params: ReadOutputChannelParams,
		search: string | undefined,
		minSeverity: number | undefined,
	): Promise<string> {
		const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
		const tail = params.tail ?? true
		const stats = await fs.stat(channel.file)
		const totalSize = stats.size

		if (totalSize === 0) {
			return this.header(channel, totalSize, "empty") + "\n(channel log is empty)"
		}

		const filtering = (search !== undefined && search !== "") || minSeverity !== undefined
		if (filtering) {
			return this.scanFiltered(channel, totalSize, limit, tail, search, minSeverity)
		}

		// Plain read: explicit offset wins, else tail the most-recent bytes.
		let start: number
		if (params.offset !== undefined && params.offset !== null) {
			start = Math.max(0, Math.min(params.offset, Math.max(0, totalSize - 1)))
		} else if (tail) {
			start = Math.max(0, totalSize - limit)
		} else {
			start = 0
		}
		const length = Math.min(limit, totalSize - start)

		const fh = await fs.open(channel.file, "r")
		try {
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await fh.read(buffer, 0, length, start)
			const text = buffer.slice(0, bytesRead).toString("utf8")
			const end = start + bytesRead
			const truncated = end < totalSize || start > 0
			const range = `bytes ${start}-${end} of ${totalSize}${truncated ? " (TRUNCATED)" : " (COMPLETE)"}`
			return this.header(channel, totalSize, range) + "\n" + text
		} finally {
			await fh.close()
		}
	}

	/**
	 * Stream the file in chunks, keeping lines that pass the search/severity
	 * filters. Honours the byte `limit`: when `tail`, keeps the most-recent
	 * matches (a byte-bounded ring); otherwise keeps the first matches.
	 */
	private async scanFiltered(
		channel: DiscoveredChannel,
		totalSize: number,
		limit: number,
		tail: boolean,
		search: string | undefined,
		minSeverity: number | undefined,
	): Promise<string> {
		let regex: RegExp | undefined
		if (search !== undefined && search !== "") {
			try {
				regex = new RegExp(search, "i")
			} catch {
				regex = new RegExp(this.escapeRegExp(search), "i")
			}
		}

		const fh = await fs.open(channel.file, "r")
		const kept: Array<{ lineNumber: number; content: string }> = []
		let keptBytes = 0
		let lineNumber = 0
		let partial = ""
		let read = 0
		let lastLevel: number | undefined
		let truncatedFront = false
		let hitFrontLimit = false

		const consider = (line: string) => {
			lineNumber++
			// Severity: a line inherits the previous line's level (multi-line traces).
			if (minSeverity !== undefined) {
				const m = LEVEL_TOKEN.exec(line)
				if (m) lastLevel = SEVERITY_RANK[m[1].toLowerCase()]
				if (lastLevel === undefined || lastLevel < minSeverity) return
			}
			if (regex && !regex.test(line)) return

			const bytes = Buffer.byteLength(line, "utf8") + 1
			if (tail) {
				kept.push({ lineNumber, content: line })
				keptBytes += bytes
				while (keptBytes > limit && kept.length > 1) {
					keptBytes -= Buffer.byteLength(kept[0].content, "utf8") + 1
					kept.shift()
					truncatedFront = true
				}
			} else {
				if (keptBytes + bytes > limit) {
					hitFrontLimit = true
					return
				}
				kept.push({ lineNumber, content: line })
				keptBytes += bytes
			}
		}

		try {
			while (read < totalSize) {
				const size = Math.min(CHUNK_SIZE, totalSize - read)
				const buffer = Buffer.alloc(size)
				const { bytesRead } = await fh.read(buffer, 0, size, read)
				if (bytesRead === 0) break
				read += bytesRead
				const combined = partial + buffer.slice(0, bytesRead).toString("utf8")
				const lines = combined.split("\n")
				partial = lines.pop() ?? ""
				for (const line of lines) consider(line)
				if (!tail && hitFrontLimit) break
			}
			if (partial.length > 0 && !(!tail && hitFrontLimit)) consider(partial)
		} finally {
			await fh.close()
		}

		const filters = [
			search ? `search="${search}"` : undefined,
			minSeverity !== undefined ? `severity≥${this.severityName(minSeverity)}` : undefined,
		]
			.filter(Boolean)
			.join(", ")

		if (kept.length === 0) {
			return this.header(channel, totalSize, `0 matches (${filters})`) + "\nNo matching lines."
		}

		const truncated = truncatedFront || hitFrontLimit
		const note = `${kept.length} matching line(s) (${filters})${
			truncated ? `, ${tail ? "older" : "newer"} matches omitted by limit` : ""
		}`
		const width = String(kept[kept.length - 1].lineNumber).length
		const body = kept.map((m) => `${String(m.lineNumber).padStart(width)} | ${m.content}`).join("\n")
		return this.header(channel, totalSize, note) + "\n" + body
	}

	private header(channel: DiscoveredChannel, totalSize: number, info: string): string {
		const owner = channel.owner ? ` [${channel.owner}]` : ""
		return [
			`[Output channel: ${channel.id}] (${channel.tier}${owner})`,
			`Size: ${this.formatBytes(totalSize)} | ${info}`,
		].join("\n")
	}

	private severityName(rank: number): string {
		return Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] === rank && k !== "warn") ?? String(rank)
	}

	private formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} bytes`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
	}

	private escapeRegExp(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	}
}

/** Singleton instance of the ReadOutputChannelTool. */
export const readOutputChannelTool = new ReadOutputChannelTool()
