/**
 * @fileoverview Main entry point for the Shofer logging system.
 *
 * ## Architecture
 *
 *   `CompactTransport` (singleton) → Output Channel + optional JSON file
 *          ↑
 *   `logger` (root CompactLogger, shared transport)
 *          ↑
 *   subsystem loggers via `logger.child({ ctx: "SubsystemName" })`
 *
 * ## Lifecycle
 *
 * 1. During extension activation, `bootstrapLogging(channel)` is called to
 *    wire the VS Code Output Channel into the shared transport.
 * 2. Subsystems import `logger` and create scoped loggers via `.child()`.
 * 3. The minimum log level can be changed at runtime via `logger.setLevel()`,
 *    controlled by Settings → Logging.
 */

import type * as vscode from "vscode"
import { CompactLogger } from "./CompactLogger"
import { CompactTransport } from "./CompactTransport"
import type { ILogger, LogLevel } from "./types"

/** Shared transport — all loggers write through this single instance. */
let _transport: CompactTransport | undefined

/** Root logger instance. Created eagerly in test; in production it is created
 *  during `bootstrapLogging()` once the Output Channel is available. */
let _logger: CompactLogger | undefined

/**
 * Wire the VS Code Output Channel into the shared logging transport and
 * return the root logger.  Must be called once during extension activation
 * before any module-level code logs.
 *
 * In test environments (`NODE_ENV === "test"`) a silent noop logger is
 * returned instead so test output is not flooded.
 */
export function bootstrapLogging(outputChannel: vscode.OutputChannel): ILogger {
	if (process.env.NODE_ENV === "test") {
		return _noopLogger
	}

	const transport = new CompactTransport(outputChannel, { level: "debug" })
	_transport = transport
	_logger = new CompactLogger(transport)
	return _logger
}

/**
 * The root logger instance.  In production this is only available after
 * `bootstrapLogging()` has been called.  Before that (or in tests), a
 * noop logger is returned.
 *
 * Subsystems should NOT use this directly.  Instead, create a scoped child:
 *   const log = logger.child({ ctx: "MySubsystem" })
 */
const _noopLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	fatal: () => {},
	child: () => _noopLogger,
	setLevel: () => {},
	close: () => {},
}

/**
 * Root logger.  Returns the active logger or a noop fallback.
 *
 * Use `logger.child({ ctx: "MySubsystem" })` to create a subsystem-scoped
 * logger that tags every line with a context identifier.
 */
export function getLogger(): ILogger {
	return _logger ?? _noopLogger
}

/**
 * Convenience: the root logger instance.
 *
 * **Prefer `getLogger().child({ ctx: "MySubsystem" })` in new code.**
 *
 * Direct use is acceptable in code that can't easily create a subsystem
 * logger (e.g. utility modules without a clear ownership).
 */
export const logger: ILogger = new Proxy({} as ILogger, {
	get(_target, prop) {
		return (_logger ?? _noopLogger)[prop as keyof ILogger]
	},
})

/**
 * Set the minimum log level on the shared transport at runtime.
 * Silently swallowed if the transport hasn't been bootstrapped yet.
 */
export function setLogLevel(level: LogLevel): void {
	_transport?.setLevel(level)
}

/**
 * Set the set of allowed context identifiers (whitelist).
 * When `undefined`, all categories are shown.
 * @param categories - Array of ctx strings, or undefined for all
 */
export function setLogCategories(categories: string[] | undefined): void {
	_transport?.setCategories(categories)
}

/**
 * Get the current minimum log level.  Returns `"debug"` before bootstrap.
 */
/**
 * Get the set of all ctx values seen by the transport since bootstrap.
 * Used by the Settings UI to auto-populate category checkboxes.
 */
export function getLogKnownCategories(): string[] {
	return _transport?.getKnownCategories() ?? []
}

export function getLogLevel(): LogLevel {
	return _transport ? ((_transport as any)._level ?? "debug") : "debug"
}
