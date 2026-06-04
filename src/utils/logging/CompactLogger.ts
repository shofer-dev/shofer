/**
 * @fileoverview CompactLogger — implementation of `ILogger`.
 *
 * Each logger instance writes through a shared `CompactTransport` (or a
 * custom one for testing).  Log level can be set per-logger at runtime
 * via `setLevel()`.
 *
 * All log methods accept variadic arguments mirroring `console.*` / the
 * old `outputLog` API.  Extra args are JSON-stringified and appended to
 * the message (capped at 8 KB per arg to prevent large-object allocation).
 */

import { ILogger, LogMeta, CompactLogEntry, LogLevel } from "./types"
import { CompactTransport } from "./CompactTransport"

const MAX_ARG_BYTES = 8 * 1024

/** Format a single extra argument into a string suitable for log output. */
function fmtArg(arg: unknown): string {
	if (arg === null) return "null"
	if (arg === undefined) return "undefined"
	if (typeof arg === "string") return arg
	if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ""}`
	try {
		const s = JSON.stringify(
			arg,
			(_k, v) => {
				if (typeof v === "bigint") return `BigInt(${v})`
				if (typeof v === "function") return `Function: ${(v as { name?: string }).name || "anonymous"}`
				if (typeof v === "symbol") return (v as symbol).toString()
				return v
			},
			2,
		)
		if (s.length <= MAX_ARG_BYTES) return s
		return `${s.slice(0, MAX_ARG_BYTES)}…[+${s.length - MAX_ARG_BYTES} more bytes]`
	} catch {
		return `[Non-serializable: ${Object.prototype.toString.call(arg)}]`
	}
}

/**
 * Main logger implementation providing compact, efficient logging capabilities.
 * @implements {ILogger}
 */
export class CompactLogger implements ILogger {
	private transport: CompactTransport
	private parentMeta: LogMeta | undefined

	constructor(transport?: CompactTransport, parentMeta?: LogMeta) {
		this.transport = transport ?? new CompactTransport()
		this.parentMeta = parentMeta
	}

	/** @inheritdoc */
	debug(message: string, ...extra: unknown[]): void {
		this.log("debug", this.fmtMessage(message, extra))
	}

	/** @inheritdoc */
	info(message: string, ...extra: unknown[]): void {
		this.log("info", this.fmtMessage(message, extra))
	}

	/** @inheritdoc */
	warn(message: string, ...extra: unknown[]): void {
		this.log("warn", this.fmtMessage(message, extra))
	}

	/** @inheritdoc */
	error(message: string | Error, ...extra: unknown[]): void {
		if (message instanceof Error) {
			this.log("error", message.message, {
				error: { name: message.name, message: message.message, stack: message.stack },
				...(extra.length ? { extra: extra.map(fmtArg).join(" ") } : {}),
			})
		} else {
			this.log("error", this.fmtMessage(message, extra))
		}
	}

	/** @inheritdoc */
	fatal(message: string | Error, ...extra: unknown[]): void {
		if (message instanceof Error) {
			this.log("fatal", message.message, {
				error: { name: message.name, message: message.message, stack: message.stack },
				...(extra.length ? { extra: extra.map(fmtArg).join(" ") } : {}),
			})
		} else {
			this.log("fatal", this.fmtMessage(message, extra))
		}
	}

	/** @inheritdoc */
	child(meta: LogMeta): ILogger {
		const combinedMeta = this.parentMeta ? { ...this.parentMeta, ...meta } : meta
		// Register the ctx eagerly so the subsystem shows up in the Settings
		// category list as soon as the logger is declared, not only after it
		// has emitted its first line (see CompactTransport.registerCategory).
		if (combinedMeta.ctx !== undefined) {
			this.transport.registerCategory(combinedMeta.ctx)
		}
		return new CompactLogger(this.transport, combinedMeta)
	}

	/** @inheritdoc */
	setLevel(level: LogLevel): void {
		this.transport.setLevel(level)
	}

	/** @inheritdoc */
	close(): void {
		this.transport.close()
	}

	/**
	 * Format a message and its extra arguments into a single string.
	 * Extra args are formatted and appended after the message, space-separated.
	 */
	private fmtMessage(message: string, extra: unknown[]): string {
		if (extra.length === 0) return message
		return message + " " + extra.map(fmtArg).join(" ")
	}

	/**
	 * Core logging function that processes and writes log entries.
	 */
	private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
		const entry: CompactLogEntry = {
			t: Date.now(),
			l: level,
			m: message,
			c: this.parentMeta?.ctx,
			d: data && Object.keys(data).length > 0 ? data : undefined,
		}

		this.transport.write(entry)
	}
}
