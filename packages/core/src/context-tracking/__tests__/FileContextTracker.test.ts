/**
 * Integration tests for FileContextTracker, focusing on the worktree cwd fix.
 *
 * Regression test for the bug where `get_changed_files` underreported changes
 * in embedded worktrees: the tracker resolved files against the VS Code
 * workspace folder (main checkout) instead of the task's worktree cwd, so
 * `captureFinal` read stale/absent files and `getChangedFiles` skipped them.
 *
 * These tests use real temp directories (no fs mocks) so the cwd resolution
 * is exercised end-to-end.
 */

import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { FileContextTracker } from "../FileContextTracker.js"
import { GlobalFileNames } from "../../shared/globalFileNames.js"

/** Minimal provider stub: only exposes globalStorageUri.fsPath. */
function makeProviderStub(storageDir: string) {
	return {
		context: { globalStorageUri: { fsPath: storageDir } },
		scheduleChangedFilesUpdate: vi.fn(),
	}
}

/**
 * Creates a temp directory tree for a single test:
 *   <root>/main-checkout/         — simulates the VS Code workspace folder
 *   <root>/main-checkout/existing.txt
 *   <root>/worktree/              — simulates the embedded worktree cwd
 *   <root>/worktree/existing.txt  — different content from main-checkout
 *   <root>/storage/               — global storage for task dirs
 */
async function setupTree(): Promise<{
	root: string
	mainCheckout: string
	worktree: string
	storage: string
	cleanup: () => Promise<void>
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "fct-test-"))
	const mainCheckout = path.join(root, "main-checkout")
	const worktree = path.join(root, "worktree")
	const storage = path.join(root, "storage")
	await fs.mkdir(mainCheckout, { recursive: true })
	await fs.mkdir(worktree, { recursive: true })
	await fs.mkdir(storage, { recursive: true })

	// The same relative file exists in BOTH trees but with different content.
	// Before the fix, captureFinal read from mainCheckout (the workspace folder)
	// and saw stale content, causing the change to be dropped.
	await fs.writeFile(path.join(mainCheckout, "existing.txt"), "main-checkout-content\n", "utf8")
	await fs.writeFile(path.join(worktree, "existing.txt"), "worktree-original\n", "utf8")

	return {
		root,
		mainCheckout,
		worktree,
		storage,
		cleanup: async () => {
			await fs.rm(root, { recursive: true, force: true })
		},
	}
}

describe("FileContextTracker — worktree cwd", () => {
	let tree: Awaited<ReturnType<typeof setupTree>>

	beforeEach(async () => {
		tree = await setupTree()
	})

	afterEach(async () => {
		await tree.cleanup()
	})

	it("constructor requires a cwd parameter", () => {
		const provider = makeProviderStub(tree.storage)
		// The cwd arg is mandatory now; passing the worktree path anchors all
		// file reads to the worktree, not the VS Code workspace folder.
		const tracker = new FileContextTracker(
			provider as unknown as ConstructorParameters<typeof FileContextTracker>[0],
			"task-1",
			tree.worktree,
		)
		expect(tracker.taskId).toBe("task-1")
	})

	it("captureFinal reads from the worktree cwd, not the workspace folder", async () => {
		const provider = makeProviderStub(tree.storage)
		const tracker = new FileContextTracker(
			provider as unknown as ConstructorParameters<typeof FileContextTracker>[0],
			"task-1",
			tree.worktree,
		)

		// Simulate Shofer editing existing.txt in the worktree.
		await fs.writeFile(path.join(tree.worktree, "existing.txt"), "worktree-edited\nline2\n", "utf8")

		// captureOriginal: the file existed at "worktree-original" before the edit.
		await tracker.captureOriginal("existing.txt", "worktree-original\n")

		// captureFinal: must read the WORKTREE copy ("worktree-edited\nline2\n"),
		// NOT the main-checkout copy ("main-checkout-content\n").
		await tracker.captureFinal("existing.txt")

		const finalSnap = await tracker.getFinalSnapshot("existing.txt")
		expect(finalSnap).toBeDefined()
		expect(finalSnap!.kind).toBe("text")

		const finalContent = await tracker.getFinalContent("existing.txt")
		expect(finalContent).toBe("worktree-edited\nline2\n")

		// The original snapshot must also reflect the worktree's pre-edit state.
		const origSnap = await tracker.getOriginalSnapshot("existing.txt")
		expect(origSnap).toBeDefined()
		expect(origSnap!.kind).toBe("text")
		const baseContent = await tracker.getBaseContent("existing.txt")
		expect(baseContent).toBe("worktree-original\n")
	})

	it("captureFinal detects a newly-created file in the worktree", async () => {
		const provider = makeProviderStub(tree.storage)
		const tracker = new FileContextTracker(
			provider as unknown as ConstructorParameters<typeof FileContextTracker>[0],
			"task-1",
			tree.worktree,
		)

		// Simulate Shofer creating a brand-new file via write_to_file.
		const newContent = "new file in worktree\nline2\nline3\n"
		await fs.writeFile(path.join(tree.worktree, "new-file.ts"), newContent, "utf8")

		// captureOriginal with undefined content (file did not exist before).
		await tracker.captureOriginal("new-file.ts", undefined)
		await tracker.captureFinal("new-file.ts")

		const origSnap = await tracker.getOriginalSnapshot("new-file.ts")
		expect(origSnap).toBeDefined()
		expect(origSnap!.kind).toBe("absent")

		const finalSnap = await tracker.getFinalSnapshot("new-file.ts")
		expect(finalSnap).toBeDefined()
		expect(finalSnap!.kind).toBe("text")

		const finalContent = await tracker.getFinalContent("new-file.ts")
		expect(finalContent).toBe(newContent)
	})

	it("trackFileContext(shofer_edited) records the edit and captures final from worktree", async () => {
		const provider = makeProviderStub(tree.storage)
		const tracker = new FileContextTracker(
			provider as unknown as ConstructorParameters<typeof FileContextTracker>[0],
			"task-1",
			tree.worktree,
		)

		// Simulate a Shofer edit: write new content, then track it.
		await fs.writeFile(path.join(tree.worktree, "edited.js"), "edited-content\n", "utf8")
		await tracker.captureOriginal("edited.js", undefined)
		await tracker.trackFileContext("edited.js", "shofer_edited")

		// captureFinal is fired asynchronously (best-effort .then in
		// addFileToFileContextTracker). Wait a tick for it to settle.
		await new Promise((resolve) => setTimeout(resolve, 50))

		const edited = await tracker.getFilesEditedByRoo()
		expect(edited).toContain("edited.js")

		const finalSnap = await tracker.getFinalSnapshot("edited.js")
		expect(finalSnap).toBeDefined()
		expect(finalSnap!.kind).toBe("text")
		const finalContent = await tracker.getFinalContent("edited.js")
		expect(finalContent).toBe("edited-content\n")
	})

	it("reassignCwd re-points file reads to a new worktree", async () => {
		const provider = makeProviderStub(tree.storage)
		const tracker = new FileContextTracker(
			provider as unknown as ConstructorParameters<typeof FileContextTracker>[0],
			"task-1",
			tree.worktree,
		)

		// Create a second "worktree" with its own content.
		const worktree2 = path.join(tree.root, "worktree2")
		await fs.mkdir(worktree2, { recursive: true })
		await fs.writeFile(path.join(worktree2, "moved.txt"), "moved-content\n", "utf8")

		// Reassign and verify reads now resolve against worktree2.
		tracker.reassignCwd(worktree2)
		await tracker.captureOriginal("moved.txt", undefined)
		await fs.writeFile(path.join(worktree2, "moved.txt"), "moved-content\nextra\n", "utf8")
		await tracker.captureFinal("moved.txt")

		const finalContent = await tracker.getFinalContent("moved.txt")
		expect(finalContent).toBe("moved-content\nextra\n")
	})
})

describe("FileContextTracker — metadata persistence", () => {
	let tree: Awaited<ReturnType<typeof setupTree>>

	beforeEach(async () => {
		tree = await setupTree()
	})

	afterEach(async () => {
		await tree.cleanup()
	})

	it("persists shofer_edited entries to task_metadata.json", async () => {
		const provider = makeProviderStub(tree.storage)
		const tracker = new FileContextTracker(
			provider as unknown as ConstructorParameters<typeof FileContextTracker>[0],
			"task-persist",
			tree.worktree,
		)

		await tracker.trackFileContext("file-a.ts", "shofer_edited")
		await tracker.trackFileContext("file-b.ts", "shofer_edited")

		const edited = await tracker.getFilesEditedByRoo()
		expect(edited.sort()).toEqual(["file-a.ts", "file-b.ts"])

		// Verify the metadata file exists on disk (the source of truth for
		// getFilesEditedByRoo, independent of in-memory sets).
		const { getTaskDirectoryPath } = await import("../../utils/storage.js")
		const taskDir = await getTaskDirectoryPath(tree.storage, "task-persist")
		const metaPath = path.join(taskDir, GlobalFileNames.taskMetadata)
		const raw = await fs.readFile(metaPath, "utf8")
		const meta = JSON.parse(raw)
		const shoferEdited = meta.files_in_context.filter(
			(e: { record_source: string }) => e.record_source === "shofer_edited",
		)
		expect(shoferEdited.length).toBeGreaterThanOrEqual(2)
	})
})
