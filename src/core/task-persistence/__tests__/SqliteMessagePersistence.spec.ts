import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ApiMessage } from "../apiMessages"
import { FileSystemMessagePersistence } from "../PersistencePort"
import { SqliteMessagePersistence, isSqliteAvailable } from "../SqliteMessagePersistence"
import { createMessagePersistence } from "../createMessagePersistence"

/**
 * §5 step 3 — SQLite backend. Skips automatically on runtimes without
 * `node:sqlite` (the backend is opt-in + feature-detected in production).
 */
describe("SqliteMessagePersistence", async () => {
	const available = await isSqliteAvailable()
	const d = available ? describe : describe.skip

	let dir: string
	const taskId = "task-sqlite"
	const apiMsg = (text: string, ts: number): ApiMessage =>
		({ role: "user", content: text, ts }) as unknown as ApiMessage
	const uiMsg = (text: string, ts: number) => ({ ts, type: "say", say: "text", text }) as any

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "shofer-sqlite-"))
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	d("round-trips and dedupes", () => {
		it("round-trips appended api + ui messages", async () => {
			const port = new SqliteMessagePersistence(dir)
			await port.appendApiMessage(taskId, apiMsg("one", 1))
			await port.appendApiMessage(taskId, apiMsg("two", 2))
			await port.appendTaskMessage(taskId, uiMsg("hi", 1))
			expect((await port.readApiMessages(taskId)).map((m) => m.content)).toEqual(["one", "two"])
			expect((await port.readTaskMessages(taskId)).map((m: any) => m.text)).toEqual(["hi"])
		})

		it("dedupes by ts (last write wins), like the flat-file read path", async () => {
			const port = new SqliteMessagePersistence(dir)
			await port.appendTaskMessage(taskId, uiMsg("partial", 5))
			await port.appendTaskMessage(taskId, uiMsg("final", 5))
			const read = await port.readTaskMessages(taskId)
			expect(read.map((m: any) => m.text)).toEqual(["final"])
		})

		it("tails with a hasMore flag", async () => {
			const port = new SqliteMessagePersistence(dir)
			for (const [t, ts] of [
				["a", 1],
				["b", 2],
				["c", 3],
			] as const)
				await port.appendApiMessage(taskId, apiMsg(t, ts))
			const [tail, hasMore] = await port.readApiMessagesTail(taskId, 2)
			expect(tail.map((m) => m.content)).toEqual(["b", "c"])
			expect(hasMore).toBe(true)
		})

		it("compacts via save (full rewrite)", async () => {
			const port = new SqliteMessagePersistence(dir)
			await port.appendApiMessage(taskId, apiMsg("stale", 1))
			await port.saveApiMessages(taskId, [apiMsg("fresh", 2)])
			expect((await port.readApiMessages(taskId)).map((m) => m.content)).toEqual(["fresh"])
		})
	})

	d("one-time importer", () => {
		it("imports existing flat-file messages on first read", async () => {
			// Seed flat files via the filesystem backend, then read through SQLite.
			const fs = new FileSystemMessagePersistence(dir)
			await fs.appendApiMessage(taskId, apiMsg("legacy-1", 1))
			await fs.appendApiMessage(taskId, apiMsg("legacy-2", 2))
			await fs.appendTaskMessage(taskId, uiMsg("legacy-ui", 1))

			const sqlite = new SqliteMessagePersistence(dir)
			expect((await sqlite.readApiMessages(taskId)).map((m) => m.content)).toEqual(["legacy-1", "legacy-2"])
			expect((await sqlite.readTaskMessages(taskId)).map((m: any) => m.text)).toEqual(["legacy-ui"])

			// A subsequent append coexists with imported history.
			await sqlite.appendApiMessage(taskId, apiMsg("new", 3))
			expect((await sqlite.readApiMessages(taskId)).map((m) => m.content)).toEqual([
				"legacy-1",
				"legacy-2",
				"new",
			])
		})
	})

	d("factory", () => {
		it("returns the sqlite backend when requested and available", async () => {
			const port = await createMessagePersistence(dir, "sqlite")
			expect(port).toBeInstanceOf(SqliteMessagePersistence)
		})
		it("defaults to the filesystem backend", async () => {
			const port = await createMessagePersistence(dir)
			expect(port).toBeInstanceOf(FileSystemMessagePersistence)
		})
	})
})
