import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ApiMessage } from "../apiMessages"
import { FileSystemMessagePersistence } from "../PersistencePort"

/**
 * Round-trips the flat-file persistence port. Confirms the adapter is a faithful,
 * behavior-preserving facade over the existing JSONL functions (§5 strangler
 * step 1) before any call site is routed through it.
 */
describe("FileSystemMessagePersistence", () => {
	let dir: string
	let port: FileSystemMessagePersistence
	const taskId = "task-abc"

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "shofer-persist-"))
		port = new FileSystemMessagePersistence(dir)
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
})
