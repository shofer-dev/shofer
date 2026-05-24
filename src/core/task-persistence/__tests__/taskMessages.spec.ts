/**
 * Tests for the JSONL-backed `taskMessages` persistence layer (§4.1).
 *
 * Key invariants exercised:
 *  - `saveTaskMessages` writes one JSON object per line.
 *  - `appendTaskMessage` appends a single line in O(1).
 *  - `readTaskMessages` round-trips appended messages and dedupes by `ts`,
 *    preserving first-occurrence position.
 *  - Hard cutover: a stale `ui_messages.json` is unlinked on first read.
 *  - Truncated final line (crash mid-append) is silently dropped.
 */

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import { appendTaskMessage, readTaskMessages, saveTaskMessages } from "../taskMessages"

let tmpBaseDir: string

beforeEach(async () => {
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-task-jsonl-"))
})

async function uiPath(taskId: string): Promise<string> {
	return path.join(tmpBaseDir, "tasks", taskId, "ui_messages.jsonl")
}

describe("taskMessages.saveTaskMessages (JSONL compaction)", () => {
	it("writes one record per line, including trailing newline", async () => {
		const messages: any[] = [
			{ ts: 1, type: "say", say: "text", text: "Hello" },
			{ ts: 2, type: "ask", ask: "tool", text: "ok?" },
		]
		await saveTaskMessages({ messages, taskId: "task-1", globalStoragePath: tmpBaseDir })

		const raw = await fs.readFile(await uiPath("task-1"), "utf8")
		expect(raw.endsWith("\n")).toBe(true)
		const lines = raw.trimEnd().split("\n")
		expect(lines).toHaveLength(2)
		expect(JSON.parse(lines[0])).toEqual(messages[0])
		expect(JSON.parse(lines[1])).toEqual(messages[1])
	})

	it("writes empty file for empty messages array", async () => {
		await saveTaskMessages({ messages: [], taskId: "task-2", globalStoragePath: tmpBaseDir })
		const raw = await fs.readFile(await uiPath("task-2"), "utf8")
		expect(raw).toBe("")
	})
})

describe("taskMessages.appendTaskMessage", () => {
	it("appends a single line per call", async () => {
		const taskId = "task-append"
		await appendTaskMessage({
			message: { ts: 1, type: "say", say: "text", text: "a" } as any,
			taskId,
			globalStoragePath: tmpBaseDir,
		})
		await appendTaskMessage({
			message: { ts: 2, type: "say", say: "text", text: "b" } as any,
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		const raw = await fs.readFile(await uiPath(taskId), "utf8")
		const lines = raw.trimEnd().split("\n")
		expect(lines).toHaveLength(2)
		expect(JSON.parse(lines[0]).text).toBe("a")
		expect(JSON.parse(lines[1]).text).toBe("b")
	})
})

describe("taskMessages.readTaskMessages", () => {
	it("round-trips appended records", async () => {
		const taskId = "task-roundtrip"
		const m1: any = { ts: 10, type: "say", say: "text", text: "one" }
		const m2: any = { ts: 20, type: "say", say: "text", text: "two" }
		await appendTaskMessage({ message: m1, taskId, globalStoragePath: tmpBaseDir })
		await appendTaskMessage({ message: m2, taskId, globalStoragePath: tmpBaseDir })

		const result = await readTaskMessages({ taskId, globalStoragePath: tmpBaseDir })
		expect(result).toEqual([m1, m2])
	})

	it("dedupes by ts, preserving first-occurrence position (last wins)", async () => {
		const taskId = "task-dedupe"
		await appendTaskMessage({
			message: { ts: 10, type: "say", say: "text", text: "A" } as any,
			taskId,
			globalStoragePath: tmpBaseDir,
		})
		await appendTaskMessage({
			message: { ts: 20, type: "say", say: "text", text: "B" } as any,
			taskId,
			globalStoragePath: tmpBaseDir,
		})
		// Mutate ts=10 by re-appending with the same ts.
		await appendTaskMessage({
			message: { ts: 10, type: "say", say: "text", text: "A-updated" } as any,
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		const result = await readTaskMessages({ taskId, globalStoragePath: tmpBaseDir })
		expect(result).toHaveLength(2)
		// First-occurrence position of ts=10 is preserved (index 0).
		expect(result[0]).toMatchObject({ ts: 10, text: "A-updated" })
		expect(result[1]).toMatchObject({ ts: 20, text: "B" })
	})

	it("tolerates a truncated final line", async () => {
		const taskId = "task-truncated"
		const filePath = await uiPath(taskId)
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		const goodLine = JSON.stringify({ ts: 1, type: "say", say: "text", text: "ok" })
		// Write one good line + a truncated one (no closing brace, no newline).
		await fs.writeFile(filePath, `${goodLine}\n{"ts":2,"type":"say","say":"tex`, "utf8")

		const result = await readTaskMessages({ taskId, globalStoragePath: tmpBaseDir })
		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ ts: 1, text: "ok" })
	})

	it("returns [] and unlinks a stale legacy ui_messages.json (hard cutover)", async () => {
		const taskId = "task-legacy"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const legacy = path.join(taskDir, "ui_messages.json")
		await fs.writeFile(legacy, JSON.stringify([{ ts: 1 }]), "utf8")

		const result = await readTaskMessages({ taskId, globalStoragePath: tmpBaseDir })
		expect(result).toEqual([])

		const stillExists = await fs
			.access(legacy)
			.then(() => true)
			.catch(() => false)
		expect(stillExists).toBe(false)
	})

	it("returns [] when no file exists", async () => {
		const result = await readTaskMessages({ taskId: "nonexistent", globalStoragePath: tmpBaseDir })
		expect(result).toEqual([])
	})
})
