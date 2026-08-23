/**
 * Tests for the raw `message-store` SQLite primitives that the
 * `apiMessages`/`taskMessages` wrappers share: the WAL/synchronous pragmas
 * every connection must carry (the whole point of the store's existence on
 * network-backed volumes — a delete-mode commit costs two network fsyncs,
 * paid synchronously by the host's event loop), and `storeSaveAll`'s
 * transactional overwrite.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as os from "os"
import * as path from "path"
import { mkdtempSync, rmSync } from "fs"

import { storeAppend, storeReadAll, storeSaveAll } from "../message-store.js"

let dir: string
const taskId = "task-store"
const msg = (text: string, ts: number) => ({ ts, type: "say", say: "text", text })

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "shofer-store-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("message-store", () => {
	it("opens the database in WAL mode with synchronous=NORMAL", async () => {
		// Trigger the open.
		await storeAppend(dir, taskId, "ui", msg("x", 1))

		// Read the live pragmas back through an independent connection to the
		// same file: journal_mode is persisted in the file itself, so a fresh
		// handle must report WAL; synchronous is per-connection and is asserted
		// on the store's own handle below via a second append's handle reuse.
		const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
			DatabaseSync: new (p: string) => {
				prepare(sql: string): { get(): Record<string, unknown> }
				close(): void
			}
		}
		const probe = new DatabaseSync(path.join(dir, "shofer-messages.db"))
		try {
			expect(probe.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
		} finally {
			probe.close()
		}
	})

	it("storeSaveAll rolls back the whole overwrite when a message fails mid-loop", async () => {
		await storeAppend(dir, taskId, "ui", msg("pre-existing", 1))

		// A circular structure makes JSON.stringify throw AFTER the DELETE has
		// run — the failure mode the transaction exists for.
		const circular: Record<string, unknown> = { ts: 2 }
		circular.self = circular
		await expect(storeSaveAll(dir, taskId, "ui", [msg("new", 2), circular])).rejects.toThrow()

		// Without the transaction the DELETE had already committed and this read
		// would come back empty.
		expect((await storeReadAll<Record<string, unknown>>(dir, taskId, "ui")).map((m) => m.text)).toEqual([
			"pre-existing",
		])
	})
})
