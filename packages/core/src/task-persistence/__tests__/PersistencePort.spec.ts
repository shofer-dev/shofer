import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HistoryItem } from "@shofer/types"

import type { ApiMessage } from "../apiMessages.js"
import { SqliteMessagePersistence } from "../PersistencePort.js"

/**
 * Round-trips the SQLite persistence port adapter (§5) — confirms it is a faithful
 * facade over the message-store-backed functions.
 */
describe("SqliteMessagePersistence", () => {
	let dir: string
	let port: SqliteMessagePersistence
	const taskId = "task-abc"

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "shofer-persist-"))
		port = new SqliteMessagePersistence(dir)
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	// Reads dedupe by `ts`, so each message needs a distinct timestamp.
	const apiMsg = (text: string, ts: number): ApiMessage =>
		({ role: "user", content: text, ts }) as unknown as ApiMessage
	const uiMsg = (text: string, ts: number) => ({ ts, type: "say", say: "text", text }) as any

	it("round-trips appended API messages", async () => {
		await port.appendApiMessage(taskId, apiMsg("one", 1))
		await port.appendApiMessage(taskId, apiMsg("two", 2))
		const read = await port.readApiMessages(taskId)
		expect(read.map((m) => m.content)).toEqual(["one", "two"])
	})

	it("tails API messages with a hasMore flag", async () => {
		await port.appendApiMessage(taskId, apiMsg("a", 1))
		await port.appendApiMessage(taskId, apiMsg("b", 2))
		await port.appendApiMessage(taskId, apiMsg("c", 3))
		const [tail, hasMore] = await port.readApiMessagesTail(taskId, 2)
		expect(tail.map((m) => m.content)).toEqual(["b", "c"])
		expect(hasMore).toBe(true)
	})

	it("compacts (full rewrite) API messages via saveApiMessages", async () => {
		await port.appendApiMessage(taskId, apiMsg("stale", 1))
		await port.saveApiMessages(taskId, [apiMsg("fresh", 2)])
		const read = await port.readApiMessages(taskId)
		expect(read.map((m) => m.content)).toEqual(["fresh"])
	})

	it("round-trips UI (Shofer) messages and releases the append handle", async () => {
		await port.appendTaskMessage(taskId, uiMsg("hello", 1))
		const read = await port.readTaskMessages(taskId)
		expect(read.map((m: any) => m.text)).toEqual(["hello"])
		await expect(port.disposeAppendHandleForTask(taskId)).resolves.toBeUndefined()
	})

	it("returns empty for an unknown task", async () => {
		expect(await port.readApiMessages("nope")).toEqual([])
		expect(await port.readTaskMessages("nope")).toEqual([])
	})

	// ── Task metadata: the sibling port, backed by per-task history_item.json ──

	const historyItem = (id: string, task: string): HistoryItem =>
		({ id, number: 1, ts: 1, task, tokensIn: 0, tokensOut: 0, totalCost: 0, workspace: "/ws" }) as HistoryItem

	it("round-trips a task's history item", async () => {
		await port.writeTaskMetadata(historyItem(taskId, "first"))
		expect((await port.readTaskMetadata(taskId))?.task).toBe("first")
	})

	it("replaces an existing history item on rewrite", async () => {
		await port.writeTaskMetadata(historyItem(taskId, "first"))
		await port.writeTaskMetadata(historyItem(taskId, "second"))
		expect((await port.readTaskMetadata(taskId))?.task).toBe("second")
	})

	it("reads an absent history item as undefined, and deleting an absent one is not an error", async () => {
		expect(await port.readTaskMetadata("nope")).toBeUndefined()
		await expect(port.deleteTaskMetadata("nope")).resolves.toBeUndefined()
	})

	it("lists the task ids it holds metadata for, and drops a deleted one", async () => {
		await port.writeTaskMetadata(historyItem("task-a", "a"))
		await port.writeTaskMetadata(historyItem("task-b", "b"))
		expect((await port.listTaskMetadataIds()).sort()).toEqual(["task-a", "task-b"])

		await port.deleteTaskMetadata("task-a")
		expect(await port.readTaskMetadata("task-a")).toBeUndefined()
	})
})
