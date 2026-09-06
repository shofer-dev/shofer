import { InsertEditTool } from "../InsertEditTool.js"
import {
	makeFakeEditTask,
	makeToolCallbacks,
	makeWorkspace,
	toolResults,
	withWorkspaceRoot,
	type FakeWorkspace,
} from "./helpers/fakeEditTask.js"

/**
 * `insert_edit` writes through `DiffViewProvider` so it inherits approval,
 * change tracking and write protection from the same place the other edit
 * tools do. Its own contribution is POSITION HANDLING, and the interesting
 * property there is that it REFUSES an out-of-range line or column rather than
 * clamping: a clamp silently inserts at the wrong place (a too-large line lands
 * at EOF), which is a confidently-wrong edit the model has no way to notice.
 */

let ws: FakeWorkspace
let restoreHost: () => void

const DIFF_VIEW_STATE = { experiments: { preventFocusDisruption: false } }

beforeEach(async () => {
	ws = await makeWorkspace("shofer-insert-edit-")
	restoreHost = withWorkspaceRoot(ws.cwd)
})

afterEach(async () => {
	restoreHost()
	await ws.cleanup()
})

describe("InsertEditTool — position handling", () => {
	it("inserts at the given 1-based line and column", async () => {
		await ws.write("a.ts", "const a = 1\nconst b = 2\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "a.ts", line: 2, column: 7, text: "X" }, task, cbs)

		expect(await ws.read("a.ts")).toBe("const a = 1\nconst Xb = 2\n")
		expect(task.didEditFile).toBe(true)
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("a.ts", "shofer_edited")
		expect(toolResults(cbs)).toContain("Inserted text at a.ts:2:7")
	})

	it("defaults the column to the start of the line", async () => {
		await ws.write("a.ts", "b\n")
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "a.ts", line: 1, text: "a" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(await ws.read("a.ts")).toBe("ab\n")
	})

	it("refuses a line past the end of the file instead of clamping to EOF", async () => {
		await ws.write("a.ts", "one\ntwo\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "a.ts", line: 99, text: "X" }, task, cbs)

		expect(await ws.read("a.ts")).toBe("one\ntwo\n")
		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(toolResults(cbs)).toContain("Line 99 is out of range")
		expect(toolResults(cbs)).toContain("valid line numbers are 1–3")
	})

	it("refuses a column past the end of the target line", async () => {
		await ws.write("a.ts", "abc\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "a.ts", line: 1, column: 99, text: "X" }, task, cbs)

		expect(await ws.read("a.ts")).toBe("abc\n")
		expect(toolResults(cbs)).toContain("Column 99 is out of range on line 1")
		expect(toolResults(cbs)).toContain("valid columns are 1–4")
	})

	it("reports an empty insertion as a no-op instead of a spurious edit", async () => {
		await ws.write("a.ts", "abc\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "a.ts", line: 1, column: 1, text: "" }, task, cbs)

		expect(toolResults(cbs)).toContain("No insertion performed (empty text)")
		expect(task.didEditFile).toBe(false)
	})

	it("decodes HTML entities that leaked into the text", async () => {
		await ws.write("a.ts", "x\n")
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute(
			{ path: "a.ts", line: 1, column: 1, text: "&amp;&lt;a&gt;&quot;&#39;" },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(await ws.read("a.ts")).toBe("&<a>\"'x\n")
	})
})

describe("InsertEditTool — refusals", () => {
	it.each([
		["path", { path: "", line: 1, text: "x" }],
		["line", { path: "a.ts", line: undefined, text: "x" }],
		["text", { path: "a.ts", line: 1, text: undefined }],
	])("reports a missing %s as a usage mistake", async (param, params) => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute(params as any, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain(`Missing ${param} for insert_edit`)
	})

	it("points at write_to_file when the target does not exist", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "absent.ts", line: 1, text: "x" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Use write_to_file to create new files")
	})

	it("refuses a .shoferignore'd path", async () => {
		await ws.write("secret.ts", "x\n")
		const task = makeFakeEditTask({ cwd: ws.cwd, accessAllowed: false })
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "secret.ts", line: 1, text: "y" }, task, cbs)

		expect(await ws.read("secret.ts")).toBe("x\n")
		expect(task.say).toHaveBeenCalledWith("shoferignore_error", "secret.ts")
	})
})

describe("InsertEditTool — approval paths", () => {
	it("saves directly, without a diff view, under focus-disruption prevention (the default)", async () => {
		await ws.write("a.ts", "x\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "a.ts", line: 1, column: 1, text: "y" }, task, cbs)

		expect(task.diffViewProvider.open).not.toHaveBeenCalled()
		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalled()
		expect(task.diffViewProvider.originalContent).toBe("x\n")
		expect(await ws.read("a.ts")).toBe("yx\n")
	})

	it("writes nothing when the user rejects the direct-save path", async () => {
		await ws.write("a.ts", "x\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks(false)

		await new InsertEditTool().execute({ path: "a.ts", line: 1, column: 1, text: "y" }, task, cbs)

		expect(await ws.read("a.ts")).toBe("x\n")
		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	it("opens the diff view and reverts it on rejection when prevention is off", async () => {
		await ws.write("a.ts", "x\n")
		const task = makeFakeEditTask({ cwd: ws.cwd, state: DIFF_VIEW_STATE })
		const cbs = makeToolCallbacks(false)

		await new InsertEditTool().execute({ path: "a.ts", line: 1, column: 1, text: "y" }, task, cbs)

		expect(task.diffViewProvider.open).toHaveBeenCalledWith("a.ts")
		expect(task.diffViewProvider.revertChanges).toHaveBeenCalled()
		expect(task.processQueuedMessages).toHaveBeenCalled()
		expect(await ws.read("a.ts")).toBe("x\n")
	})

	it("marks the approval as protected for a protected target", async () => {
		await ws.write("a.ts", "x\n")
		const task = makeFakeEditTask({ cwd: ws.cwd, writeProtected: true })
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "a.ts", line: 1, column: 1, text: "y" }, task, cbs)

		expect(cbs.askApproval).toHaveBeenCalledWith("tool", expect.any(String), undefined, true)
	})

	it("routes a save failure through handleError and still resets the diff view", async () => {
		await ws.write("a.ts", "x\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		task.diffViewProvider.saveDirectly = vi.fn().mockRejectedValue(new Error("disk full"))
		const cbs = makeToolCallbacks()

		await new InsertEditTool().execute({ path: "a.ts", line: 1, column: 1, text: "y" }, task, cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("inserting edit", expect.any(Error))
		expect(task.diffViewProvider.reset).toHaveBeenCalled()
	})
})
