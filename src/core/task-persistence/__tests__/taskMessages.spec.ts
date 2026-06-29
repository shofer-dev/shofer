/**
 * Tests for the SQLite-backed `taskMessages` persistence layer (§5).
 * The free functions keep their signatures; storage is now SQLite (no JSONL).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as os from "os"
import * as path from "path"
import { mkdtempSync, rmSync } from "fs"

import {
	appendTaskMessage,
	disposeAppendHandleForTask,
	readTaskMessages,
	readTaskMessagesTail,
	saveTaskMessages,
} from "../taskMessages"

let dir: string
const taskId = "task-ui"
const msg = (text: string, ts: number) => ({ ts, type: "say", say: "text", text }) as never

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "shofer-ui-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("taskMessages (SQLite)", () => {
	it("round-trips appended messages in order", async () => {
		await appendTaskMessage({ message: msg("one", 1), taskId, globalStoragePath: dir })
		await appendTaskMessage({ message: msg("two", 2), taskId, globalStoragePath: dir })
		expect((await readTaskMessages({ taskId, globalStoragePath: dir })).map((m: any) => m.text)).toEqual([
			"one",
			"two",
		])
	})

	it("dedupes by ts (partial→final update at same ts)", async () => {
		await appendTaskMessage({ message: msg("partial", 5), taskId, globalStoragePath: dir })
		await appendTaskMessage({ message: msg("final", 5), taskId, globalStoragePath: dir })
		expect((await readTaskMessages({ taskId, globalStoragePath: dir })).map((m: any) => m.text)).toEqual(["final"])
	})

	it("tails with a hasMore flag", async () => {
		for (const [t, ts] of [
			["a", 1],
			["b", 2],
			["c", 3],
		] as const)
			await appendTaskMessage({ message: msg(t, ts), taskId, globalStoragePath: dir })
		const [tail, hasMore] = await readTaskMessagesTail({ taskId, globalStoragePath: dir, maxMessages: 2 })
		expect(tail.map((m: any) => m.text)).toEqual(["b", "c"])
		expect(hasMore).toBe(true)
	})

	it("saveTaskMessages replaces the full set", async () => {
		await appendTaskMessage({ message: msg("stale", 1), taskId, globalStoragePath: dir })
		await saveTaskMessages({ messages: [msg("fresh", 2)], taskId, globalStoragePath: dir })
		expect((await readTaskMessages({ taskId, globalStoragePath: dir })).map((m: any) => m.text)).toEqual(["fresh"])
	})

	it("disposeAppendHandleForTask is a no-op (no file handle)", async () => {
		await expect(disposeAppendHandleForTask({ taskId, globalStoragePath: dir })).resolves.toBeUndefined()
	})

	it("returns [] for an unknown task", async () => {
		expect(await readTaskMessages({ taskId: "nope", globalStoragePath: dir })).toEqual([])
	})
})
