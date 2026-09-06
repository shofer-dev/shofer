import { FileTool } from "../FileTool.js"
import {
	makeFakeEditTask,
	makeToolCallbacks,
	makeWorkspace,
	toolResults,
	withWorkspaceRoot,
	type FakeWorkspace,
} from "./helpers/fakeEditTask.js"

/**
 * `file` is the tool that exists BECAUSE a shell `rm`/`mv` bypasses the change
 * pipeline — so every assertion here is about the pipeline, not about the
 * mutation: `captureOriginal` before, `trackFileContext` after, and for a MOVE
 * both endpoints tracked so a revert can resurrect the source and a redo can
 * re-apply the move (the File Change Tracking Pattern in AGENTS.md).
 */

let ws: FakeWorkspace
let restoreHost: () => void

beforeEach(async () => {
	ws = await makeWorkspace("shofer-file-tool-")
	restoreHost = withWorkspaceRoot(ws.cwd)
})

afterEach(async () => {
	restoreHost()
	await ws.cleanup()
})

describe("FileTool — argument validation", () => {
	it.each([
		["subcommand", { subcommand: "chmod", path: "a.ts" }],
		["path", { subcommand: "rm", path: "" }],
		["destination", { subcommand: "mv", path: "a.ts" }],
	])("reports a missing %s as a usage mistake", async (param, params) => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new FileTool().execute(params as any, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(toolResults(cbs)).toContain(`Missing ${param} for file`)
	})
})

describe("FileTool — rm", () => {
	it("captures the original, deletes the file, and tracks the change", async () => {
		await ws.write("a.ts", "content\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new FileTool().execute({ subcommand: "rm", path: "a.ts" }, task, cbs)

		expect(await ws.exists("a.ts")).toBe(false)
		expect(task.fileContextTracker.captureOriginal).toHaveBeenCalledWith("a.ts", "content\n")
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("a.ts", "shofer_edited")
		expect(toolResults(cbs)).toBe("Deleted 'a.ts'.")
	})

	it("refuses a directory unless recursive is set", async () => {
		await ws.write("dir/a.ts", "1")
		const cbs = makeToolCallbacks()

		await new FileTool().execute({ subcommand: "rm", path: "dir" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(await ws.exists("dir/a.ts")).toBe(true)
		expect(toolResults(cbs)).toContain("pass recursive=true")
	})

	it("tracks every contained file when deleting a tree recursively", async () => {
		await ws.write("dir/a.ts", "1")
		await ws.write("dir/sub/b.ts", "2")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new FileTool().execute({ subcommand: "rm", path: "dir", recursive: true }, task, cbs)

		expect(await ws.exists("dir")).toBe(false)
		const tracked = task.fileContextTracker.trackFileContext.mock.calls.map((c: unknown[]) => c[0]).sort()
		expect(tracked).toEqual(["dir/a.ts", "dir/sub/b.ts"])
		expect(toolResults(cbs)).toContain("Deleted directory 'dir' (2 file(s)).")
	})

	it("reports a missing source rather than silently succeeding", async () => {
		const cbs = makeToolCallbacks()
		await new FileTool().execute({ subcommand: "rm", path: "absent.ts" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(toolResults(cbs)).toContain("does not exist")
	})

	it("does nothing when the user rejects", async () => {
		await ws.write("a.ts", "content\n")
		const cbs = makeToolCallbacks(false)

		await new FileTool().execute({ subcommand: "rm", path: "a.ts" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(await ws.exists("a.ts")).toBe(true)
		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})
})

describe("FileTool — mv", () => {
	it("moves a file and tracks BOTH endpoints", async () => {
		await ws.write("a.ts", "content\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new FileTool().execute({ subcommand: "mv", path: "a.ts", destination: "sub/b.ts" }, task, cbs)

		expect(await ws.exists("a.ts")).toBe(false)
		expect(await ws.read("sub/b.ts")).toBe("content\n")
		// The destination's "original" is explicitly `undefined` — that is what
		// makes a revert able to delete it again.
		expect(task.fileContextTracker.captureOriginal).toHaveBeenCalledWith("a.ts", "content\n")
		expect(task.fileContextTracker.captureOriginal).toHaveBeenCalledWith("sub/b.ts", undefined)
		const tracked = task.fileContextTracker.trackFileContext.mock.calls.map((c: unknown[]) => c[0])
		expect(tracked).toEqual(["a.ts", "sub/b.ts"])
	})

	it("moves a directory and tracks each contained file at both paths", async () => {
		await ws.write("dir/a.ts", "1")
		await ws.write("dir/sub/b.ts", "2")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new FileTool().execute({ subcommand: "mv", path: "dir", destination: "moved" }, task, cbs)

		expect(await ws.read("moved/sub/b.ts")).toBe("2")
		const tracked = task.fileContextTracker.trackFileContext.mock.calls.map((c: unknown[]) => c[0]).sort()
		expect(tracked).toEqual(["dir/a.ts", "dir/sub/b.ts", "moved/a.ts", "moved/sub/b.ts"])
		expect(toolResults(cbs)).toContain("Moved directory 'dir' → 'moved' (2 file(s)).")
	})

	it("refuses to overwrite an existing destination", async () => {
		await ws.write("a.ts", "1")
		await ws.write("b.ts", "2")
		const cbs = makeToolCallbacks()

		await new FileTool().execute(
			{ subcommand: "mv", path: "a.ts", destination: "b.ts" },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(await ws.read("b.ts")).toBe("2")
		expect(toolResults(cbs)).toContain("already exists")
	})

	it("reports a missing source", async () => {
		const cbs = makeToolCallbacks()
		await new FileTool().execute(
			{ subcommand: "mv", path: "absent.ts", destination: "b.ts" },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(toolResults(cbs)).toContain("source 'absent.ts' does not exist")
	})
})

describe("FileTool — workspace containment", () => {
	it("refuses a source outside the workspace", async () => {
		const cbs = makeToolCallbacks()
		await new FileTool().execute({ subcommand: "rm", path: "../escape.ts" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(toolResults(cbs)).toContain("is outside the workspace")
		expect(cbs.askApproval).not.toHaveBeenCalled()
	})

	it("refuses a move destination outside the workspace", async () => {
		await ws.write("a.ts", "1")
		const cbs = makeToolCallbacks()

		await new FileTool().execute(
			{ subcommand: "mv", path: "a.ts", destination: "../escape.ts" },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(toolResults(cbs)).toContain("destination '../escape.ts' is outside the workspace")
		expect(await ws.exists("a.ts")).toBe(true)
	})
})

describe("FileTool — streaming", () => {
	it("renders the partial row only once the path has stabilized", async () => {
		const tool = new FileTool()
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const block = {
			type: "tool_use",
			name: "file",
			params: { subcommand: "mv", path: "a.ts", destination: "b.ts" },
			partial: true,
		} as any

		await tool.handlePartial(task, block)
		expect(task.ask).not.toHaveBeenCalled()

		await tool.handlePartial(task, block)
		expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining("moveFile"), true)
	})
})
