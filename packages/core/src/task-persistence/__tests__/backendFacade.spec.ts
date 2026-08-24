/**
 * The `apiMessages` / `taskMessages` free functions must reach the SELECTED
 * backend, not the compiled-in SQLite one (§5).
 *
 * This is the regression net for a live bug: the facades called the local SQLite
 * store directly, so on a host configured for a shared store every read through
 * them answered with an EMPTY transcript — a completed child's result silently
 * absent, nothing thrown and nothing logged, which is the exact failure
 * `backend.ts` documents its fail-loud selection as existing to prevent.
 *
 * Two halves are pinned here: a selected backend IS what the facades talk to,
 * and an unselected one is NOT (the default host stays byte-identical, proved
 * against real SQLite in `taskMessages.spec.ts` / `apiMessages.spec.ts`).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ShoferMessage } from "@shofer/types"

import { FakeSharedTaskStore } from "../../__fixtures__/fakeSharedTaskStore.js"
import { TASK_STORE_ENV, registerTaskPersistenceBackend, resetTaskPersistenceBackends } from "../backend.js"
import {
	type ApiMessage,
	appendApiMessage,
	readApiMessages,
	readApiMessagesTail,
	saveApiMessages,
} from "../apiMessages.js"
import {
	appendTaskMessage,
	disposeAppendHandleForTask,
	readTaskMessages,
	readTaskMessagesTail,
	saveTaskMessages,
} from "../taskMessages.js"

const uiMsg = (text: string, ts: number) => ({ ts, type: "say", say: "text", text }) as ShoferMessage
const apiMsg = (text: string, ts: number) => ({ role: "user", content: text, ts }) as unknown as ApiMessage

let dir: string
let store: FakeSharedTaskStore
const taskId = "child-task"

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "shofer-facade-"))
	store = new FakeSharedTaskStore()
	registerTaskPersistenceBackend("fake-shared", () => store)
})

afterEach(async () => {
	delete process.env[TASK_STORE_ENV]
	await resetTaskPersistenceBackends()
	rmSync(dir, { recursive: true, force: true })
})

describe("taskMessages facade routes through the selected backend", () => {
	beforeEach(() => {
		process.env[TASK_STORE_ENV] = "fake-shared"
	})

	it("reads the selected backend's transcript, not an empty local one", async () => {
		// Written by "another process" straight into the shared store.
		store.ui.set(taskId, [uiMsg("the child's result", 7)])

		const read = await readTaskMessages({ taskId, globalStoragePath: dir })
		expect(read.map((m) => m.text)).toEqual(["the child's result"])
	})

	it("tails the selected backend", async () => {
		store.ui.set(taskId, [uiMsg("a", 1), uiMsg("b", 2), uiMsg("c", 3)])
		const [tail, hasMore] = await readTaskMessagesTail({ taskId, globalStoragePath: dir, maxMessages: 2 })
		expect(tail.map((m) => m.text)).toEqual(["b", "c"])
		expect(hasMore).toBe(true)
	})

	it("appends and saves into the selected backend", async () => {
		await appendTaskMessage({ message: uiMsg("one", 1), taskId, globalStoragePath: dir })
		expect(store.ui.get(taskId)?.map((m) => m.text)).toEqual(["one"])

		await saveTaskMessages({ messages: [uiMsg("fresh", 2)], taskId, globalStoragePath: dir })
		expect(store.ui.get(taskId)?.map((m) => m.text)).toEqual(["fresh"])
	})

	it("forwards handle disposal to the selected backend", async () => {
		await disposeAppendHandleForTask({ taskId, globalStoragePath: dir })
		expect(store.disposed).toEqual([taskId])
	})
})

describe("apiMessages facade routes through the selected backend", () => {
	beforeEach(() => {
		process.env[TASK_STORE_ENV] = "fake-shared"
	})

	it("round-trips through the selected backend", async () => {
		await appendApiMessage({ message: apiMsg("one", 1), taskId, globalStoragePath: dir })
		await appendApiMessage({ message: apiMsg("two", 2), taskId, globalStoragePath: dir })
		expect((await readApiMessages({ taskId, globalStoragePath: dir })).map((m) => m.content)).toEqual([
			"one",
			"two",
		])

		const [tail, hasMore] = await readApiMessagesTail({ taskId, globalStoragePath: dir, maxMessages: 1 })
		expect(tail.map((m) => m.content)).toEqual(["two"])
		expect(hasMore).toBe(true)

		await saveApiMessages({ messages: [apiMsg("fresh", 3)], taskId, globalStoragePath: dir })
		expect(store.api.get(taskId)?.map((m) => m.content)).toEqual(["fresh"])
	})
})

describe("selection discipline", () => {
	it("leaves the default host on SQLite even when another backend is registered", async () => {
		// No SHOFER_TASK_STORE — a registered backend must not become the default.
		store.ui.set(taskId, [uiMsg("should never be read", 1)])
		await appendTaskMessage({ message: uiMsg("local", 1), taskId, globalStoragePath: dir })

		expect((await readTaskMessages({ taskId, globalStoragePath: dir })).map((m) => m.text)).toEqual(["local"])
		expect(store.ui.get(taskId)?.map((m) => m.text)).toEqual(["should never be read"])
	})

	it("refuses a configured backend it cannot resolve rather than falling back to SQLite", async () => {
		process.env[TASK_STORE_ENV] = "postgres"
		await expect(readTaskMessages({ taskId, globalStoragePath: dir })).rejects.toThrow(
			/names no backend this build carries/,
		)
		await expect(readApiMessages({ taskId, globalStoragePath: dir })).rejects.toThrow(
			/names no backend this build carries/,
		)
	})
})
