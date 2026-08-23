import * as fs from "fs"
import * as path from "path"
import { tmpdir } from "os"

import { FileMemento } from "../storage/Memento.js"
import { FileSecretStorage } from "../storage/SecretStorage.js"

describe("FileMemento", () => {
	let tempDir: string
	let mementoPath: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(tmpdir(), "memento-test-"))
		mementoPath = path.join(tempDir, "state.json")
	})

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true })
		}
	})

	it("should store and retrieve values", async () => {
		const memento = new FileMemento(mementoPath)

		await memento.update("key1", "value1")
		await memento.update("key2", 42)

		expect(memento.get("key1")).toBe("value1")
		expect(memento.get("key2")).toBe(42)
	})

	it("should return default value when key doesn't exist", () => {
		const memento = new FileMemento(mementoPath)

		expect(memento.get("nonexistent", "default")).toBe("default")
		expect(memento.get<number>("missing", 0)).toBe(0)
	})

	it("should persist data to file", async () => {
		const memento1 = new FileMemento(mementoPath)
		await memento1.update("persisted", "value")

		// Create new instance to verify persistence
		const memento2 = new FileMemento(mementoPath)
		expect(memento2.get("persisted")).toBe("value")
	})

	it("should delete values when updated with undefined", async () => {
		const memento = new FileMemento(mementoPath)

		await memento.update("key", "value")
		expect(memento.get("key")).toBe("value")

		await memento.update("key", undefined)
		expect(memento.get("key")).toBeUndefined()
	})

	it("should return all keys", async () => {
		const memento = new FileMemento(mementoPath)

		await memento.update("key1", "value1")
		await memento.update("key2", "value2")
		await memento.update("key3", "value3")

		const keys = memento.keys()
		expect(keys).toHaveLength(3)
		expect(keys).toContain("key1")
		expect(keys).toContain("key2")
		expect(keys).toContain("key3")
	})

	it("should clear all data", async () => {
		const memento = new FileMemento(mementoPath)

		await memento.update("key1", "value1")
		await memento.update("key2", "value2")

		await memento.clear()

		expect(memento.keys()).toHaveLength(0)
		expect(memento.get("key1")).toBeUndefined()
	})
})

/**
 * Spy on the rename that publishes each atomic write, so tests can count the
 * writes that actually landed. Wrapped in a function purely to name its type.
 */
const spyOnRename = () => vi.spyOn(fs.promises, "rename")

describe("FileMemento write coalescing", () => {
	let tempDir: string
	let mementoPath: string
	let renameSpy: ReturnType<typeof spyOnRename>

	/**
	 * Read the state file back as it exists on disk right now.
	 */
	const readState = (): Record<string, unknown> => JSON.parse(fs.readFileSync(mementoPath, "utf-8"))

	/**
	 * Names of every entry currently in the memento's directory, used to prove no
	 * temp file survives a flush.
	 */
	const dirEntries = (): string[] => fs.readdirSync(tempDir).sort()

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(tmpdir(), "memento-flush-test-"))
		mementoPath = path.join(tempDir, "state.json")
		// Counts writes that actually landed: one rename per flush.
		renameSpy = spyOnRename()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true })
		}
	})

	it("collapses several updates in one tick into a single write", async () => {
		const memento = new FileMemento(mementoPath)

		const first = memento.update("a", 1)
		const second = memento.update("b", 2)
		const third = memento.update("c", 3)

		// All three mutations ride the same flush.
		expect(second).toBe(first)
		expect(third).toBe(first)

		await Promise.all([first, second, third])

		expect(renameSpy).toHaveBeenCalledTimes(1)
		expect(readState()).toEqual({ a: 1, b: 2, c: 3 })
	})

	it("resolves the update promise only once the value is durable", async () => {
		const memento = new FileMemento(mementoPath)

		const pending = memento.update("key", "value")
		expect(fs.existsSync(mementoPath)).toBe(false)

		await pending

		expect(readState()).toEqual({ key: "value" })
	})

	it("leaves no temp file behind after a flush", async () => {
		const memento = new FileMemento(mementoPath)

		await memento.update("key", "value")

		expect(dirEntries()).toEqual(["state.json"])
	})

	it("persists the last value written to a key within one flush", async () => {
		const memento = new FileMemento(mementoPath)

		const first = memento.update("key", "first")
		const second = memento.update("key", "second")
		await Promise.all([first, second])

		expect(renameSpy).toHaveBeenCalledTimes(1)
		expect(readState()).toEqual({ key: "second" })
	})

	it("picks up a mutation made after a flush started with a follow-up write", async () => {
		const memento = new FileMemento(mementoPath)

		const first = memento.update("key", "first")
		// Long enough for the coalescing window to elapse and the write to begin.
		await new Promise((resolve) => setTimeout(resolve, 20))
		const second = memento.update("key", "second")

		expect(second).not.toBe(first)

		await Promise.all([first, second])

		expect(renameSpy).toHaveBeenCalledTimes(2)
		expect(readState()).toEqual({ key: "second" })
	})

	it("flush() persists pending state and is a no-op when nothing is pending", async () => {
		const memento = new FileMemento(mementoPath)

		void memento.update("key", "value")
		await memento.flush()

		expect(readState()).toEqual({ key: "value" })
		expect(renameSpy).toHaveBeenCalledTimes(1)

		await memento.flush()

		expect(renameSpy).toHaveBeenCalledTimes(1)
	})

	it("routes clear() through the same coalesced write", async () => {
		const memento = new FileMemento(mementoPath)
		await memento.update("key", "value")
		renameSpy.mockClear()

		await memento.clear()

		expect(renameSpy).toHaveBeenCalledTimes(1)
		expect(readState()).toEqual({})
		expect(dirEntries()).toEqual(["state.json"])
	})

	it("rejects the awaited promise when the flush fails, and stays usable", async () => {
		// A regular file where a directory is needed makes every write fail with
		// ENOTDIR, without mocking the filesystem.
		const blockerPath = path.join(tempDir, "blocker")
		fs.writeFileSync(blockerPath, "not a directory")

		const memento = new FileMemento(path.join(blockerPath, "state.json"))

		await expect(memento.update("key", "value")).rejects.toThrow()

		// The failure is reported, not swallowed — and the object still works.
		expect(memento.get("key")).toBe("value")
		expect(memento.keys()).toEqual(["key"])
		await expect(memento.flush()).resolves.toBeUndefined()

		// No scratch file survived the failed write.
		expect(dirEntries()).toEqual(["blocker"])
	})
})

describe("FileSecretStorage", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(tmpdir(), "secrets-test-"))
	})

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true })
		}
	})

	it("should store and retrieve secrets", async () => {
		const storage = new FileSecretStorage(tempDir)

		await storage.store("apiKey", "sk-test-123")
		const retrieved = await storage.get("apiKey")

		expect(retrieved).toBe("sk-test-123")
	})

	it("should return undefined for non-existent secrets", async () => {
		const storage = new FileSecretStorage(tempDir)
		const result = await storage.get("nonexistent")

		expect(result).toBeUndefined()
	})

	it("should delete secrets", async () => {
		const storage = new FileSecretStorage(tempDir)

		await storage.store("apiKey", "sk-test-123")
		expect(await storage.get("apiKey")).toBe("sk-test-123")

		await storage.delete("apiKey")
		expect(await storage.get("apiKey")).toBeUndefined()
	})

	it("should persist secrets across instances", async () => {
		const storage1 = new FileSecretStorage(tempDir)
		await storage1.store("token", "persistent-value")

		const storage2 = new FileSecretStorage(tempDir)
		const value = await storage2.get("token")

		expect(value).toBe("persistent-value")
	})

	it("should fire onDidChange event when secret changes", async () => {
		const storage = new FileSecretStorage(tempDir)
		const events: string[] = []

		storage.onDidChange((e) => {
			events.push(e.key)
		})

		await storage.store("key1", "value1")
		await storage.store("key2", "value2")
		await storage.delete("key1")

		expect(events).toEqual(["key1", "key2", "key1"])
	})

	it("should clear all secrets", async () => {
		const storage = new FileSecretStorage(tempDir)

		await storage.store("key1", "value1")
		await storage.store("key2", "value2")

		storage.clearAll()

		expect(await storage.get("key1")).toBeUndefined()
		expect(await storage.get("key2")).toBeUndefined()
	})

	it("should create secrets.json file with restrictive permissions on Unix", async () => {
		if (process.platform === "win32") {
			// Skip on Windows
			return
		}

		const storage = new FileSecretStorage(tempDir)
		await storage.store("key", "value")

		const secretsPath = path.join(tempDir, "secrets.json")
		const stats = fs.statSync(secretsPath)
		const mode = stats.mode & 0o777

		// Should be 0600 (owner read/write only)
		expect(mode).toBe(0o600)
	})
})
