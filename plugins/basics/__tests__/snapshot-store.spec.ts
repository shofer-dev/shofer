import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"

import { FileSnapshotStore } from "../src/file-changes/snapshot-store.js"

/**
 * The store is what makes revert possible, so these specs pin the two properties the
 * feature actually rests on: the baseline is captured **once** (the first edit, not the
 * last), and every read resolves against the **task's** working directory — a worktree
 * task's files are not under the workspace root, and resolving against the wrong tree
 * is what made the old change list silently under-report.
 */

let root: string
let workspace: string
let storage: string

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "file-changes-store-"))
	workspace = path.join(root, "workspace")
	storage = path.join(root, "storage")
	await fs.mkdir(workspace, { recursive: true })
	await fs.mkdir(storage, { recursive: true })
})

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

function makeStore(cwd = workspace) {
	return new FileSnapshotStore(storage, "task-1", cwd)
}

describe("FileSnapshotStore", () => {
	it("captures the baseline once, so later edits cannot overwrite it", async () => {
		const store = makeStore()

		await store.captureOriginal("a.ts", "first")
		await store.captureOriginal("a.ts", "second")

		// "second" is the agent's OWN output; if it became the baseline, reverting would
		// restore the agent's work instead of undoing it.
		expect(await store.getBaseContent("a.ts")).toBe("first")
	})

	it("records a file that did not exist as absent, with no base copy", async () => {
		const store = makeStore()

		await store.captureOriginal("new.ts", undefined)

		expect((await store.getOriginalSnapshot("new.ts"))?.kind).toBe("absent")
		expect(await store.getBaseContent("new.ts")).toBeUndefined()
	})

	it("captures the produced state from the task's cwd, not the workspace root", async () => {
		// The same relative path exists in both trees with different content.
		const worktree = path.join(root, "worktree")
		await fs.mkdir(worktree, { recursive: true })
		await fs.writeFile(path.join(workspace, "a.ts"), "main checkout", "utf8")
		await fs.writeFile(path.join(worktree, "a.ts"), "worktree edit", "utf8")

		const store = makeStore(worktree)
		await store.captureFinal("a.ts")

		expect(await store.getFinalContent("a.ts")).toBe("worktree edit")
	})

	it("follows the task when it moves to another working directory", async () => {
		const worktree = path.join(root, "worktree2")
		await fs.mkdir(worktree, { recursive: true })
		await fs.writeFile(path.join(worktree, "a.ts"), "moved", "utf8")

		const store = makeStore()
		store.reassignCwd(worktree)
		await store.captureFinal("a.ts")

		expect(await store.getFinalContent("a.ts")).toBe("moved")
	})

	it("drops the produced copy when the tool deleted the file", async () => {
		await fs.writeFile(path.join(workspace, "gone.ts"), "here", "utf8")
		const store = makeStore()
		await store.captureFinal("gone.ts")
		expect(await store.getFinalContent("gone.ts")).toBe("here")

		await fs.unlink(path.join(workspace, "gone.ts"))
		await store.captureFinal("gone.ts")

		// A stale copy would make the diff claim content that no longer exists.
		expect((await store.getFinalSnapshot("gone.ts"))?.kind).toBe("absent")
		expect(await store.getFinalContent("gone.ts")).toBeUndefined()
	})

	it("lists every path it touched, most recent first", async () => {
		const store = makeStore()
		await store.captureOriginal("first.ts", "a")
		await new Promise((resolve) => setTimeout(resolve, 10))
		await store.captureOriginal("second.ts", "b")

		expect(await store.candidates()).toEqual(["second.ts", "first.ts"])
	})

	it("lists a path that has only a produced state — a generated file with no baseline", async () => {
		await fs.writeFile(path.join(workspace, "image.png"), "bytes", "utf8")
		const store = makeStore()
		await store.captureFinal("image.png")

		expect(await store.candidates()).toEqual(["image.png"])
	})

	it("promotes content to the baseline and forgets the produced state (accept)", async () => {
		const store = makeStore()
		await store.captureOriginal("a.ts", "old")
		await fs.writeFile(path.join(workspace, "a.ts"), "new", "utf8")
		await store.captureFinal("a.ts")

		await store.overwriteOriginalBase("a.ts", "new")
		await store.removeFinalSnapshot("a.ts")

		expect(await store.getBaseContent("a.ts")).toBe("new")
		expect(await store.getFinalSnapshot("a.ts")).toBeUndefined()
	})

	it("keeps each task's copies apart", async () => {
		const one = new FileSnapshotStore(storage, "task-1", workspace)
		const two = new FileSnapshotStore(storage, "task-2", workspace)

		await one.captureOriginal("a.ts", "one's view")
		await two.captureOriginal("a.ts", "two's view")

		expect(await one.getBaseContent("a.ts")).toBe("one's view")
		expect(await two.getBaseContent("a.ts")).toBe("two's view")
	})
})
