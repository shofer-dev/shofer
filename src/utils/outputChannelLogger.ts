import * as vscode from "vscode"

export type LogFunction = (...args: unknown[]) => void

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
					outputChannel.appendLine(
						JSON.stringify(
							arg,
							(key, value) => {
								if (typeof value === "bigint") return `BigInt(${value})`
								if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
								if (typeof value === "symbol") return value.toString()
								return value
							},
							2,
						),
					)
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
