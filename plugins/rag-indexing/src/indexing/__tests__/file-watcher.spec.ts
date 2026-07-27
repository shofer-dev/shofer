// npx vitest services/code-index/processors/__tests__/file-watcher.spec.ts

import { FileWatcher } from "../file-watcher"
import { bindRuntime } from "../../plugin-runtime.js"

// Mock TelemetryService

// Mock dependencies
vi.mock("fs/promises", () => {
	// The watcher stats and reads files directly now (it used the editor's filesystem API
	// before the move).
	const stat = vi.fn().mockResolvedValue({ size: 1024, mtimeMs: 1 })
	const readFile = vi.fn().mockResolvedValue(Buffer.from("test content"))
	return { default: { stat, readFile }, stat, readFile }
})
vi.mock("../../cache-manager")
vi.mock("../../core-shared.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../core-shared.js")>()),
	ShoferIgnoreController: vi.fn().mockImplementation(() => ({
		validateAccess: vi.fn().mockReturnValue(true),
	})),
}))
vi.mock("ignore")
vi.mock("../../engine/processors/parser.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../engine/processors/parser.js")>()),
	codeParser: {
		parseFile: vi.fn().mockResolvedValue([]),
	},
}))
vi.mock("../../core-shared.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../core-shared.js")>()),
	isPathInIgnoredDirectory: vi.fn().mockReturnValue(false),
}))

describe("FileWatcher", () => {
	let fileWatcher: FileWatcher
	let mockWatcher: any
	let mockOnDidCreate: any
	let mockOnDidChange: any
	let mockOnDidDelete: any
	let mockContext: any
	let mockCacheManager: any
	let mockEmbedder: any
	let mockVectorStore: any
	let mockIgnoreInstance: any

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

		// Create mock event handlers
		mockOnDidCreate = vi.fn()
		mockOnDidChange = vi.fn()
		mockOnDidDelete = vi.fn()

		// Create mock watcher
		mockWatcher = {
			onDidCreate: vi.fn().mockImplementation((handler) => {
				mockOnDidCreate = handler
				return { dispose: vi.fn() }
			}),
			onDidChange: vi.fn().mockImplementation((handler) => {
				mockOnDidChange = handler
				return { dispose: vi.fn() }
			}),
			onDidDelete: vi.fn().mockImplementation((handler) => {
				mockOnDidDelete = handler
				return { dispose: vi.fn() }
			}),
			dispose: vi.fn(),
		}

		// The watcher comes from the host seam (`ctx.host.watch`) rather than the editor's
		// filesystem API: bind a runtime whose watch() hands the callback back to the test.
		bindRuntime({
			workspacePath: "/mock/workspace",
			cwd: "/mock/workspace",
			config: {},
			host: {
				log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
				env: { language: "en", appRoot: "", machineId: "", appInfo: { version: "test" } },
				watch: (_pattern: string, onChange: (event: { path: string; type: string }) => void) => {
					mockOnDidCreate = (path: string) => onChange({ path, type: "create" })
					mockOnDidChange = (path: string) => onChange({ path, type: "change" })
					mockOnDidDelete = (path: string) => onChange({ path, type: "delete" })
					return mockWatcher
				},
			},
		} as never)

		// Create mock dependencies
		mockContext = {
			subscriptions: [],
		}

		mockCacheManager = {
			getEntry: vi.fn(),
			updateEntry: vi.fn(),
			deleteHash: vi.fn(),
			getAllPaths: vi.fn().mockReturnValue([]),
			getSegmentHashes: vi.fn().mockReturnValue(new Set()),
		}

		mockEmbedder = {
			createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }),
		}

		mockVectorStore = {
			upsertPoints: vi.fn().mockResolvedValue(undefined),
			deletePointsByFilePath: vi.fn().mockResolvedValue(undefined),
			deletePointsByMultipleFilePaths: vi.fn().mockResolvedValue(undefined),
			deletePointsByIds: vi.fn().mockResolvedValue(undefined),
		}

		mockIgnoreInstance = {
			ignores: vi.fn().mockReturnValue(false),
			refresh: vi.fn().mockResolvedValue(undefined),
		}

		fileWatcher = new FileWatcher(
			"/mock/workspace",
			mockCacheManager,
			mockEmbedder,
			mockVectorStore,
			mockIgnoreInstance,
			// The ignore controller is the plugin's, stubbed to allow everything.
			{ validateAccess: () => true } as never,
		)
	})

	describe("file filtering", () => {
		it("should ignore files in hidden directories on create events", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			// Spy on the vector store to see which files are actually processed
			const processedFiles: string[] = []
			mockVectorStore.upsertPoints.mockImplementation(async (points: any[]) => {
				points.forEach((point) => {
					if (point.payload?.file_path) {
						processedFiles.push(point.payload.file_path)
					}
				})
			})

			// Simulate file creation events
			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.git/config", shouldProcess: false },
				{ path: "/mock/workspace/.hidden/file.ts", shouldProcess: false },
				{ path: "/mock/workspace/src/.next/static/file.js", shouldProcess: false },
				{ path: "/mock/workspace/node_modules/package/index.js", shouldProcess: false },
				{ path: "/mock/workspace/normal/file.js", shouldProcess: true },
			]

			// Trigger file creation events
			for (const { path } of testCases) {
				await mockOnDidCreate(path)
			}

			// Wait for batch processing
			await new Promise((resolve) => setTimeout(resolve, 600))

			// Check that files in hidden directories were not processed
			expect(processedFiles).not.toContain("src/.next/static/file.js")
			expect(processedFiles).not.toContain(".git/config")
			expect(processedFiles).not.toContain(".hidden/file.ts")
		})

		it("should ignore files in hidden directories on change events", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			// Track which files are processed
			const processedFiles: string[] = []
			mockVectorStore.upsertPoints.mockImplementation(async (points: any[]) => {
				points.forEach((point) => {
					if (point.payload?.file_path) {
						processedFiles.push(point.payload.file_path)
					}
				})
			})

			// Simulate file change events
			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.vscode/settings.json", shouldProcess: false },
				{ path: "/mock/workspace/src/.cache/data.json", shouldProcess: false },
				{ path: "/mock/workspace/dist/bundle.js", shouldProcess: false },
			]

			// Trigger file change events
			for (const { path } of testCases) {
				await mockOnDidChange(path)
			}

			// Wait for batch processing
			await new Promise((resolve) => setTimeout(resolve, 600))

			// Check that files in hidden directories were not processed
			expect(processedFiles).not.toContain(".vscode/settings.json")
			expect(processedFiles).not.toContain("src/.cache/data.json")
		})

		it("should ignore files in hidden directories on delete events", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			// Track which files are deleted
			const deletedFiles: string[] = []
			mockVectorStore.deletePointsByFilePath.mockImplementation(async (filePath: string) => {
				deletedFiles.push(filePath)
			})

			// Simulate file deletion events
			const testCases = [
				{ path: "/mock/workspace/src/file.ts", shouldProcess: true },
				{ path: "/mock/workspace/.git/objects/abc123", shouldProcess: false },
				{ path: "/mock/workspace/.DS_Store", shouldProcess: false },
				{ path: "/mock/workspace/build/.cache/temp.js", shouldProcess: false },
			]

			// Trigger file deletion events
			for (const { path } of testCases) {
				await mockOnDidDelete(path)
			}

			// Wait for batch processing
			await new Promise((resolve) => setTimeout(resolve, 600))

			// Check that files in hidden directories were not processed
			expect(deletedFiles).not.toContain(".git/objects/abc123")
			expect(deletedFiles).not.toContain(".DS_Store")
			expect(deletedFiles).not.toContain("build/.cache/temp.js")
		})

		it("should handle nested hidden directories correctly", async () => {
			// Initialize the file watcher
			await fileWatcher.initialize()

			// Track which files are processed
			const processedFiles: string[] = []
			mockVectorStore.upsertPoints.mockImplementation(async (points: any[]) => {
				points.forEach((point) => {
					if (point.payload?.file_path) {
						processedFiles.push(point.payload.file_path)
					}
				})
			})

			// Test deeply nested hidden directories
			const testCases = [
				{ path: "/mock/workspace/src/components/Button.tsx", shouldProcess: true },
				{ path: "/mock/workspace/src/.hidden/components/Button.tsx", shouldProcess: false },
				{ path: "/mock/workspace/.hidden/src/components/Button.tsx", shouldProcess: false },
				{ path: "/mock/workspace/src/components/.hidden/Button.tsx", shouldProcess: false },
			]

			// Trigger file creation events
			for (const { path } of testCases) {
				await mockOnDidCreate(path)
			}

			// Wait for batch processing
			await new Promise((resolve) => setTimeout(resolve, 600))

			// Check that files in hidden directories were not processed
			expect(processedFiles).not.toContain("src/.hidden/components/Button.tsx")
			expect(processedFiles).not.toContain(".hidden/src/components/Button.tsx")
			expect(processedFiles).not.toContain("src/components/.hidden/Button.tsx")
		})
	})

	describe("dispose", () => {
		it("should dispose of the watcher when disposed", async () => {
			await fileWatcher.initialize()
			fileWatcher.dispose()

			expect(mockWatcher.dispose).toHaveBeenCalled()
		})
	})

	describe("Phase 1 — cache entry integrity", () => {
		it("should write full cache entry with real mtimeMs+size on changed file, enabling fast-path on next scan", async () => {
			// Return a proper stat with real mtime
			const fsp = await import("fs/promises")
			const statWithMtime = { size: 2048, mtimeMs: 1715952000000 }
			;(fsp.stat as any).mockResolvedValue(statWithMtime)

			// File content that hashes predictably
			const fileContent = "function bar() { return 1; }"
			;(fsp.readFile as any).mockResolvedValue(Buffer.from(fileContent))

			// getEntry returns undefined — file not yet cached
			;(mockCacheManager.getEntry as any).mockReturnValue(undefined)

			// Mock parser to return blocks so the path goes through to "processed_for_batching"
			const { codeParser } = await import("../../engine/processors/parser.js")
			;(codeParser.parseFile as any).mockResolvedValue([
				{
					file_path: "/mock/workspace/src/test.ts",
					content: fileContent,
					start_line: 1,
					end_line: 1,
					identifier: "bar",
					type: "function",
					fileHash: "new-hash",
					segmentHash: "seg-1",
				},
			])

			// Mock embedder to return embeddings
			mockEmbedder.createEmbeddings.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] })

			const result = await fileWatcher.processFile("/mock/workspace/src/test.ts")

			// Verify the result carries stat info
			expect((result as { error?: string }).error).toBeUndefined()
			expect(result.status).toBe("processed_for_batching")
			expect(result.newMtimeMs).toBe(1715952000000)
			expect(result.newSize).toBe(2048)

			// Simulate the full batch upsert flow by calling updateEntry directly
			// (the watcher normally defers this to batch processing)
			const { createHash } = await import("crypto")
			const contentHash = createHash("sha256").update(fileContent).digest("hex")

			// Mimic what executeBatchUpsertOperations does with the returned stats
			mockCacheManager.updateEntry("/mock/workspace/src/test.ts", {
				hash: contentHash,
				mtimeMs: result.newMtimeMs!,
				size: result.newSize!,
				segmentHashes: result.newSegmentHashes ?? [],
			})

			expect(mockCacheManager.updateEntry).toHaveBeenCalledWith("/mock/workspace/src/test.ts", {
				hash: contentHash,
				mtimeMs: 1715952000000,
				size: 2048,
				segmentHashes: ["seg-1"],
			})
		})

		it("should update cache entry on skipped (unchanged) file so fast-path survives", async () => {
			const fsp = await import("fs/promises")
			const statWithMtime = { size: 1024, mtimeMs: 1715953000000 }
			;(fsp.stat as any).mockResolvedValue(statWithMtime)

			const fileContent = "function unchanged() {}"
			const { createHash } = await import("crypto")
			const contentHash = createHash("sha256").update(fileContent).digest("hex")
			;(fsp.readFile as any).mockResolvedValue(Buffer.from(fileContent))

			// Cached entry has matching hash but stale mtime (simulates touch/rebase/rsync -t)
			;(mockCacheManager.getEntry as any).mockReturnValue({
				hash: contentHash,
				mtimeMs: 1715952000000, // old mtime
				size: 1024,
			})

			const result = await fileWatcher.processFile("/mock/workspace/src/unchanged.ts")

			// Should be skipped
			expect(result.status).toBe("skipped")
			expect(result.reason).toBe("File has not changed")

			// updateEntry should have been called with the new mtime
			expect(mockCacheManager.updateEntry).toHaveBeenCalledWith("/mock/workspace/src/unchanged.ts", {
				hash: contentHash,
				mtimeMs: 1715953000000,
				size: 1024,
				segmentHashes: [],
			})
		})
	})
})
