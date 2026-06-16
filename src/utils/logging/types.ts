/**
 * @fileoverview Core type definitions for the compact logging system.
 *
 * The logger writes human-readable lines to a `vscode.OutputChannel` (the
 * "Shofer" output panel) and optional JSON-lines to a file on disk.
 *
 * Log levels (ascending severity): debug < info < warn < error < fatal.
 * At runtime the minimum level can be toggled via `setLevel()` — every
 * log call below that threshold is silently dropped by the transport.
 *
 * Each entry carries an optional `ctx` (context/source identifier) set
 * via `logger.child({ ctx: "GitIndex" })` so consumers can grep or
 * filter by subsystem.
 */

import type * as vscode from "vscode"

/**
 * Represents a compact log entry format optimized for storage and transmission.
 */
export interface CompactLogEntry {
	/** Delta timestamp from last entry in milliseconds */
	t: number
	/** Log level identifier */
	l: string
	/** Log message content */
	m: string
	/** Optional context identifier (subsystem / component name) */
	c?: string
	/** Optional structured data payload */
	d?: unknown
}

/**
 * A log line attributed to a specific task/workflow instance, accumulated in
 * the transport's per-task ring buffer and surfaced to the webview "Logs" tab.
 * Structurally identical to (and assignable to) `TaskLogLine` in `@shofer/types`.
 */
export interface TaskScopedLogLine {
	/** Absolute timestamp in ms. */
	ts: number
	/** Severity ("debug" | "info" | "warn" | "error" | "fatal"). */
	level: string
	/** Subsystem context tag, if any. */
	ctx?: string
	/** Human-readable message including any stringified data payload. */
	message: string
}

/** Listener invoked once per log line attributed to a task. */
export type TaskLogListener = (taskId: string, line: TaskScopedLogLine) => void

/** Available log levels in ascending order of severity. */
export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const
/** Type representing valid log levels. */
export type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * Metadata structure for log entries.
 * `ctx` is the canonical subsystem tag; extra keys become the `d` payload.
 */
export interface LogMeta {
	/** Optional context identifier (subsystem / component name). */
	ctx?: string
	/** Additional arbitrary metadata fields. */
	[key: string]: unknown
}

/**
 * Configuration options for CompactTransport.
 */
export interface CompactTransportConfig {
	/** Minimum log level to process. Defaults to `"debug"`. */
	level?: LogLevel
	/** Optional file output. When omitted or `enabled: false`, only the
	 *  Output Channel is used. */
	fileOutput?: {
		/** Whether file output is enabled. */
		enabled: boolean
		/** Path to the log file (relative to the workspace root or absolute). */
		path: string
	}
}

/**
 * Interface for log transport implementations.
 */
export interface ICompactTransport {
	/**
	 * Writes a log entry to the transport(s).
	 * @param entry - The log entry to write
	 */
	write(entry: CompactLogEntry): void

	/**
	 * Update the minimum log level at runtime.
	 * Entries below this level are silently dropped.
	 * @param level - New minimum level
	 */
	setLevel(level: LogLevel): void

	/**
	 * Set the set of allowed context identifiers (whitelist).
	 * When `undefined` (default), all categories are shown.
	 * When an array, only entries whose `c` (ctx) matches one of the
	 * strings in the array are written.
	 * @param categories - Array of ctx strings to allow, or undefined for all
	 */
	setCategories(categories: string[] | undefined): void

	/**
	 * Closes the transport and performs cleanup (writes session-end marker, etc.).
	 */
	close(): void
}

/**
 * Interface for logger implementations.
 */
export interface ILogger {
	/** Log a debug-level message. Extra args are stringified and appended. */
	debug(message: string, ...extra: unknown[]): void

	/** Log an info-level message. Extra args are stringified and appended. */
	info(message: string, ...extra: unknown[]): void

	/** Log a warning-level message. Extra args are stringified and appended. */
	warn(message: string, ...extra: unknown[]): void

	/** Log an error-level message. Accepts an `Error` object for stack capture. Extra args are stringified and appended. */
	error(message: string | Error, ...extra: unknown[]): void

	/** Log a fatal-level message. Accepts an `Error` object for stack capture. Extra args are stringified and appended. */
	fatal(message: string | Error, ...extra: unknown[]): void

	/**
	 * Creates a child logger with inherited metadata.
	 * Use this to tag all entries from a subsystem:
	 *   const log = logger.child({ ctx: "LiveMemory" })
	 * @param meta - Metadata to merge with parent's metadata
	 * @returns A new logger instance with combined metadata
	 */
	child(meta: LogMeta): ILogger

	/**
	 * Update the minimum log level accepted by this logger's transport.
	 * @param level - New minimum level
	 */
	setLevel(level: LogLevel): void

	/** Closes the logger and its transport. */
	close(): void
}
