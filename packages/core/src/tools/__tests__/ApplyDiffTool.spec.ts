import { ApplyDiffTool } from "../ApplyDiffTool.js"
import { MultiSearchReplaceDiffStrategy } from "../../diff/strategies/multi-search-replace.js"
import {
	makeFakeEditTask,
	makeToolCallbacks,
	makeWorkspace,
	toolResults,
	withWorkspaceRoot,
	type FakeWorkspace,
} from "./helpers/fakeEditTask.js"

// `apply_diff` reports a failed application to telemetry, which throws when the
// service was never initialized — in a unit test that surfaces as "applying
// diff" going through handleError, hiding the behaviour under test.
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { instance: { captureDiffApplicationError: vi.fn() } },
}))

/**
 * `apply_diff` over the REAL multi-search-replace strategy — a stubbed strategy
 * would let the tool's block accounting (`N/M blocks applied`, the failed-block
 * hint, the single-block batching notice) pass while agreeing with nothing, and
 * that accounting is the whole of what this tool adds over `write_to_file`.
 */

let ws: FakeWorkspace
let restoreHost: () => void

const DIFF_VIEW_STATE = { experiments: { preventFocusDisruption: false } }

function block(search: string, replace: string): string {
	return ["<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE"].join("\n")
}

function taskWithStrategy(state: Record<string, unknown> = {}) {
	const task = makeFakeEditTask({ cwd: ws.cwd, state })
	task.diffStrategy = new MultiSearchReplaceDiffStrategy()
	task.consecutiveMistakeCountForApplyDiff = new Map<string, number>()
	return task
}

beforeEach(async () => {
	ws = await makeWorkspace("shofer-apply-diff-")
	restoreHost = withWorkspaceRoot(ws.cwd)
})

afterEach(async () => {
	restoreHost()
	await ws.cleanup()
})

describe("ApplyDiffTool — applying", () => {
	it("applies a single block, tracks the edit and nudges toward batching", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = taskWithStrategy()
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: block("const a = 1", "const a = 2") }, task, cbs)

		expect(await ws.read("a.ts")).toContain("const a = 2")
		expect(task.didEditFile).toBe(true)
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("a.ts", "shofer_edited")
		// A single-block diff gets the batching notice; a multi-block one does not.
		expect(toolResults(cbs)).toContain("Making multiple related changes in a single apply_diff")
		expect(task.consecutiveMistakeCount).toBe(0)
	})

	it("reports per-block accounting for a multi-block diff instead of the batching notice", async () => {
		await ws.write("a.ts", "one\ntwo\n")
		const task = taskWithStrategy()
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute(
			{ path: "a.ts", diff: [block("one", "1"), block("two", "2")].join("\n") },
			task,
			cbs,
		)

		expect(await ws.read("a.ts")).toContain("1\n2")
		expect(toolResults(cbs)).not.toContain("Making multiple related changes")
		const extra = task.diffViewProvider.pushToolWriteResult.mock.calls[0]![3]
		expect(extra.stats).toEqual({ total_blocks: 2, applied_blocks: 2, failed_blocks: 0 })
		expect(extra.summary).toBe("2/2 blocks applied to a.ts.")
	})

	it("clears the per-file mistake counter on a successful apply", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = taskWithStrategy()
		task.consecutiveMistakeCountForApplyDiff.set("a.ts", 3)
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: block("const a = 1", "const a = 2") }, task, cbs)

		expect(task.consecutiveMistakeCountForApplyDiff.has("a.ts")).toBe(false)
	})
})

describe("ApplyDiffTool — failures", () => {
	it("counts a non-matching diff per FILE and escalates to a diff_error on the second try", async () => {
		await ws.write("a.ts", "actual content\n")
		const task = taskWithStrategy()
		const cbs = makeToolCallbacks()
		const tool = new ApplyDiffTool()
		const diff = { path: "a.ts", diff: block("nowhere in the file", "x") }

		await tool.execute(diff, task, cbs)
		expect(task.consecutiveMistakeCountForApplyDiff.get("a.ts")).toBe(1)
		// The first failure is reported to the model only.
		expect(task.say).not.toHaveBeenCalledWith("diff_error", expect.any(String))

		await tool.execute(diff, task, cbs)
		expect(task.consecutiveMistakeCountForApplyDiff.get("a.ts")).toBe(2)
		expect(task.say).toHaveBeenCalledWith("diff_error", expect.any(String))
		expect(await ws.read("a.ts")).toBe("actual content\n")
	})

	it("reports the absence of a diff strategy rather than writing", async () => {
		await ws.write("a.ts", "x\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		task.consecutiveMistakeCountForApplyDiff = new Map<string, number>()
		task.diffStrategy = undefined
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: block("x", "y") }, task, cbs)

		expect(toolResults(cbs)).toContain("No diff strategy available")
		expect(await ws.read("a.ts")).toBe("x\n")
	})

	it.each([
		["path", { path: "", diff: "d" }],
		["diff", { path: "a.ts", diff: "" }],
	])("reports a missing %s as a usage mistake", async (param, params) => {
		const task = taskWithStrategy()
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute(params as any, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain(`Missing ${param} for apply_diff`)
	})

	it("refuses a .shoferignore'd path before reading the file", async () => {
		await ws.write("secret.ts", "x\n")
		const task = makeFakeEditTask({ cwd: ws.cwd, accessAllowed: false })
		task.consecutiveMistakeCountForApplyDiff = new Map<string, number>()
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute({ path: "secret.ts", diff: block("x", "y") }, task, cbs)

		expect(task.say).toHaveBeenCalledWith("shoferignore_error", "secret.ts")
		expect(await ws.read("secret.ts")).toBe("x\n")
	})

	it("reports a missing file with an actionable error", async () => {
		const task = taskWithStrategy()
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute({ path: "absent.ts", diff: block("x", "y") }, task, cbs)

		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(toolResults(cbs)).toContain("File does not exist at path")
	})
})

describe("ApplyDiffTool — approval paths", () => {
	it("saves directly under focus-disruption prevention (the default)", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = taskWithStrategy()
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: block("const a = 1", "const a = 2") }, task, cbs)

		expect(task.diffViewProvider.open).not.toHaveBeenCalled()
		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalled()
		expect(task.diffViewProvider.originalContent).toBe("const a = 1\n")
	})

	it("writes nothing when the user rejects the direct-save path", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const cbs = makeToolCallbacks(false)

		await new ApplyDiffTool().execute(
			{ path: "a.ts", diff: block("const a = 1", "const a = 2") },
			taskWithStrategy(),
			cbs,
		)

		expect(await ws.read("a.ts")).toBe("const a = 1\n")
		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	it("opens the diff view and reverts on rejection when prevention is off", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = taskWithStrategy(DIFF_VIEW_STATE)
		const cbs = makeToolCallbacks(false)

		await new ApplyDiffTool().execute({ path: "a.ts", diff: block("const a = 1", "const a = 2") }, task, cbs)

		expect(task.diffViewProvider.open).toHaveBeenCalledWith("a.ts")
		expect(task.diffViewProvider.revertChanges).toHaveBeenCalled()
		expect(task.processQueuedMessages).toHaveBeenCalled()
		expect(await ws.read("a.ts")).toBe("const a = 1\n")
	})

	it("marks the approval as protected and carries the strategy's progress status", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = taskWithStrategy(DIFF_VIEW_STATE)
		task.shoferProtectedController.isWriteProtected = vi.fn(() => true)
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: block("const a = 1", "const a = 2") }, task, cbs)

		const [, , progress, isProtected] = cbs.askApproval.mock.calls[0]!
		expect(isProtected).toBe(true)
		expect(progress).toBeDefined()
	})

	it("routes a save failure through handleError and resets the diff view", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = taskWithStrategy()
		task.diffViewProvider.saveDirectly = vi.fn().mockRejectedValue(new Error("disk full"))
		const cbs = makeToolCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: block("const a = 1", "const a = 2") }, task, cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("applying diff", expect.any(Error))
		expect(task.diffViewProvider.reset).toHaveBeenCalled()
	})
})

describe("ApplyDiffTool — streaming", () => {
	const partialBlock = () =>
		({
			type: "tool_use",
			name: "apply_diff",
			params: { path: "a.ts", diff: block("x", "y") },
			partial: true,
		}) as any

	it("renders the partial row only once the path has stabilized", async () => {
		const tool = new ApplyDiffTool()
		// No diff strategy: no progress status, so the row is not suppressed and
		// the stabilization gate is the only thing deciding.
		const task = makeFakeEditTask({ cwd: ws.cwd })

		await tool.handlePartial(task, partialBlock())
		expect(task.ask).not.toHaveBeenCalled()

		await tool.handlePartial(task, partialBlock())
		expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining("appliedDiff"), true, undefined)
	})

	it("suppresses the row entirely while the strategy reports no progress yet", async () => {
		const tool = new ApplyDiffTool()
		const task = taskWithStrategy()
		task.diffStrategy.getProgressStatus = vi.fn(() => ({}))

		await tool.handlePartial(task, partialBlock())
		await tool.handlePartial(task, partialBlock())

		expect(task.ask).not.toHaveBeenCalled()
	})
})
