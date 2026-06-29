/**
 * Tests for the SQLite-backed `apiMessages` persistence layer (§5).
 * The free functions keep their signatures; storage is now SQLite (no JSONL).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as os from "os"
import * as path from "path"
import { mkdtempSync, rmSync } from "fs"

import {
	appendApiMessage,
	readApiMessages,
	readApiMessagesTail,
	saveApiMessages,
	type ApiMessage,
} from "../apiMessages"

let dir: string
const taskId = "task-api"
const msg = (text: string, ts: number): ApiMessage => ({ role: "user", content: text, ts }) as unknown as ApiMessage

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "shofer-api-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("apiMessages (SQLite)", () => {
	it("round-trips appended messages in order", async () => {
		await appendApiMessage({ message: msg("one", 1), taskId, globalStoragePath: dir })
		await appendApiMessage({ message: msg("two", 2), taskId, globalStoragePath: dir })
		expect((await readApiMessages({ taskId, globalStoragePath: dir })).map((m) => m.content)).toEqual([
			"one",
			"two",
		])
	})

	it("dedupes by ts (re-appending the same ts updates in place)", async () => {
		await appendApiMessage({ message: msg("partial", 5), taskId, globalStoragePath: dir })
		await appendApiMessage({ message: msg("final", 5), taskId, globalStoragePath: dir })
		expect((await readApiMessages({ taskId, globalStoragePath: dir })).map((m) => m.content)).toEqual(["final"])
	})

	it("tails with a hasMore flag", async () => {
		for (const [t, ts] of [
			["a", 1],
			["b", 2],
			["c", 3],
		] as const)
			await appendApiMessage({ message: msg(t, ts), taskId, globalStoragePath: dir })
		const [tail, hasMore] = await readApiMessagesTail({ taskId, globalStoragePath: dir, maxMessages: 2 })
		expect(tail.map((m) => m.content)).toEqual(["b", "c"])
		expect(hasMore).toBe(true)
	})

	it("saveApiMessages replaces the full history", async () => {
		await appendApiMessage({ message: msg("stale", 1), taskId, globalStoragePath: dir })
		await saveApiMessages({ messages: [msg("fresh", 2)], taskId, globalStoragePath: dir })
		expect((await readApiMessages({ taskId, globalStoragePath: dir })).map((m) => m.content)).toEqual(["fresh"])
	})

	it("returns [] for an unknown task", async () => {
		expect(await readApiMessages({ taskId: "nope", globalStoragePath: dir })).toEqual([])
	})
})
