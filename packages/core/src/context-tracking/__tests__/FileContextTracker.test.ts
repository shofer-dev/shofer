/**
 * Integration tests for FileContextTracker: what it records in the task metadata, and
 * what it publishes to plugins.
 *
 * The tracker keeps no file copies — the file-changes plugin does — so the contract
 * under test is the pair of hooks it fires and, critically, the **cwd** it fires them
 * with: an embedded-worktree task's files are not under the VS Code workspace folder,
 * and resolving against the wrong tree is what made `get_changed_files` silently
 * under-report changes before the cwd was threaded through.
 *
 * Real temp directories (no fs mocks), so path resolution is exercised end-to-end.
 */

import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { FileContextTracker } from "../FileContextTracker.js"
import { pluginRegistry } from "../../plugins/plugin-registry.js"
import { GlobalFileNames } from "../../shared/globalFileNames.js"

/** Minimal provider stub: only exposes globalStorageUri.fsPath. */
function makeProviderStub(storageDir: string) {
	return {
		context: { globalStorageUri: { fsPath: storageDir } },
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

describe("FileContextTracker — publishing edits to plugins", () => {
	let tree: Awaited<ReturnType<typeof setupTree>>

	beforeEach(async () => {
		tree = await setupTree()
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	afterEach(async () => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
		await tree.cleanup()
	})

	/** Records what a file-tracking plugin would be told. */
	function registerRecorder() {
		const before: { path: string; content?: string; cwd?: string }[] = []
		const after: { path: string; cwd?: string }[] = []
		void pluginRegistry.register(
			{
				name: "recorder",
				lifecycle: {
					beforeFileEdit: (edit, ctx) => {
						before.push({ path: edit.path, content: edit.before, cwd: ctx.cwd })
					},
					afterFileEdit: (edit, ctx) => {
						after.push({ path: edit.path, cwd: ctx.cwd })
					},
				},
			},
			{},
			{ lifecycle: true },
		)
		return { before, after }
	}

	function makeTracker(taskId: string, cwd = tree.worktree) {
		const provider = makeProviderStub(tree.storage)
		return new FileContextTracker(
			provider as unknown as ConstructorParameters<typeof FileContextTracker>[0],
			taskId,
			cwd,
		)
	}

	it("hands the pre-edit content to plugins, with the task's own cwd", async () => {
		const recorder = registerRecorder()
		const tracker = makeTracker("task-1")

		await tracker.captureOriginal("existing.txt", "worktree-original\n")

		// The cwd matters: a worktree task's files are NOT under the workspace folder,
		// so a plugin resolving against the wrong tree would snapshot the wrong file.
		expect(recorder.before).toEqual([{ path: "existing.txt", content: "worktree-original\n", cwd: tree.worktree }])
	})

	it("passes `undefined` content for a file that does not exist yet", async () => {
		const recorder = registerRecorder()
		const tracker = makeTracker("task-1")

		await tracker.captureOriginal("new-file.ts", undefined)

		expect(recorder.before).toEqual([{ path: "new-file.ts", content: undefined, cwd: tree.worktree }])
	})

	it("tells plugins about the edit after tracking it", async () => {
		const recorder = registerRecorder()
		const tracker = makeTracker("task-1")

		await tracker.trackFileContext("edited.js", "shofer_edited")
		// The notification is fire-and-forget so the tool never waits on a plugin.
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(recorder.after).toEqual([{ path: "edited.js", cwd: tree.worktree }])
	})

	it("says nothing for a file the USER edited — plugins track the agent's work", async () => {
		const recorder = registerRecorder()
		const tracker = makeTracker("task-1")

		await tracker.trackFileContext("user-edited.js", "user_edited")
		await tracker.trackFileContext("read.js", "read_tool")
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(recorder.after).toEqual([])
	})

	it("follows the task to a new working directory", async () => {
		const recorder = registerRecorder()
		const tracker = makeTracker("task-1")

		const worktree2 = path.join(tree.root, "worktree2")
		await fs.mkdir(worktree2, { recursive: true })
		tracker.reassignCwd(worktree2)
		await tracker.captureOriginal("moved.txt", "x")

		expect(recorder.before[0]!.cwd).toBe(worktree2)
	})

	it("never lets a failing plugin reach the tool", async () => {
		void pluginRegistry.register(
			{
				name: "broken",
				lifecycle: {
					beforeFileEdit: () => {
						throw new Error("plugin exploded")
					},
					afterFileEdit: () => {
						throw new Error("plugin exploded")
					},
				},
			},
			{},
			{ lifecycle: true },
		)
		const tracker = makeTracker("task-1")

		await expect(tracker.captureOriginal("existing.txt", "x")).resolves.toBeUndefined()
		await expect(tracker.trackFileContext("existing.txt", "shofer_edited")).resolves.toBeUndefined()
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
