import * as vscode from "vscode"

export type LogFunction = (...args: unknown[]) => void

/**
 * Maximum bytes any single non-string argument is allowed to occupy in the
 * output channel once it has been serialised via `JSON.stringify`. §4.9 of
 * docs/mem-utilization-profiling.md flagged that a single accidental
 * `outputChannel.appendLine(JSON.stringify(largeObject))` in a hot path is
 * itself a `large_object`-space allocation. Centralising the cap here
 * protects every caller (and every future caller) of `createOutputChannelLogger`
 * without per-site changes.
 *
 * Inlined `${JSON.stringify(...)}` calls in template literals bypass this
 * cap because they pre-stringify before the logger sees a single string —
 * those sites have to be size-capped at the call site (see
 * `stringifyForLog` below).
 */
const MAX_LOG_ARG_BYTES = 8 * 1024

/**
 * JSON.stringify a value with a hard byte cap suitable for log lines.
 * Returns the serialised string truncated with a "[+N more bytes]" suffix
 * when it exceeds `maxBytes`. Failures are rendered as a stable sentinel
 * rather than thrown.
 *
 * Use this in template literals (e.g. `${stringifyForLog(input)}`) where
 * the data is not under our control and could be arbitrarily large
 * (LLM tool inputs, MCP responses, custom-tool return values, ...).
 */
export function stringifyForLog(value: unknown, maxBytes: number = MAX_LOG_ARG_BYTES): string {
	let serialised: string
	try {
		serialised = JSON.stringify(value) ?? "undefined"
	} catch {
		return `[Non-serializable: ${Object.prototype.toString.call(value)}]`
	}
	if (serialised.length <= maxBytes) return serialised
	const extra = serialised.length - maxBytes
	return `${serialised.slice(0, maxBytes)}…[+${extra} more bytes]`
}

/**
 * Creates a logging function that writes to a VSCode output channel
 * Based on the outputChannelLog implementation from src/extension/api.ts
 */
export function createOutputChannelLogger(outputChannel: vscode.OutputChannel): LogFunction {
	return (...args: unknown[]) => {
		for (const arg of args) {
			if (arg === null) {
				outputChannel.appendLine("null")
			} else if (arg === undefined) {
				outputChannel.appendLine("undefined")
			} else if (typeof arg === "string") {
				outputChannel.appendLine(arg)
			} else if (arg instanceof Error) {
				outputChannel.appendLine(`Error: ${arg.message}\n${arg.stack || ""}`)
			} else {
				try {
					const serialised = JSON.stringify(
						arg,
						(key, value) => {
							if (typeof value === "bigint") return `BigInt(${value})`
							if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
							if (typeof value === "symbol") return value.toString()
							return value
						},
						2,
					)
					// §4.9: cap the per-arg output so a single misuse can't
					// allocate a multi-MB string in the `large_object` space.
					if (serialised.length <= MAX_LOG_ARG_BYTES) {
						outputChannel.appendLine(serialised)
					} else {
						const extra = serialised.length - MAX_LOG_ARG_BYTES
						outputChannel.appendLine(`${serialised.slice(0, MAX_LOG_ARG_BYTES)}…[+${extra} more bytes]`)
					}
				} catch (error) {
					outputChannel.appendLine(`[Non-serializable object: ${Object.prototype.toString.call(arg)}]`)
				}
			}
		}
	}
}

/**
 * Creates a logging function that logs to both the output channel and console
 * Following the pattern from src/extension/api.ts
 */
export function createDualLogger(outputChannelLog: LogFunction): LogFunction {
	return (...args: unknown[]) => {
		outputChannelLog(...args)
		console.log(...args)
	}
}

// ---------------------------------------------------------------------------
// Global extension-host logger
//
// Utility modules that don't have a provider instance (safeWriteJson, git,
// API providers, services, …) use these functions instead of console.*.
// Call setExtensionOutputChannel() once during activation; until then every
// call falls back to the matching console.* so messages are never silently
// dropped in tests or during early boot.
// ---------------------------------------------------------------------------

let _globalChannel: vscode.OutputChannel | undefined

/**
 * Register the shared output channel produced by extension.ts activate().
 * Must be called before any module-level code uses outputLog/Warn/Error.
 */
export function setExtensionOutputChannel(channel: vscode.OutputChannel): void {
	_globalChannel = channel
}

/** Serialise a heterogeneous list of log arguments to a single string. */
function _fmtArgs(args: unknown[]): string {
	return args
		.map((arg) => {
			if (arg === null) return "null"
			if (arg === undefined) return "undefined"
			if (typeof arg === "string") return arg
			if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ""}`
			try {
				return JSON.stringify(
					arg,
					(_, value) => {
						if (typeof value === "bigint") return `BigInt(${value})`
						if (typeof value === "function")
							return `Function: ${(value as { name?: string }).name || "anonymous"}`
						if (typeof value === "symbol") return (value as symbol).toString()
						return value
					},
					2,
				)
			} catch {
				return `[Non-serializable: ${Object.prototype.toString.call(arg)}]`
			}
		})
		.join(" ")
}

/** Write an informational message to the extension output channel. */
export function outputLog(...args: unknown[]): void {
	const line = _fmtArgs(args)
	if (_globalChannel) {
		_globalChannel.appendLine(line)
	} else {
		console.log(...args)
	}
}

/** Write a warning message (prefixed [WARN]) to the extension output channel. */
export function outputWarn(...args: unknown[]): void {
	const line = `[WARN] ${_fmtArgs(args)}`
	if (_globalChannel) {
		_globalChannel.appendLine(line)
	} else {
		console.warn(...args)
	}
}

/** Write an error message (prefixed [ERROR]) to the extension output channel. */
export function outputError(...args: unknown[]): void {
	const line = `[ERROR] ${_fmtArgs(args)}`
	if (_globalChannel) {
		_globalChannel.appendLine(line)
	} else {
		console.error(...args)
	}
}
