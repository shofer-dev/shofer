import type { Mock } from "vitest"
import * as vscode from "vscode"
import { createHash } from "crypto"
import debounce from "lodash.debounce"
import { CacheManager } from "../cache-manager"

// Mock safeWriteJson utility
vitest.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vitest.fn().mockResolvedValue(undefined),
}))

// Import the mocked version
import { safeWriteJson } from "../../../utils/safeWriteJson"

// Mock vscode
vitest.mock("vscode", () => {
	class EventEmitter<T> {
		listeners: Array<(e: T) => void> = []
		event = (l: (e: T) => void) => {
			this.listeners.push(l)
			return { dispose: () => {} }
		}
		fire = (e: T) => this.listeners.forEach((l) => l(e))
		dispose = () => {
			this.listeners = []
		}
	}
	return {
		Uri: {
			joinPath: vitest.fn(),
		},
		workspace: {
			fs: {
				readFile: vitest.fn(),
				writeFile: vitest.fn(),
				delete: vitest.fn(),
			},
		},
		EventEmitter,
	}
})

// Mock debounce to execute immediately
vitest.mock("lodash.debounce", () => ({ default: vitest.fn((fn) => fn) }))

// Mock TelemetryService
vitest.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vitest.fn(),
		},
	},
}))

// Build a valid v2 cache payload for tests
function makeV3Cache(
	entries: Record<string, { hash: string; mtimeMs?: number; size?: number; segmentHashes?: string[] }>,
) {
	const result: Record<string, { hash: string; mtimeMs: number; size: number; segmentHashes: string[] }> = {}
	for (const [path, entry] of Object.entries(entries)) {
		result[path] = {
			hash: entry.hash,
			mtimeMs: entry.mtimeMs ?? 1234567890000,
			size: entry.size ?? 1024,
			segmentHashes: entry.segmentHashes ?? [],
		}
	}
	return { version: 3, entries: result }
}

describe("CacheManager", () => {
	let mockContext: vscode.ExtensionContext
	let mockWorkspacePath: string
	let mockCachePath: vscode.Uri
	let cacheManager: CacheManager

	beforeEach(() => {
		// Reset all mocks
		vitest.clearAllMocks()

		// Mock context
		mockWorkspacePath = "/mock/workspace"
		mockCachePath = { fsPath: "/mock/storage/cache.json" } as vscode.Uri
		mockContext = {
			globalStorageUri: { fsPath: "/mock/storage" } as vscode.Uri,
		} as vscode.ExtensionContext

		// Mock Uri.joinPath
		;(vscode.Uri.joinPath as Mock).mockReturnValue(mockCachePath)

		// Create cache manager instance
		cacheManager = new CacheManager(mockContext, mockWorkspacePath)
	})

	describe("constructor", () => {
		it("should correctly set up cachePath using Uri.joinPath and crypto.createHash", () => {
			const expectedHash = createHash("sha256").update(mockWorkspacePath).digest("hex")

			expect(vscode.Uri.joinPath).toHaveBeenCalledWith(
				mockContext.globalStorageUri,
				`shofer-index-cache-${expectedHash}.json`,
			)
		})

		it("should set up debounced save function", () => {
			expect(debounce).toHaveBeenCalledWith(expect.any(Function), 1500)
		})
	})

	describe("initialize", () => {
		it("should load existing v3 cache file successfully", async () => {
			const mockEntries = {
				"file1.ts": { hash: "hash1", mtimeMs: 100, size: 200, segmentHashes: [] },
				"file2.ts": { hash: "hash2", mtimeMs: 300, size: 400, segmentHashes: [] },
			}
			const mockPayload = makeV3Cache(mockEntries)
			const mockBuffer = Buffer.from(JSON.stringify(mockPayload))
			;(vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockBuffer)

			await cacheManager.initialize()

			expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(mockCachePath)

			// getEntry returns full entry
			expect(cacheManager.getEntry("file1.ts")).toEqual(mockEntries["file1.ts"])
			expect(cacheManager.getEntry("file2.ts")).toEqual(mockEntries["file2.ts"])

			// getAllPaths returns keys
			expect(cacheManager.getAllPaths()).toEqual(["file1.ts", "file2.ts"])
		})

		it("should discard cache on version mismatch (old v1 format)", async () => {
			const oldCache = { "file1.ts": "hash1", "file2.ts": "hash2" }
			const mockBuffer = Buffer.from(JSON.stringify(oldCache))
			;(vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockBuffer)

			await cacheManager.initialize()

			// Schema mismatch → entries should be empty
			expect(cacheManager.getEntry("file1.ts")).toBeUndefined()
			expect(cacheManager.getAllPaths()).toEqual([])
		})

		it("should discard cache on parse failure (corrupted JSON)", async () => {
			const mockBuffer = Buffer.from("{ not valid json")
			;(vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockBuffer)

			// Should not throw
			await cacheManager.initialize()

			expect(cacheManager.getEntry("file1.ts")).toBeUndefined()
			expect(cacheManager.getAllPaths()).toEqual([])
		})

		it("should handle missing cache file by creating empty cache", async () => {
			;(vscode.workspace.fs.readFile as Mock).mockRejectedValue(new Error("File not found"))

			await cacheManager.initialize()

			expect(cacheManager.getEntry("file1.ts")).toBeUndefined()
			expect(cacheManager.getAllPaths()).toEqual([])
		})
	})

	describe("entry management (v3)", () => {
		it("should update entry and trigger save with proper version wrapper", () => {
			const filePath = "test.ts"
			const entry = { hash: "testhash", mtimeMs: 1234567890000, size: 2048, segmentHashes: [] }

			cacheManager.updateEntry(filePath, entry)

			expect(cacheManager.getEntry(filePath)).toEqual(entry)
			expect(cacheManager.getAllPaths()).toEqual([filePath])

			// Verify the saved data has version 2 wrapper
			expect(safeWriteJson).toHaveBeenCalled()
			const savedData = (safeWriteJson as Mock).mock.calls[0][1]
			expect(savedData.version).toBe(3)
			expect(savedData.entries[filePath]).toEqual(entry)
		})

		it("should delete entry and trigger save", () => {
			const filePath = "test.ts"
			const entry = { hash: "testhash", mtimeMs: 1234567890000, size: 2048, segmentHashes: [] }

			cacheManager.updateEntry(filePath, entry)
			cacheManager.deleteHash(filePath)

			expect(cacheManager.getEntry(filePath)).toBeUndefined()
			expect(cacheManager.getAllPaths()).toEqual([])
			expect(safeWriteJson).toHaveBeenCalled()
		})

		it("should return undefined for unknown file in getEntry", () => {
			expect(cacheManager.getEntry("nonexistent.ts")).toBeUndefined()
		})

		it("getAllPaths should return all cached paths", () => {
			cacheManager.updateEntry("a.ts", { hash: "h1", mtimeMs: 100, size: 200, segmentHashes: [] })
			cacheManager.updateEntry("b.ts", { hash: "h2", mtimeMs: 300, size: 400, segmentHashes: [] })

			expect(cacheManager.getAllPaths()).toEqual(["a.ts", "b.ts"])
		})
	})

	describe("saving", () => {
		it("should save cache to disk with correct v3 data", async () => {
			cacheManager.updateEntry("test.ts", { hash: "testhash", mtimeMs: 100, size: 200, segmentHashes: [] })

			expect(safeWriteJson).toHaveBeenCalledWith(mockCachePath.fsPath, expect.any(Object))

			const savedData = (safeWriteJson as Mock).mock.calls[0][1]
			expect(savedData).toEqual({
				version: 3,
				entries: { "test.ts": { hash: "testhash", mtimeMs: 100, size: 200, segmentHashes: [] } },
			})
		})

		it("should handle save errors gracefully", async () => {
			;(safeWriteJson as Mock).mockRejectedValue(new Error("Save failed"))

			cacheManager.updateEntry("test.ts", { hash: "hash", mtimeMs: 100, size: 200, segmentHashes: [] })

			// Wait for any pending promises
			await new Promise((resolve) => setTimeout(resolve, 0))
			// Error should be handled silently via the subsystem logger
		})
	})

	describe("clearCacheFile", () => {
		it("should clear cache file and reset state", async () => {
			cacheManager.updateEntry("test.ts", { hash: "hash", mtimeMs: 100, size: 200, segmentHashes: [] })

			// Reset the mock to ensure safeWriteJson succeeds for clearCacheFile
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)

			await cacheManager.clearCacheFile()

			expect(safeWriteJson).toHaveBeenCalledWith(mockCachePath.fsPath, { version: 3, entries: {} })
			expect(cacheManager.getEntry("test.ts")).toBeUndefined()
			expect(cacheManager.getAllPaths()).toEqual([])
		})

		it("should handle clear errors gracefully", async () => {
			;(safeWriteJson as Mock).mockRejectedValue(new Error("Save failed"))

			await cacheManager.clearCacheFile()
			// Error should be handled silently via the subsystem logger
		})
	})
})
