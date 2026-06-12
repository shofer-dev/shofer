/**
 * @fileoverview Compact transport implementation.
 *
 * Writes human-readable lines to a `vscode.OutputChannel` (the "Shofer"
 * output panel) and optionally appends compact JSON-lines to a file on
 * disk.  The minimum log level is mutable at runtime via `setLevel()`.
 */

import { writeFileSync, mkdirSync } from "fs"
import { dirname } from "path"
import type * as vscode from "vscode"
import {
	CompactTransportConfig,
	ICompactTransport,
	CompactLogEntry,
	LogLevel,
	LOG_LEVELS,
	TaskScopedLogLine,
	TaskLogListener,
} from "./types"
import { getLogTaskContext } from "./logContext"

/**
 * Default configuration: Output Channel only (no file output), all levels
 * enabled.
 */
const DEFAULT_CONFIG: CompactTransportConfig = {
	level: "debug",
}

/**
 * Determines if a log entry should be processed based on configured minimum level.
 */
function isLevelEnabled(configLevel: LogLevel, entryLevel: string): boolean {
	const configIdx = LOG_LEVELS.indexOf(configLevel)
	const entryIdx = LOG_LEVELS.indexOf(entryLevel as LogLevel)
	return entryIdx >= configIdx
}

/**
 * Format a `CompactLogEntry` as a human-readable line for the Output Channel.
 *
 * Format: `[HH:MM:SS.mmm] [LEVEL] [ctx] message`
 */
function formatHumanLine(entry: CompactLogEntry): string {
	const ts = new Date(entry.t).toISOString().replace("T", " ").replace("Z", "")
	const level = entry.l.toUpperCase().padEnd(5)
	const ctx = entry.c ? `[${entry.c}] ` : ""
	const data = entry.d !== undefined ? ` ${JSON.stringify(entry.d)}` : ""
	return `${ts} ${level} ${ctx}${entry.m}${data}`
}

/** Maximum number of recent human-readable log lines kept in memory. */
const RING_BUFFER_CAPACITY = 5000

/** Maximum number of log lines retained per task in the per-task buffers. */
const TASK_RING_CAPACITY = 2000

/**
 * Maximum number of distinct tasks whose log buffers are retained at once.
 * Bounds memory when many tasks run over a session; the oldest task buffer is
 * evicted when a new task exceeds this cap. Explicit `clearTaskLogs()` on task
 * disposal keeps this from being hit in normal use.
 */
const MAX_TASK_BUFFERS = 64

/**
 * Implements the compact logging transport using VS Code Output Channel.
 * @implements {ICompactTransport}
 */
/** All known subsystem context identifiers. */
export class CompactTransport implements ICompactTransport {
	private sessionStart: number
	private lastTimestamp: number
	private filePath?: string
	private initialized: boolean = false
	private _level: LogLevel
	private _categories: string[] | undefined
	private _knownCategories: Set<string> = new Set()
	private _outputChannel: vscode.OutputChannel | undefined
	/** Ring buffer of recent human-readable log lines for the public API. */
	private _ringBuffer: string[] = []
	private _ringBufferIndex = 0
	/**
	 * Per-task log buffers keyed by task id, populated from the ambient log
	 * context (see `logContext.ts`). Map insertion order is used for eviction.
	 */
	private _taskBuffers: Map<string, TaskScopedLogLine[]> = new Map()
	/** Listeners notified for every task-attributed line (live streaming). */
	private _taskLogListeners: Set<TaskLogListener> = new Set()

	/**
	 * Creates a new CompactTransport instance.
	 *
	 * @param outputChannel - The VS Code Output Channel to write to (optional;
	 *   can be set later via `setOutputChannel()`).
	 * @param config - Optional transport configuration.
	 */
	constructor(outputChannel?: vscode.OutputChannel, config: CompactTransportConfig = {}) {
		this.sessionStart = Date.now()
		this.lastTimestamp = this.sessionStart
		this._level = config.level ?? "debug"
		this._categories = undefined // undefined = show all
		this._outputChannel = outputChannel

		if (config.fileOutput?.enabled) {
			this.filePath = config.fileOutput.path
		}

		// Write session start marker
		this.writeHumanLine(`Log session started (level: ${this._level})`)
	}

	/**
	 * Set or replace the Output Channel at runtime.
	 * Useful when the channel is created during extension activation.
	 */
	setOutputChannel(channel: vscode.OutputChannel): void {
		this._outputChannel = channel
	}

	/**
	 * Update the minimum log level at runtime.
	 * Entries below this level are silently dropped.
	 */
	setLevel(level: LogLevel): void {
		this._level = level
	}

	/**
	 * Return the current minimum log level.
	 */
	getLevel(): LogLevel {
		return this._level
	}

	/**
	 * Set the set of allowed context identifiers (whitelist).
	 * When `undefined` (default), all categories are shown.
	 * When an array, only entries whose `c` matches one of the
	 * strings in the array are written.
	 */
	setCategories(categories: string[] | undefined): void {
		this._categories = categories
		if (categories && categories.length > 0) {
			this.writeHumanLine(`Log categories filtered to: ${categories.join(", ")}`)
		} else {
			this.writeHumanLine("Log categories: all")
		}
	}

	/**
	 * Write a human-readable line directly to the output channel.
	 * Bypasses level filtering — use for session markers, etc.
	 */
	writeHumanLine(line: string): void {
		if (this._outputChannel) {
			this._outputChannel.appendLine(line)
		}
	}

	/**
	 * Ensure the log file is initialized with the session start marker.
	 * @private
	 * @throws {Error} If file initialization fails
	 */
	private ensureInitialized(): void {
		if (this.initialized || !this.filePath) return

		try {
			mkdirSync(dirname(this.filePath), { recursive: true })
			writeFileSync(this.filePath, "", { flag: "w" })

			const sessionStart = {
				t: 0,
				l: "info",
				m: "Log session started",
				d: { timestamp: new Date(this.sessionStart).toISOString() },
			}
			writeFileSync(this.filePath, JSON.stringify(sessionStart) + "\n", { flag: "w" })

			this.initialized = true
		} catch (err) {
			throw new Error(`Failed to initialize log file: ${(err as Error).message}`)
		}
	}

	/**
	 * Writes a log entry to configured outputs.
	 * @param entry - The log entry to write
	 */
	/**
	 * Return the set of all ctx values seen by this transport.
	 * Used by the Settings UI to auto-populate category checkboxes.
	 */
	getKnownCategories(): string[] {
		return [...this._knownCategories].sort()
	}

	/**
	 * Register a category (ctx) as known without emitting a log line.
	 *
	 * Called when a subsystem child logger is *created* so the category
	 * appears in the Settings UI immediately, rather than only after the
	 * subsystem has emitted its first line. Without this, the category
	 * whitelist would be incomplete and unstable (categories popping in as
	 * code paths happen to execute).
	 */
	registerCategory(ctx: string): void {
		this._knownCategories.add(ctx)
	}

	write(entry: CompactLogEntry): void {
		// Auto-discover categories: any entry with a ctx we haven't seen
		// before is added to the known set
		if (entry.c !== undefined) {
			this._knownCategories.add(entry.c)
		}

		// Level filtering
		if (!isLevelEnabled(this._level, entry.l)) {
			return
		}

		// Category filtering (whitelist)
		if (this._categories !== undefined) {
			// Allow entries WITHOUT a ctx (no ctx = not from a subsystem filter)
			// AND entries whose ctx is in the whitelist
			if (entry.c !== undefined && !this._categories.includes(entry.c)) {
				return
			}
		}

		// Human-readable output channel line
		const humanLine = formatHumanLine(entry)
		if (this._outputChannel) {
			this._outputChannel.appendLine(humanLine)
		}

		// Ring buffer for public API log access (headless/CLI consumers).
		if (this._ringBuffer.length < RING_BUFFER_CAPACITY) {
			this._ringBuffer.push(humanLine)
		} else {
			this._ringBuffer[this._ringBufferIndex % RING_BUFFER_CAPACITY] = humanLine
			this._ringBufferIndex++
		}

		// Per-task buffering: attribute this line to the task whose run loop is
		// currently on the async call stack (if any) so the webview "Logs" tab can
		// show logs scoped to a single task/workflow.
		this.captureForTask(entry)

		// Optional JSON-lines file output (compact, delta-timestamps)
		if (this.filePath) {
			const deltaT = entry.t - this.lastTimestamp
			this.lastTimestamp = entry.t

			const compact = {
				t: deltaT,
				l: entry.l,
				m: entry.m,
				c: entry.c,
				d: entry.d,
			}
			const output = JSON.stringify(compact) + "\n"

			this.ensureInitialized()
			writeFileSync(this.filePath, output, { flag: "a" })
		}
	}

	/**
	 * Return the most recent human-readable log lines from the in-memory ring
	 * buffer. This gives headless/CLI consumers access to the same log output
	 * that appears in the VSCode Output Channel panel.
	 *
	 * @param maxLines Maximum number of lines to return (default: 2000).
	 * @returns Newline-joined log lines, most recent last.
	 */
	getRecentLogs(maxLines: number = 2000): string {
		const buf = this._ringBuffer
		if (buf.length <= RING_BUFFER_CAPACITY) {
			// Buffer hasn't wrapped yet — straightforward slice.
			return buf.slice(-maxLines).join("\n")
		}
		// Buffer has wrapped — reconstruct in order.
		const start = this._ringBufferIndex % RING_BUFFER_CAPACITY
		const ordered = [...buf.slice(start), ...buf.slice(0, start)]
		return ordered.slice(-maxLines).join("\n")
	}

	/**
	 * Append a log entry to the per-task buffer for the task that owns the
	 * current async context, and notify the live listener. No-op when no task
	 * context is active (e.g. activation/idle logging).
	 */
	private captureForTask(entry: CompactLogEntry): void {
		const ctx = getLogTaskContext()
		if (!ctx) return

		const line: TaskScopedLogLine = {
			ts: entry.t,
			level: entry.l,
			ctx: entry.c,
			message: entry.d !== undefined ? `${entry.m} ${JSON.stringify(entry.d)}` : entry.m,
		}

		let buf = this._taskBuffers.get(ctx.taskId)
		if (!buf) {
			// Evict the oldest task buffer when at capacity (insertion-ordered Map).
			if (this._taskBuffers.size >= MAX_TASK_BUFFERS) {
				const oldest = this._taskBuffers.keys().next().value
				if (oldest !== undefined) this._taskBuffers.delete(oldest)
			}
			buf = []
			this._taskBuffers.set(ctx.taskId, buf)
		}

		buf.push(line)
		if (buf.length > TASK_RING_CAPACITY) {
			buf.splice(0, buf.length - TASK_RING_CAPACITY)
		}

		for (const listener of this._taskLogListeners) {
			listener(ctx.taskId, line)
		}
	}

	/** Return a snapshot of the buffered log lines for a task (oldest first). */
	getTaskLogs(taskId: string): TaskScopedLogLine[] {
		const buf = this._taskBuffers.get(taskId)
		return buf ? buf.slice() : []
	}

	/**
	 * Register a listener notified once per task-attributed log line. Used by the
	 * provider to stream new lines to the focused task's webview. Returns an
	 * unsubscribe function.
	 */
	addTaskLogListener(listener: TaskLogListener): () => void {
		this._taskLogListeners.add(listener)
		return () => this._taskLogListeners.delete(listener)
	}

	/** Drop the buffered logs for a task (call on task disposal). */
	clearTaskLogs(taskId: string): void {
		this._taskBuffers.delete(taskId)
	}

	/**
	 * Closes the transport and writes session end marker.
	 */
	close(): void {
		if (this._outputChannel) {
			this._outputChannel.appendLine(`Log session ended (${new Date().toISOString()})`)
		}

		if (this.filePath && this.initialized) {
			const sessionEnd = {
				t: Date.now() - this.lastTimestamp,
				l: "info",
				m: "Log session ended",
				d: { timestamp: new Date().toISOString() },
			}
			writeFileSync(this.filePath, JSON.stringify(sessionEnd) + "\n", { flag: "a" })
		}
	}
}
