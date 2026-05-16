import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import { ConversationStore, emptyConversation } from "../conversation-store"
import type { AgentMessage, FileContextEntry } from "@shofer/types"

let tmpDir: string

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-agent-store-"))
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

const makeMsg = (role: AgentMessage["role"], content: string): AgentMessage => ({
	id: `${role}-${Math.random()}`,
	role,
	content,
	timestamp: 1,
})

describe("ConversationStore", () => {
	it("returns an empty snapshot when no file exists", async () => {
		const store = new ConversationStore(tmpDir, tmpDir)
		const snapshot = await store.load()
		expect(snapshot.messages).toEqual([])
		expect(snapshot.fileContexts).toEqual([])
	})

	it("round-trips messages through save/load", async () => {
		const store = new ConversationStore(tmpDir, tmpDir)
		const snapshot = emptyConversation()
		snapshot.messages = [makeMsg("user", "hi"), makeMsg("assistant", "hello")]
		await store.save(snapshot)

		const loaded = await store.load()
		expect(loaded.messages).toEqual(snapshot.messages)
	})

	it("evicts file contexts whose hash no longer matches", async () => {
		// Create a real file inside the workspace dir.
		const filePath = path.join(tmpDir, "code.ts")
		await fs.writeFile(filePath, "original content", "utf-8")

		const store = new ConversationStore(tmpDir, tmpDir)
		const snapshot = emptyConversation()
		const stale: FileContextEntry = {
			filePath: "code.ts",
			contentHash: "deadbeef", // wrong hash
			tokenEstimate: 4,
			loadedAt: 1,
			lastReferencedAt: 1,
		}
		snapshot.fileContexts = [stale]
		await store.save(snapshot)

		const loaded = await store.load()
		expect(loaded.fileContexts).toEqual([])
	})

	it("evicts file contexts whose source file is missing", async () => {
		const store = new ConversationStore(tmpDir, tmpDir)
		const snapshot = emptyConversation()
		snapshot.fileContexts = [
			{
				filePath: "does-not-exist.ts",
				contentHash: "abc",
				tokenEstimate: 1,
				loadedAt: 1,
				lastReferencedAt: 1,
			},
		]
		await store.save(snapshot)

		const loaded = await store.load()
		expect(loaded.fileContexts).toEqual([])
	})

	it("creates the parent directory on save if needed", async () => {
		const nested = path.join(tmpDir, "nested", "deep")
		const store = new ConversationStore(tmpDir, nested)
		await store.save(emptyConversation())
		const stats = await fs.stat(nested)
		expect(stats.isDirectory()).toBe(true)
	})

	it("places the file at <storage>/shofer-assistant-agent-<hash>.json", async () => {
		const store = new ConversationStore(tmpDir, tmpDir)
		expect(store.filePath).toMatch(/shofer-assistant-agent-[0-9a-f]{16}\.json$/)
	})
})
