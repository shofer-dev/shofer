import { join } from "node:path"
import { mkdirSync } from "node:fs"

/**
 * SQLite message store (todos/opencode_inspired_work.md §5).
 *
 * The single persistence backend for task api/UI messages. Rows are keyed by
 * (task_id, kind, ts); `ts` is the dedupe/order key so a partial→final update at
 * the same `ts` collapses to the latest (matching the old flat-file read
 * semantics). Writes are cheap and incremental, so none of the prior flat-file
 * performance machinery (debounced saves, append logs, tail-window reads,
 * atomic-rewrite compaction) is needed.
 *
 * Uses Node's built-in `node:sqlite` (no native dependency), loaded lazily via a
 * string-specifier dynamic import (experimental module, no bundled types; dynamic
 * import works in both the CJS extension bundle and the ESM test runner). The DB
 * handle is cached per `globalStoragePath`.
 */

type Kind = "api" | "ui"

interface SqliteStatement {
	run(...params: unknown[]): unknown
	all(...params: unknown[]): Array<Record<string, unknown>>
}
interface SqliteDatabase {
	exec(sql: string): void
	prepare(sql: string): SqliteStatement
}

let ctor: (new (path: string) => SqliteDatabase) | undefined
async function getCtor(): Promise<new (path: string) => SqliteDatabase> {
	if (!ctor) {
		const specifier = "node:sqlite"
		const mod = (await import(specifier)) as unknown as { DatabaseSync: new (path: string) => SqliteDatabase }
		ctor = mod.DatabaseSync
	}
	return ctor
}

const dbCache = new Map<string, SqliteDatabase>()

async function getDb(globalStoragePath: string): Promise<SqliteDatabase> {
	let db = dbCache.get(globalStoragePath)
	if (!db) {
		mkdirSync(globalStoragePath, { recursive: true })
		const Ctor = await getCtor()
		db = new Ctor(join(globalStoragePath, "shofer-messages.db"))
		db.exec(
			`CREATE TABLE IF NOT EXISTS messages (
				task_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				ts INTEGER NOT NULL,
				data TEXT NOT NULL,
				PRIMARY KEY (task_id, kind, ts)
			)`,
		)
		dbCache.set(globalStoragePath, db)
	}
	return db
}

function tsOf(message: unknown): number {
	const ts = (message as { ts?: unknown })?.ts
	return typeof ts === "number" ? ts : 0
}

/** Append (or replace at the same ts) a single message. */
export async function storeAppend(
	globalStoragePath: string,
	taskId: string,
	kind: Kind,
	message: unknown,
): Promise<void> {
	const db = await getDb(globalStoragePath)
	db.prepare("INSERT OR REPLACE INTO messages (task_id, kind, ts, data) VALUES (?, ?, ?, ?)").run(
		taskId,
		kind,
		tsOf(message),
		JSON.stringify(message),
	)
}

/** Read all messages for a task/kind, ordered by ts. */
export async function storeReadAll<T>(globalStoragePath: string, taskId: string, kind: Kind): Promise<T[]> {
	const db = await getDb(globalStoragePath)
	return db
		.prepare("SELECT data FROM messages WHERE task_id = ? AND kind = ? ORDER BY ts ASC")
		.all(taskId, kind)
		.map((r) => JSON.parse(r.data as string) as T)
}

/** Last `maxMessages` records; returns `[messages, hasMore]`. */
export async function storeReadTail<T>(
	globalStoragePath: string,
	taskId: string,
	kind: Kind,
	maxMessages: number,
): Promise<[T[], boolean]> {
	const all = await storeReadAll<T>(globalStoragePath, taskId, kind)
	if (maxMessages <= 0 || all.length <= maxMessages) return [all, false]
	return [all.slice(all.length - maxMessages), true]
}

/** Replace the entire message set for a task/kind (compaction / overwrite). */
export async function storeSaveAll(
	globalStoragePath: string,
	taskId: string,
	kind: Kind,
	messages: unknown[],
): Promise<void> {
	const db = await getDb(globalStoragePath)
	db.prepare("DELETE FROM messages WHERE task_id = ? AND kind = ?").run(taskId, kind)
	const stmt = db.prepare("INSERT OR REPLACE INTO messages (task_id, kind, ts, data) VALUES (?, ?, ?, ?)")
	for (const m of messages) stmt.run(taskId, kind, tsOf(m), JSON.stringify(m))
}
