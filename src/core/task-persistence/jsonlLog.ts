/**
 * jsonlLog.ts — Append-friendly JSONL persistence helpers.
 *
 * Per the §4.1 design in `docs/mem-utilization-profiling.md`, hot-path
 * persistence (ui_messages, api_conversation_history) is moved off a
 * "serialize-the-whole-array-on-every-mutation" model onto an append-only
 * JSONL log:
 *
 *   - `appendJsonLine`     — O(1) write of a single line. Used for new
 *                            messages and in-place updates (the latter rely
 *                            on the reader's dedupe-by-key to collapse
 *                            superseded versions).
 *   - `writeJsonLines`     — atomic full rewrite (tmp + rename). Used for
 *                            compactions (`overwrite*`, turn-boundary
 *                            flushes). Callers MUST build the serialized
 *                            string synchronously to capture an H6-style
 *                            snapshot that the async write cannot race.
 *   - `readJsonLines`      — line-by-line read, tolerates a truncated final
 *                            line (writer-crash mid-append). Returns `null`
 *                            when the file does not exist so callers can
 *                            distinguish "missing" from "empty".
 *
 * All write operations for a given file path are serialised through a
 * per-file in-process FIFO queue so appends and rewrites cannot interleave
 * (cross-process safety is not needed: task files are only ever written by
 * the extension host).
 */

import * as fs from "fs/promises"
import * as path from "path"

import { taskLog } from "../../utils/logging/subsystems"

// Per-file write queue. Each entry is the tail promise; new ops are chained
// onto it via `.then(..., ...)` so a rejected predecessor does not poison the
// chain (op runs whether the previous one resolved or rejected).
const writeQueues = new Map<string, Promise<void>>()

function enqueueWrite(filePath: string, op: () => Promise<void>): Promise<void> {
	const prev = writeQueues.get(filePath) ?? Promise.resolve()
	const next = prev.then(op, op)
	const cleanupAware = next.finally(() => {
		if (writeQueues.get(filePath) === cleanupAware) {
			writeQueues.delete(filePath)
		}
	})
	writeQueues.set(filePath, cleanupAware)
	return next
}

/**
 * Append a single JSONL record to `filePath`. The line is built synchronously
 * (before yielding) so the queued op writes a frozen string the caller cannot
 * mutate mid-flight.
 */
export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
	const line = JSON.stringify(value) + "\n"
	await enqueueWrite(filePath, async () => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.appendFile(filePath, line, "utf8")
	})
}

/**
 * Atomically replace `filePath` with `content` (must already be the full
 * JSONL payload, including the trailing newline on the last record).
 *
 * Writes to a sibling tmp file then renames, so a crash mid-write leaves
 * either the previous good file or the new good file — never a torn one.
 */
export async function writeJsonLines(filePath: string, content: string): Promise<void> {
	await enqueueWrite(filePath, async () => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
		await fs.writeFile(tmpPath, content, "utf8")
		await fs.rename(tmpPath, filePath)
	})
}

/**
 * Serialize an iterable of records into the JSONL byte form expected by
 * `writeJsonLines`. Each record gets a single trailing newline, so an empty
 * array produces an empty string (zero-byte file).
 *
 * Built synchronously so callers can capture an H6-style snapshot of the
 * in-memory array before awaiting any I/O.
 */
export function serializeJsonLines(records: readonly unknown[]): string {
	if (records.length === 0) return ""
	const chunks: string[] = new Array(records.length)
	for (let i = 0; i < records.length; i++) {
		chunks[i] = JSON.stringify(records[i])
	}
	return chunks.join("\n") + "\n"
}

/**
 * Read a JSONL file as an array of parsed records.
 *
 * - Returns `null` if the file does not exist (lets callers distinguish from
 *   "exists but empty", and trigger legacy-file cutover handling).
 * - Tolerates a truncated final line (writer crashed mid-`appendFile`): the
 *   bad tail is silently dropped.
 * - Logs and skips any other malformed lines but keeps reading.
 */
export async function readJsonLines<T>(filePath: string): Promise<T[] | null> {
	let content: string
	try {
		content = await fs.readFile(filePath, "utf8")
	} catch (e: any) {
		if (e && e.code === "ENOENT") return null
		throw e
	}
	if (content.length === 0) return []

	const lines = content.split("\n")
	// `content.split("\n")` produces an empty trailing element when the file
	// ends with "\n" (the normal case). That empty element is harmless — the
	// loop below skips it. A non-empty trailing element means the writer was
	// interrupted mid-append; we drop it.
	const result: T[] = []
	const lastIndex = lines.length - 1
	for (let i = 0; i <= lastIndex; i++) {
		const line = lines[i]
		if (!line) continue
		try {
			result.push(JSON.parse(line) as T)
		} catch (e) {
			if (i === lastIndex) {
				// Truncated final line from a crashed appendFile. Drop silently.
				continue
			}
			taskLog.warn(
				`[readJsonLines] skipping malformed line ${i + 1} in ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
			)
		}
	}
	return result
}

/**
 * Dedupe a parsed log by the key returned from `getKey`. Later occurrences
 * replace earlier ones at the earlier position, so an `updateShoferMessage`-
 * style append-with-same-ts preserves message ordering while overwriting the
 * stale snapshot. Records with `undefined` key are kept in arrival order
 * without dedupe.
 */
export function dedupeByKey<T>(records: T[], getKey: (r: T) => number | string | undefined): T[] {
	const indexByKey = new Map<number | string, number>()
	const out: T[] = []
	for (const r of records) {
		const key = getKey(r)
		if (key !== undefined) {
			const existing = indexByKey.get(key)
			if (existing !== undefined) {
				out[existing] = r
				continue
			}
			indexByKey.set(key, out.length)
		}
		out.push(r)
	}
	return out
}
