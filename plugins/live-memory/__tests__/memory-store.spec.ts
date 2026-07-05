import { createHash } from "node:crypto"
import { resolve as resolvePath } from "node:path"

import { describe, it, expect } from "vitest"
import type { PluginStorage, HostFileSystem } from "@shofer/types"
import type { FileContextEntry, AgentMessage } from "../types.js"

import { MemoryStore, MEMORY_STORE_VERSION, hashWorkspace, type MemoryData } from "../memory-store.js"

/** In-memory {@link PluginStorage} sandbox (traversal not modelled — tests use flat names). */
class FakeStorage implements PluginStorage {
	readonly dir = "/plugin-storage/live-memory"
	readonly files = new Map<string, string>()
	async readFile(relativePath: string): Promise<string> {
		const c = this.files.get(relativePath)
		if (c === undefined) throw new Error(`ENOENT: ${relativePath}`)
		return c
	}
	async writeFile(relativePath: string, content: string): Promise<void> {
		this.files.set(relativePath, content)
	}
	async exists(relativePath: string): Promise<boolean> {
		return this.files.has(relativePath)
	}
	async delete(relativePath: string): Promise<void> {
		this.files.delete(relativePath)
	}
	async list(): Promise<string[]> {
		return [...this.files.keys()]
	}
}

/** In-memory {@link HostFileSystem} keyed by absolute path (for file-context validation). */
class FakeHostFs implements HostFileSystem {
	readonly files = new Map<string, string>()
	async readFile(p: string): Promise<string> {
		const c = this.files.get(p)
		if (c === undefined) throw new Error(`ENOENT: ${p}`)
		return c
	}
	async writeFile(p: string, content: string): Promise<void> {
		this.files.set(p, content)
	}
	async exists(p: string): Promise<boolean> {
		return this.files.has(p)
	}
	async mkdir(): Promise<void> {}
	async delete(p: string): Promise<void> {
		this.files.delete(p)
	}
	async findFiles(): Promise<string[]> {
		return []
	}
}

const WS = "/ws/project"
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")
const makeMsg = (role: AgentMessage["role"], content: string): AgentMessage => ({
	id: `${role}-${content}`,
	role,
	content,
	timestamp: 1,
})
const fc = (filePath: string, contentHash: string): FileContextEntry => ({
	filePath,
	contentHash,
	tokenEstimate: 4,
	loadedAt: 1,
	lastReferencedAt: 1,
})

describe("MemoryStore (v2 conversation + validation)", () => {
	it("bumps the store version to 2 and exposes empty v2 fields on a fresh doc", async () => {
		expect(MEMORY_STORE_VERSION).toBe(2)
		const store = new MemoryStore(new FakeStorage(), WS)
		const data = await store.snapshot()
		expect(data.messages).toEqual([])
		expect(data.fileContexts).toEqual([])
		expect(data.costTracking).toMatchObject({
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalTokensTruncated: 0,
			estimatedCostUSD: 0,
		})
	})

	it("persists the document at version 2 including the new fields", async () => {
		const storage = new FakeStorage()
		const store = new MemoryStore(storage, WS)
		await store.recordObservation({ at: 1, kind: "edit", subject: "a.ts" })
		const [raw] = [...storage.files.values()]
		const doc = JSON.parse(raw!) as MemoryData
		expect(doc.version).toBe(2)
		expect(doc).toHaveProperty("messages")
		expect(doc).toHaveProperty("fileContexts")
		expect(doc).toHaveProperty("costTracking")
	})

	it("round-trips messages / fileContexts / costTracking via saveConversation", async () => {
		const storage = new FakeStorage()
		const s1 = new MemoryStore(storage, WS)
		const snapshot = {
			messages: [makeMsg("user", "hi"), makeMsg("assistant", "hello")],
			fileContexts: [] as FileContextEntry[],
			costTracking: {
				totalInputTokens: 11,
				totalOutputTokens: 7,
				totalTokensTruncated: 3,
				estimatedCostUSD: 0.42,
				lastUpdated: 123,
			},
		}
		await s1.saveConversation(snapshot)

		// Fresh instance over the same storage → reload from disk.
		const s2 = new MemoryStore(storage, WS)
		const loaded = await s2.load()
		expect(loaded.messages).toEqual(snapshot.messages)
		expect(loaded.costTracking).toMatchObject({
			totalInputTokens: 11,
			totalOutputTokens: 7,
			totalTokensTruncated: 3,
			estimatedCostUSD: 0.42,
		})
	})

	it("is backward-tolerant: upgrades a v1 document with empty v2 defaults", async () => {
		const storage = new FakeStorage()
		const fileName = `memory-${hashWorkspace(WS)}.json`
		// A legacy v1 document — no messages/fileContexts/costTracking.
		const v1 = {
			version: 1,
			workspacePath: WS,
			updatedAt: 10,
			observations: [{ at: 1, kind: "edit", subject: "legacy.ts" }],
			qa: [{ at: 2, question: "q", answer: "a" }],
			stats: { totalObservations: 1, totalQuestions: 1 },
		}
		storage.files.set(fileName, JSON.stringify(v1))

		const store = new MemoryStore(storage, WS)
		const data = await store.load()
		// Legacy content preserved…
		expect(data.observations).toHaveLength(1)
		expect(data.qa).toHaveLength(1)
		// …new fields defaulted, version upgraded.
		expect(data.version).toBe(2)
		expect(data.messages).toEqual([])
		expect(data.fileContexts).toEqual([])
		expect(data.costTracking.totalInputTokens).toBe(0)
	})

	it("starts fresh on an unknown/future version", async () => {
		const storage = new FakeStorage()
		const fileName = `memory-${hashWorkspace(WS)}.json`
		storage.files.set(
			fileName,
			JSON.stringify({ version: 999, observations: [{ at: 1, kind: "edit", subject: "x" }] }),
		)
		const store = new MemoryStore(storage, WS)
		const data = await store.load()
		expect(data.observations).toEqual([])
	})

	describe("on-load file-context validation", () => {
		it("keeps entries whose file exists and hash matches", async () => {
			const storage = new FakeStorage()
			const hostFs = new FakeHostFs()
			hostFs.files.set(resolvePath(WS, "keep.ts"), "content")
			const s1 = new MemoryStore(storage, WS)
			await s1.saveConversation({
				messages: [],
				fileContexts: [fc("keep.ts", sha256("content"))],
				costTracking: {
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalTokensTruncated: 0,
					estimatedCostUSD: 0,
					lastUpdated: 1,
				},
			})

			const s2 = new MemoryStore(storage, WS, { hostFs })
			const data = await s2.load()
			expect(data.fileContexts.map((f) => f.filePath)).toEqual(["keep.ts"])
		})

		it("evicts entries whose file is missing or whose hash mismatches", async () => {
			const storage = new FakeStorage()
			const hostFs = new FakeHostFs()
			hostFs.files.set(resolvePath(WS, "stale.ts"), "new content") // hash will mismatch
			// "gone.ts" is absent from hostFs entirely.
			const s1 = new MemoryStore(storage, WS)
			await s1.saveConversation({
				messages: [],
				fileContexts: [fc("stale.ts", sha256("old content")), fc("gone.ts", sha256("whatever"))],
				costTracking: {
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalTokensTruncated: 0,
					estimatedCostUSD: 0,
					lastUpdated: 1,
				},
			})

			const s2 = new MemoryStore(storage, WS, { hostFs })
			const data = await s2.load()
			expect(data.fileContexts).toEqual([])
		})

		it("skips validation (keeps entries unchanged) when no host fs is provided", async () => {
			const storage = new FakeStorage()
			const s1 = new MemoryStore(storage, WS)
			await s1.saveConversation({
				messages: [],
				fileContexts: [fc("unchecked.ts", "anyhash")],
				costTracking: {
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalTokensTruncated: 0,
					estimatedCostUSD: 0,
					lastUpdated: 1,
				},
			})
			// No hostFs → validation is skipped even though the file does not exist.
			const s2 = new MemoryStore(storage, WS)
			const data = await s2.load()
			expect(data.fileContexts.map((f) => f.filePath)).toEqual(["unchecked.ts"])
		})
	})

	it("still evicts observations/qa past their caps (existing behavior)", async () => {
		const store = new MemoryStore(new FakeStorage(), WS, { maxObservations: 2, maxQuestions: 1 })
		await store.recordObservation({ at: 1, kind: "edit", subject: "a" })
		await store.recordObservation({ at: 2, kind: "edit", subject: "b" })
		await store.recordObservation({ at: 3, kind: "edit", subject: "c" })
		await store.recordQa("q1", "a1")
		await store.recordQa("q2", "a2")
		const data = await store.snapshot()
		expect(data.observations.map((o) => o.subject)).toEqual(["b", "c"])
		expect(data.qa.map((q) => q.question)).toEqual(["q2"])
		expect(data.stats.totalObservations).toBe(3)
		expect(data.stats.totalQuestions).toBe(2)
	})

	it("empty() deletes the persisted file and resets to blank defaults on next load", async () => {
		const storage = new FakeStorage()
		const store = new MemoryStore(storage, WS)
		await store.recordObservation({ at: 1, kind: "edit", subject: "a.ts" })
		await store.recordQa("q", "a")
		expect(storage.files.size).toBe(1)

		await store.empty()
		// The persisted document is gone (ctx.storage.delete), and the in-memory cache is dropped.
		expect(storage.files.size).toBe(0)

		const after = await store.snapshot()
		expect(after.observations).toEqual([])
		expect(after.qa).toEqual([])
		expect(after.stats.totalObservations).toBe(0)
		expect(after.stats.totalQuestions).toBe(0)
		expect(after.messages).toEqual([])
	})

	it("empty() is a no-op (never throws) when nothing was persisted yet", async () => {
		const store = new MemoryStore(new FakeStorage(), WS)
		await expect(store.empty()).resolves.toBeUndefined()
	})
})
