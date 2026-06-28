import { join } from "node:path"

import type { ShoferMessage } from "@shofer/types"

import type { ApiMessage } from "./apiMessages"
import { FileSystemMessagePersistence } from "./PersistencePort"
import type { MessagePersistencePort } from "./PersistencePort"

/**
 * SQLite message-persistence backend (todos/opencode_inspired_work.md §5 step 3).
 *
 * Implements the same `MessagePersistencePort` as the flat-file backend, storing
 * api/UI messages as rows in a single SQLite DB. Because row writes are cheap and
 * incremental, the flat-file performance machinery (debounced saves / append logs
 * / tail reads) is unnecessary against this backend.
 *
 * **Opt-in + safe by construction.** It uses Node's built-in `node:sqlite`
 * (experimental; available on Node 22.5+), loaded lazily so importing this module
 * never crashes a host that lacks it — `createMessagePersistence` feature-detects
 * and falls back to the flat-file backend. The default backend remains flat-file;
 * nothing switches to SQLite until a deliberate rollout (the remaining §5 step).
 *
 * **Migration (Part E #5: one-time importer).** The first time a task is read
 * from an empty DB, its existing flat-file messages are imported transparently,
 * so opting in never loses history. No big-bang migration; import is lazy/per-task.
 */

// Minimal structural types for the `node:sqlite` surface we use, so this file
// type-checks without depending on @types for the experimental module.
interface SqliteStatement {
	run(...params: unknown[]): unknown
	all(...params: unknown[]): Array<Record<string, unknown>>
}
interface SqliteDatabase {
	exec(sql: string): void
	prepare(sql: string): SqliteStatement
}

type Kind = "api" | "ui"

let sqliteModule: { DatabaseSync: new (path: string) => SqliteDatabase } | undefined
let sqliteLoadAttempted = false

/** Lazily load `node:sqlite`; returns undefined if unavailable on this runtime. */
async function loadSqlite(): Promise<typeof sqliteModule> {
	if (!sqliteLoadAttempted) {
		sqliteLoadAttempted = true
		try {
			// `node:sqlite` is experimental and ships no bundled type declarations;
			// load it via a string specifier so TS doesn't resolve the module type.
			const specifier = "node:sqlite"
			sqliteModule = (await import(specifier)) as unknown as typeof sqliteModule
		} catch {
			sqliteModule = undefined
		}
	}
	return sqliteModule
}

/** Whether the SQLite backend can run on this runtime. */
export async function isSqliteAvailable(): Promise<boolean> {
	return (await loadSqlite()) !== undefined
}

export class SqliteMessagePersistence implements MessagePersistencePort {
	private db?: SqliteDatabase
	private readonly fsBackend: FileSystemMessagePersistence
	private readonly imported = new Set<string>()

	constructor(private readonly globalStoragePath: string) {
		this.fsBackend = new FileSystemMessagePersistence(globalStoragePath)
	}

	private async ensureDb(): Promise<SqliteDatabase> {
		if (this.db) return this.db
		const mod = await loadSqlite()
		if (!mod) throw new Error("node:sqlite is not available on this runtime")
		const db = new mod.DatabaseSync(join(this.globalStoragePath, "shofer-messages.db"))
		db.exec(
			`CREATE TABLE IF NOT EXISTS messages (
				task_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				ts INTEGER NOT NULL,
				data TEXT NOT NULL,
				PRIMARY KEY (task_id, kind, ts)
			)`,
		)
		this.db = db
		return db
	}

	/** One-time per-task import of existing flat-file messages into the DB. */
	private async importIfNeeded(taskId: string): Promise<void> {
		if (this.imported.has(taskId)) return
		this.imported.add(taskId)
		const [api, ui] = await Promise.all([
			this.fsBackend.readApiMessages(taskId),
			this.fsBackend.readTaskMessages(taskId),
		])
		if (api.length === 0 && ui.length === 0) return
		const db = await this.ensureDb()
		const stmt = db.prepare("INSERT OR REPLACE INTO messages (task_id, kind, ts, data) VALUES (?, ?, ?, ?)")
		for (const m of api) stmt.run(taskId, "api", tsOf(m), JSON.stringify(m))
		for (const m of ui) stmt.run(taskId, "ui", tsOf(m), JSON.stringify(m))
	}

	private async append(taskId: string, kind: Kind, message: unknown): Promise<void> {
		await this.importIfNeeded(taskId)
		const db = await this.ensureDb()
		db.prepare("INSERT OR REPLACE INTO messages (task_id, kind, ts, data) VALUES (?, ?, ?, ?)").run(
			taskId,
			kind,
			tsOf(message),
			JSON.stringify(message),
		)
	}

	private async readAll<T>(taskId: string, kind: Kind): Promise<T[]> {
		await this.importIfNeeded(taskId)
		const db = await this.ensureDb()
		const rows = db
			.prepare("SELECT data FROM messages WHERE task_id = ? AND kind = ? ORDER BY ts ASC")
			.all(taskId, kind)
		return rows.map((r) => JSON.parse(r.data as string) as T)
	}

	private async readTail<T>(taskId: string, kind: Kind, maxMessages: number): Promise<[T[], boolean]> {
		const all = await this.readAll<T>(taskId, kind)
		if (maxMessages <= 0 || all.length <= maxMessages) return [all, false]
		return [all.slice(all.length - maxMessages), true]
	}

	private async save(taskId: string, kind: Kind, messages: unknown[]): Promise<void> {
		// Mark imported so a compaction-rewrite isn't shadowed by a later lazy import.
		this.imported.add(taskId)
		const db = await this.ensureDb()
		db.prepare("DELETE FROM messages WHERE task_id = ? AND kind = ?").run(taskId, kind)
		const stmt = db.prepare("INSERT OR REPLACE INTO messages (task_id, kind, ts, data) VALUES (?, ?, ?, ?)")
		for (const m of messages) stmt.run(taskId, kind, tsOf(m), JSON.stringify(m))
	}

	appendApiMessage(taskId: string, message: ApiMessage): Promise<void> {
		return this.append(taskId, "api", message)
	}
	readApiMessages(taskId: string): Promise<ApiMessage[]> {
		return this.readAll<ApiMessage>(taskId, "api")
	}
	readApiMessagesTail(taskId: string, maxMessages: number): Promise<[ApiMessage[], boolean]> {
		return this.readTail<ApiMessage>(taskId, "api", maxMessages)
	}
	saveApiMessages(taskId: string, messages: ApiMessage[]): Promise<void> {
		return this.save(taskId, "api", messages)
	}

	appendTaskMessage(taskId: string, message: ShoferMessage): Promise<void> {
		return this.append(taskId, "ui", message)
	}
	readTaskMessages(taskId: string): Promise<ShoferMessage[]> {
		return this.readAll<ShoferMessage>(taskId, "ui")
	}
	readTaskMessagesTail(taskId: string, maxMessages: number): Promise<[ShoferMessage[], boolean]> {
		return this.readTail<ShoferMessage>(taskId, "ui", maxMessages)
	}
	saveTaskMessages(taskId: string, messages: ShoferMessage[]): Promise<void> {
		return this.save(taskId, "ui", messages)
	}

	disposeAppendHandleForTask(): Promise<void> {
		// No long-lived per-task file handle in the SQLite backend.
		return Promise.resolve()
	}
}

/** Message timestamp used as the per-(task,kind) dedupe/order key (mirrors the flat-file read dedupe). */
function tsOf(message: unknown): number {
	const ts = (message as { ts?: unknown })?.ts
	return typeof ts === "number" ? ts : 0
}
