import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"

import { FileSnapshotStore } from "../src/snapshot-store.js"
import { acceptFile, getChangedFiles, getOriginalContent, restoreFile } from "../src/changed-files.js"

/**
 * The change list is what the user reads before deciding whether to keep the agent's
 * work, so what matters is that it says the truth about **this task's** effect: exact
 * counts, no entries for work that cancelled itself out, and nothing borrowed from the
 * live file (which another task may have written).
 */

let root: string
let workspace: string
let storage: string

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "file-changes-list-"))
	workspace = path.join(root, "workspace")
	storage = path.join(root, "storage")
	await fs.mkdir(workspace, { recursive: true })
	await fs.mkdir(storage, { recursive: true })
})

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

const store = () => new FileSnapshotStore(storage, "task-1", workspace)
const write = (relPath: string, content: string) => fs.writeFile(path.join(workspace, relPath), content, "utf8")

/** Simulate an agent edit: baseline, write, produced state — what the hooks do. */
async function edit(s: FileSnapshotStore, relPath: string, before: string | undefined, after: string | undefined) {
	await s.captureOriginal(relPath, before)
	if (after === undefined) {
		await fs.rm(path.join(workspace, relPath), { force: true })
	} else {
		await write(relPath, after)
	}
	await s.captureFinal(relPath)
}

describe("getChangedFiles", () => {
	it("counts insertions and deletions from a real diff", async () => {
		const s = store()
		await write("a.ts", "one\ntwo\n")
		await edit(s, "a.ts", "one\ntwo\n", "one\ntwo\nthree\n")

		const { entries } = await getChangedFiles(s, workspace)
		expect(entries).toEqual([
			expect.objectContaining({ path: "a.ts", insertions: 1, deletions: 0, state: "modified" }),
		])
	})

	it("reports a created file as added", async () => {
		const s = store()
		await edit(s, "new.ts", undefined, "a\nb\n")

		const { entries } = await getChangedFiles(s, workspace)
		expect(entries).toEqual([expect.objectContaining({ path: "new.ts", state: "added", insertions: 2 })])
	})

	it("reports a removed file as deleted", async () => {
		const s = store()
		await write("gone.ts", "a\nb\n")
		await edit(s, "gone.ts", "a\nb\n", undefined)

		const { entries } = await getChangedFiles(s, workspace)
		expect(entries).toEqual([expect.objectContaining({ path: "gone.ts", state: "deleted", deletions: 2 })])
	})

	it("drops a file the task changed and then changed back", async () => {
		const s = store()
		await write("a.ts", "same\n")
		await edit(s, "a.ts", "same\n", "different\n")
		await edit(s, "a.ts", "same\n", "same\n") // the baseline is already fixed

		expect((await getChangedFiles(s, workspace)).entries).toEqual([])
	})

	it("drops a file the task created and then deleted", async () => {
		const s = store()
		await edit(s, "temp.ts", undefined, "scratch\n")
		await edit(s, "temp.ts", undefined, undefined)

		expect((await getChangedFiles(s, workspace)).entries).toEqual([])
	})

	it("drops a file the user reverted by hand", async () => {
		const s = store()
		await write("a.ts", "original\n")
		await edit(s, "a.ts", "original\n", "agent's version\n")
		expect((await getChangedFiles(s, workspace)).entries).toHaveLength(1)

		await write("a.ts", "original\n")

		// The live file matching the baseline is the one thing the live file decides.
		expect((await getChangedFiles(s, workspace)).entries).toEqual([])
	})

	it("ignores another task's edit to the same file", async () => {
		const s = store()
		await write("shared.ts", "base\n")
		await edit(s, "shared.ts", "base\n", "this task's line\n")

		// A parallel task writes the same file in the same worktree.
		await write("shared.ts", "base\nsomeone else's ten\nlines\nof\nwork\n")

		// The counts still describe THIS task's change (base ↔ its own final).
		const { entries } = await getChangedFiles(s, workspace)
		expect(entries).toEqual([expect.objectContaining({ path: "shared.ts", insertions: 1, deletions: 1 })])
	})

	it("keeps a file with no baseline in the list, but marks it undiffable", async () => {
		const s = store()
		// A tool that produced content without capturing a baseline (a generated image).
		await write("image.png", "bytes\n")
		await s.captureFinal("image.png")

		const { entries } = await getChangedFiles(s, workspace)
		expect(entries).toEqual([expect.objectContaining({ path: "image.png", hasOriginalContent: false })])
	})
})

describe("revert and accept", () => {
	it("puts the file back and leaves the produced state intact", async () => {
		const s = store()
		await write("a.ts", "original\n")
		await edit(s, "a.ts", "original\n", "changed\n")

		await restoreFile(s, workspace, "a.ts")

		expect(await fs.readFile(path.join(workspace, "a.ts"), "utf8")).toBe("original\n")
		// The produced state survives — it is the record of what the agent did.
		expect((await s.getFinalSnapshot("a.ts"))?.kind).toBe("text")
	})

	it("deletes a file the task created", async () => {
		const s = store()
		await edit(s, "new.ts", undefined, "content\n")

		await restoreFile(s, workspace, "new.ts")

		await expect(fs.access(path.join(workspace, "new.ts"))).rejects.toThrow()
	})

	it("refuses to revert a file it never captured", async () => {
		const s = store()
		await expect(restoreFile(s, workspace, "unknown.ts")).rejects.toThrow(/No baseline/)
	})

	it("accepting takes the file off the list", async () => {
		const s = store()
		await write("a.ts", "original\n")
		await edit(s, "a.ts", "original\n", "changed\n")

		await acceptFile(s, workspace, "a.ts")

		expect((await getChangedFiles(s, workspace)).entries).toEqual([])
		expect(await getOriginalContent(s, "a.ts")).toBe("changed\n")
	})

	it("accepts what is on disk, not what the agent wrote", async () => {
		const s = store()
		await write("a.ts", "original\n")
		await edit(s, "a.ts", "original\n", "agent wrote this\n")
		// A formatter (or the user) rewrote the file after the agent's write.
		await write("a.ts", "formatter rewrote this\n")

		await acceptFile(s, workspace, "a.ts")

		// Promoting the agent's stale copy would leave a mismatch and the entry would
		// come straight back, needing a second click.
		expect(await getOriginalContent(s, "a.ts")).toBe("formatter rewrote this\n")
		expect((await getChangedFiles(s, workspace)).entries).toEqual([])
	})
})
