/**
 * tool-executor — the read-only catalog a detector fork may reach, plus the exec
 * allowlist.
 *
 * Two-layer enforcement, same as the reference design: the wire-level tool list is the
 * union of every ENABLED detector's grant (tools lead the provider cache key, so it must
 * be stable across passes), and dispatch re-checks every call against the CALLING
 * detector's own grant — a model can name a tool it was never offered, so the executor
 * refuses anything outside the caller's list rather than trusting the request it
 * built. `execute_command` runs ONLY exact strings from the calling detector's
 * catalogue allowlist, time-boxed, in the workspace root; there is no host exec seam,
 * so the runner uses child_process directly (live-memory's runGit precedent) — the
 * exact-string allowlist is the control.
 */

import { execFile } from "node:child_process"
import type { PluginContext } from "@shofer/types"

import { MAX_TOOL_OUTPUT_CHARS, type DetectorDef } from "./types.js"
import type { ToolDefinition } from "./llm.js"

/** Wall-clock box on one allowlisted command. */
const EXEC_TIMEOUT_MS = 30_000
/** Result cap for search/list tools before the model sees them. */
const MAX_MATCHES = 50

function capOut(s: string): string {
	if (s.length <= MAX_TOOL_OUTPUT_CHARS) return s
	return `${s.slice(0, MAX_TOOL_OUTPUT_CHARS)}…[+${s.length - MAX_TOOL_OUTPUT_CHARS} chars]`
}

/** JSON-schema for each catalog tool (wire definitions — {@link passToolUnion} selects these). */
export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
	read_file: {
		type: "function",
		function: {
			name: "read_file",
			description: "Read a workspace file (read-only).",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "Workspace-relative path" } },
				required: ["path"],
			},
		},
	},
	grep_search: {
		type: "function",
		function: {
			name: "grep_search",
			description: "Regex search across workspace files (read-only).",
			parameters: {
				type: "object",
				properties: {
					pattern: { type: "string" },
					glob: { type: "string", description: "Optional file glob to limit the search" },
				},
				required: ["pattern"],
			},
		},
	},
	list_files: {
		type: "function",
		function: {
			name: "list_files",
			description: "List files under a workspace directory (read-only).",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "Workspace-relative directory, default ." } },
			},
		},
	},
	find_files: {
		type: "function",
		function: {
			name: "find_files",
			description: "Glob for files by name pattern (read-only).",
			parameters: {
				type: "object",
				properties: { pattern: { type: "string" } },
				required: ["pattern"],
			},
		},
	},
	rag_search: {
		type: "function",
		function: {
			name: "rag_search",
			description: "Semantic code search over the workspace index, when configured.",
			parameters: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
		},
	},
	git_search: {
		type: "function",
		function: {
			name: "git_search",
			description: "Search git history, when configured.",
			parameters: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
		},
	},
	execute_command: {
		type: "function",
		function: {
			name: "execute_command",
			description:
				"Run ONE command from your exact allowlist (listed in your instructions). Any other string is refused.",
			parameters: {
				type: "object",
				properties: { command: { type: "string", description: "An exact allowlisted string" } },
				required: ["command"],
			},
		},
	},
}

/**
 * The wire tools array: the union of the given detectors' grants, sorted by name.
 *
 * Callers pass every ENABLED detector, not the cadence-filtered set running this pass —
 * tools lead the provider's cache key, so a list that oscillated with the running set
 * would invalidate the shared prefix on alternating passes. Offering a tool costs
 * nothing: {@link ForkToolExecutor.execute} re-checks every call against the calling
 * detector's own grant.
 */
export function passToolUnion(defs: DetectorDef[]): ToolDefinition[] {
	const names = new Set<string>()
	for (const d of defs) for (const t of d.tools) names.add(t)
	return [...names]
		.sort()
		.map((n) => TOOL_DEFINITIONS[n])
		.filter((d): d is ToolDefinition => !!d)
}

/** The dispatch surface forks depend on — an interface so tests can script it. */
export interface ToolDispatcher {
	execute(detector: DetectorDef, name: string, argsRaw: string): Promise<{ content: string; isError: boolean }>
}

export class ForkToolExecutor implements ToolDispatcher {
	constructor(
		private readonly ctx: PluginContext,
		private readonly cwd: string | undefined,
	) {}

	/**
	 * Dispatch one call for `detector`. The grant re-check happens HERE, per call,
	 * against the calling detector — not against the wire list.
	 */
	async execute(
		detector: DetectorDef,
		name: string,
		argsRaw: string,
	): Promise<{ content: string; isError: boolean }> {
		if (!detector.tools.includes(name)) {
			return { content: `Tool "${name}" is not in this detector's grant.`, isError: true }
		}
		let args: Record<string, unknown>
		try {
			args = argsRaw ? (JSON.parse(argsRaw) as Record<string, unknown>) : {}
		} catch {
			return { content: "Invalid tool arguments (not JSON).", isError: true }
		}

		try {
			switch (name) {
				case "read_file": {
					const path = String(args.path ?? "")
					if (!path) return { content: "read_file needs a path.", isError: true }
					const content = await this.fs().readFile(path)
					return { content: capOut(content), isError: false }
				}
				case "grep_search":
					return await this.grep(String(args.pattern ?? ""), args.glob ? String(args.glob) : undefined)
				case "list_files":
				case "find_files": {
					const pattern =
						name === "find_files"
							? String(args.pattern ?? "**/*")
							: `${String(args.path ?? ".").replace(/\/+$/, "")}/**/*`
					const files = await this.fs().findFiles(pattern, { cwd: this.cwd ?? ".", maxResults: MAX_MATCHES })
					return { content: capOut(files.join("\n") || "(no matches)"), isError: false }
				}
				case "rag_search": {
					const search = this.ctx.host?.search
					if (!search) return { content: "rag_search unavailable (no search seam).", isError: true }
					const hits = await search.ragSearch(String(args.query ?? ""))
					return { content: capOut(JSON.stringify(hits.slice(0, 10), null, 1)), isError: false }
				}
				case "git_search": {
					const search = this.ctx.host?.search
					if (!search) return { content: "git_search unavailable (no search seam).", isError: true }
					const hits = await search.gitSearch(String(args.query ?? ""))
					return { content: capOut(JSON.stringify(hits.slice(0, 10), null, 1)), isError: false }
				}
				case "execute_command":
					return await this.exec(detector, String(args.command ?? ""))
				default:
					return { content: `Unknown tool "${name}".`, isError: true }
			}
		} catch (error) {
			return {
				content: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			}
		}
	}

	private fs() {
		const fs = this.ctx.host?.fs
		if (!fs) throw new Error("host fs unavailable")
		return fs
	}

	/** Grep via findFiles + readFile — bounded, read-only, no shell involved. */
	private async grep(pattern: string, glob: string | undefined): Promise<{ content: string; isError: boolean }> {
		if (!pattern) return { content: "grep_search needs a pattern.", isError: true }
		let regex: RegExp
		try {
			regex = new RegExp(pattern)
		} catch {
			return { content: "Invalid regex.", isError: true }
		}
		const files = await this.fs().findFiles(glob ?? "**/*", { cwd: this.cwd ?? ".", maxResults: 400 })
		const lines: string[] = []
		for (const file of files) {
			if (lines.length >= MAX_MATCHES) break
			let content: string
			try {
				content = await this.fs().readFile(file)
			} catch {
				continue
			}
			const fileLines = content.split("\n")
			for (let i = 0; i < fileLines.length && lines.length < MAX_MATCHES; i++) {
				if (regex.test(fileLines[i]!)) lines.push(`${file}:${i + 1}: ${fileLines[i]!.slice(0, 200)}`)
			}
		}
		return { content: capOut(lines.join("\n") || "(no matches)"), isError: false }
	}

	/** Run an EXACT allowlisted string, time-boxed, via sh -c in the workspace root. */
	private async exec(detector: DetectorDef, command: string): Promise<{ content: string; isError: boolean }> {
		if (!detector.exec.includes(command)) {
			return {
				content: `Command not in this detector's allowlist. Allowed: ${detector.exec.join(" | ") || "(none)"}`,
				isError: true,
			}
		}
		return new Promise((resolve) => {
			execFile(
				"/bin/sh",
				["-c", command],
				{ cwd: this.cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
				(error, stdout, stderr) => {
					const out = capOut([stdout, stderr].filter(Boolean).join("\n"))
					resolve({ content: out || (error ? String(error) : "(no output)"), isError: !!error })
				},
			)
		})
	}
}
