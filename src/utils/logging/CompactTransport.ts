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
import { CompactTransportConfig, ICompactTransport, CompactLogEntry, LogLevel, LOG_LEVELS } from "./types"

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
		if (this._outputChannel) {
			this._outputChannel.appendLine(formatHumanLine(entry))
		}

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
