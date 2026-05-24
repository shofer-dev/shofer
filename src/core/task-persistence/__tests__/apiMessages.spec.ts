/**
 * Tests for the JSONL-backed `apiMessages` persistence layer (§4.1).
 * Mirrors `taskMessages.spec.ts` plus the additional `claude_messages.json`
 * legacy cutover.
 */

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import { appendApiMessage, readApiMessages, saveApiMessages } from "../apiMessages"

let tmpBaseDir: string

beforeEach(async () => {
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-api-jsonl-"))
})

async function apiPath(taskId: string): Promise<string> {
	return path.join(tmpBaseDir, "tasks", taskId, "api_conversation_history.jsonl")
}

describe("apiMessages JSONL persistence", () => {
	it("saveApiMessages writes one record per line with trailing newline", async () => {
		const messages: any[] = [
			{ ts: 1, role: "user", content: "hi" },
			{ ts: 2, role: "assistant", content: "yo" },
		]
		await saveApiMessages({ messages, taskId: "task-1", globalStoragePath: tmpBaseDir })

		const raw = await fs.readFile(await apiPath("task-1"), "utf8")
		expect(raw.endsWith("\n")).toBe(true)
		const lines = raw.trimEnd().split("\n")
		expect(lines).toHaveLength(2)
		expect(JSON.parse(lines[0])).toEqual(messages[0])
	})

	it("appendApiMessage + readApiMessages round-trip", async () => {
		const taskId = "task-roundtrip"
		const m1: any = { ts: 10, role: "user", content: "one" }
		const m2: any = { ts: 20, role: "assistant", content: "two" }
		await appendApiMessage({ message: m1, taskId, globalStoragePath: tmpBaseDir })
		await appendApiMessage({ message: m2, taskId, globalStoragePath: tmpBaseDir })

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })
		expect(result).toEqual([m1, m2])
	})

	it("dedupes by ts on read (last wins, position preserved)", async () => {
		const taskId = "task-dedupe"
		await appendApiMessage({
			message: { ts: 10, role: "user", content: "v1" } as any,
			taskId,
			globalStoragePath: tmpBaseDir,
		})
		await appendApiMessage({
			message: { ts: 20, role: "assistant", content: "B" } as any,
			taskId,
			globalStoragePath: tmpBaseDir,
		})
		await appendApiMessage({
			message: { ts: 10, role: "user", content: "v2" } as any,
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })
		expect(result).toHaveLength(2)
		expect(result[0]).toMatchObject({ ts: 10, content: "v2" })
		expect(result[1]).toMatchObject({ ts: 20, content: "B" })
	})

	it("hard cutover: legacy api_conversation_history.json is unlinked, returns []", async () => {
		const taskId = "task-legacy-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const legacy = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(legacy, JSON.stringify([{ ts: 1, role: "user", content: "x" }]), "utf8")

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })
		expect(result).toEqual([])

		const stillExists = await fs
			.access(legacy)
			.then(() => true)
			.catch(() => false)
		expect(stillExists).toBe(false)
	})

	it("hard cutover: legacy claude_messages.json is also unlinked, returns []", async () => {
		const taskId = "task-legacy-claude"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const legacy = path.join(taskDir, "claude_messages.json")
		await fs.writeFile(legacy, JSON.stringify([{ ts: 1 }]), "utf8")

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })
		expect(result).toEqual([])

		const stillExists = await fs
			.access(legacy)
			.then(() => true)
			.catch(() => false)
		expect(stillExists).toBe(false)
	})

	it("returns [] when no file exists", async () => {
		const result = await readApiMessages({ taskId: "missing", globalStoragePath: tmpBaseDir })
		expect(result).toEqual([])
	})
})
