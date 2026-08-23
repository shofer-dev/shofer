/**
 * Tests for task-store backend SELECTION (§5).
 *
 * The behaviours worth pinning are the ones whose failure is silent: choosing
 * the local default when nothing is configured, honouring a registered or
 * dynamically imported backend, sharing one instance per host, and — the
 * important one — REFUSING rather than falling back when a configured backend
 * cannot be resolved. A host that asked for a shared store and quietly got a
 * local one serves every existing task an empty transcript.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import {
	DEFAULT_TASK_STORE,
	TASK_STORE_ENV,
	TASK_STORE_MODULE_ENV,
	registerTaskPersistenceBackend,
	resetTaskPersistenceBackends,
	resolveTaskPersistence,
	selectedTaskStoreName,
} from "../backend.js"
import { SqliteMessagePersistence, type TaskPersistencePort } from "../PersistencePort.js"

let dir: string

/** A port that answers nothing — enough to prove which backend was selected. */
const stubPort = (marker: string): TaskPersistencePort =>
	({
		marker,
		appendApiMessage: async () => {},
		readApiMessages: async () => [],
		readApiMessagesTail: async () => [[], false],
		saveApiMessages: async () => {},
		appendTaskMessage: async () => {},
		readTaskMessages: async () => [],
		readTaskMessagesTail: async () => [[], false],
		saveTaskMessages: async () => {},
		disposeAppendHandleForTask: async () => {},
		readTaskMetadata: async () => undefined,
		writeTaskMetadata: async () => {},
		deleteTaskMetadata: async () => {},
		listTaskMetadataIds: async () => [],
	}) as unknown as TaskPersistencePort

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "shofer-backend-"))
})
afterEach(async () => {
	await resetTaskPersistenceBackends()
	rmSync(dir, { recursive: true, force: true })
})

describe("selectedTaskStoreName", () => {
	it("defaults to the compiled-in local store", () => {
		expect(selectedTaskStoreName({})).toBe(DEFAULT_TASK_STORE)
		expect(selectedTaskStoreName({ [TASK_STORE_ENV]: "   " })).toBe(DEFAULT_TASK_STORE)
	})

	it("takes the configured name verbatim", () => {
		expect(selectedTaskStoreName({ [TASK_STORE_ENV]: "postgres" })).toBe("postgres")
	})
})

describe("resolveTaskPersistence", () => {
	it("builds the SQLite + files default when nothing is configured", async () => {
		const port = await resolveTaskPersistence(dir, {})
		expect(port).toBeInstanceOf(SqliteMessagePersistence)
		// The local default has no second writer, so it offers no lease.
		expect(port.lease).toBeUndefined()
	})

	it("returns one instance per host storage path", async () => {
		const [a, b] = await Promise.all([resolveTaskPersistence(dir, {}), resolveTaskPersistence(dir, {})])
		expect(a).toBe(b)
	})

	it("selects a programmatically registered backend by name", async () => {
		registerTaskPersistenceBackend("memory", () => stubPort("memory"))
		const port = await resolveTaskPersistence(dir, { [TASK_STORE_ENV]: "memory" })
		expect((port as unknown as { marker: string }).marker).toBe("memory")
	})

	it("hands the factory the storage path and the environment it was selected from", async () => {
		let seen: { globalStoragePath: string; env: NodeJS.ProcessEnv } | undefined
		registerTaskPersistenceBackend("memory", (options) => {
			seen = options
			return stubPort("memory")
		})
		const env = { [TASK_STORE_ENV]: "memory", SOME_BACKEND_SETTING: "on" }
		await resolveTaskPersistence(dir, env)
		expect(seen?.globalStoragePath).toBe(dir)
		expect(seen?.env.SOME_BACKEND_SETTING).toBe("on")
	})

	it("imports a backend module named by the environment", async () => {
		const modulePath = join(dir, "backend.mjs")
		writeFileSync(modulePath, "export function createTaskPersistence() { return { marker: 'imported' } }\n", "utf8")
		const port = await resolveTaskPersistence(dir, {
			[TASK_STORE_ENV]: "postgres",
			[TASK_STORE_MODULE_ENV]: pathToFileURL(modulePath).href,
		})
		expect((port as unknown as { marker: string }).marker).toBe("imported")
	})

	it("refuses an unknown backend rather than falling back to the default", async () => {
		await expect(resolveTaskPersistence(dir, { [TASK_STORE_ENV]: "postgres" })).rejects.toThrow(
			/names no backend this build carries/,
		)
	})

	it("refuses a module that cannot be imported", async () => {
		await expect(
			resolveTaskPersistence(dir, {
				[TASK_STORE_ENV]: "postgres",
				[TASK_STORE_MODULE_ENV]: pathToFileURL(join(dir, "absent.mjs")).href,
			}),
		).rejects.toThrow(/could not import/)
	})

	it("refuses a module that exports no factory", async () => {
		const modulePath = join(dir, "empty.mjs")
		writeFileSync(modulePath, "export const nothing = 1\n", "utf8")
		await expect(
			resolveTaskPersistence(dir, {
				[TASK_STORE_ENV]: "postgres",
				[TASK_STORE_MODULE_ENV]: pathToFileURL(modulePath).href,
			}),
		).rejects.toThrow(/does not export createTaskPersistence/)
	})
})
