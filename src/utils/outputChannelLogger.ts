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
