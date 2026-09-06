import { SwitchModeTool } from "../SwitchModeTool.js"
import { makeToolCallbacks, toolResults } from "./helpers/fakeEditTask.js"

/**
 * `switch_mode` has two paths that share one entry point: the SELF switch and
 * the parent-switches-a-background-CHILD switch selected by `task_id`. The
 * child path is the one worth pinning — it resolves the child through the
 * parent's `backgroundChildren` map and then through the task manager, and
 * every step of that resolution has its own refusal.
 */

const MODES = [
	{ slug: "code", name: "Code", roleDefinition: "", groups: [] },
	{ slug: "architect", name: "Architect", roleDefinition: "", groups: [] },
]

function buildProvider(overrides: Record<string, any> = {}) {
	return {
		getState: vi.fn().mockResolvedValue({ customModes: MODES }),
		handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		taskManager: { getManagedTaskInstance: vi.fn(), getManagedTask: vi.fn() },
		...overrides,
	}
}

function buildTask(overrides: Record<string, any> = {}, provider = buildProvider()) {
	return {
		taskId: "parent-1",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn(async (tool: string, param: string) => `Missing ${param} for ${tool}`),
		getTaskMode: vi.fn().mockResolvedValue("code"),
		backgroundChildren: new Map<string, unknown>(),
		providerRef: { deref: () => provider },
		...overrides,
	} as any
}

describe("SwitchModeTool — self switch", () => {
	it("switches the CALLING task, not the provider-global mode", async () => {
		const provider = buildProvider()
		const task = buildTask({}, provider)
		const cbs = makeToolCallbacks()

		await new SwitchModeTool().execute({ mode_slug: "architect", reason: "planning" }, task, cbs)

		// The task instance is passed through, which is what keeps a background
		// task's mode switch from moving another task's mode.
		expect(provider.handleModeSwitch).toHaveBeenCalledWith("architect", task)
		expect(toolResults(cbs)).toContain("Successfully switched from Code mode to Architect mode because: planning")
	})

	it("refuses a mode slug the catalog does not carry", async () => {
		const task = buildTask()
		const cbs = makeToolCallbacks()

		await new SwitchModeTool().execute({ mode_slug: "nonesuch", reason: "why" }, task, cbs)

		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(toolResults(cbs)).toContain("Invalid mode: nonesuch")
	})

	it("refuses a switch to the mode it is already in", async () => {
		const task = buildTask()
		const cbs = makeToolCallbacks()

		await new SwitchModeTool().execute({ mode_slug: "code", reason: "again" }, task, cbs)

		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(toolResults(cbs)).toBe("Already in Code mode.")
	})

	it("reports a missing mode_slug as a usage mistake", async () => {
		const task = buildTask()
		const cbs = makeToolCallbacks()

		await new SwitchModeTool().execute({ mode_slug: "", reason: "" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Missing mode_slug for switch_mode")
	})

	it("does not switch when the user rejects", async () => {
		const provider = buildProvider()
		const cbs = makeToolCallbacks(false)

		await new SwitchModeTool().execute({ mode_slug: "architect", reason: "x" }, buildTask({}, provider), cbs)

		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	it("routes a provider failure through handleError", async () => {
		const provider = buildProvider({
			handleModeSwitch: vi.fn().mockRejectedValue(new Error("provider gone")),
		})
		const cbs = makeToolCallbacks()

		await new SwitchModeTool().execute({ mode_slug: "architect", reason: "x" }, buildTask({}, provider), cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("switching mode", expect.any(Error))
	})
})

describe("SwitchModeTool — parent switches a background child", () => {
	function buildParentWithChild(childOverrides: Record<string, any> = {}) {
		const child = { getTaskMode: vi.fn().mockResolvedValue("code"), ...childOverrides }
		const provider = buildProvider({
			taskManager: {
				getManagedTaskInstance: vi.fn(() => child),
				getManagedTask: vi.fn(() => ({ name: "Child task" })),
			},
		})
		const parent = buildTask({ backgroundChildren: new Map([["child-1", { title: "Child" }]]) }, provider)
		return { parent, provider, child }
	}

	it("switches the CHILD task and names it in the result", async () => {
		const { parent, provider, child } = buildParentWithChild()
		const cbs = makeToolCallbacks()

		await new SwitchModeTool().execute(
			{ mode_slug: "architect", reason: "it should plan", task_id: "child-1" },
			parent,
			cbs,
		)

		expect(provider.handleModeSwitch).toHaveBeenCalledWith("architect", child)
		expect(toolResults(cbs)).toContain('Successfully switched child task "Child task"')
		expect(toolResults(cbs)).toContain("to Architect mode because: it should plan")
	})

	it("refuses a task_id that is not one of this parent's children", async () => {
		const parent = buildTask()
		const cbs = makeToolCallbacks()

		await new SwitchModeTool().execute({ mode_slug: "architect", reason: "x", task_id: "other" }, parent, cbs)

		expect(parent.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Task other not found in background children.")
	})

	it("refuses when the child is no longer running", async () => {
		const provider = buildProvider({
			taskManager: { getManagedTaskInstance: vi.fn(() => undefined), getManagedTask: vi.fn() },
		})
		const parent = buildTask({ backgroundChildren: new Map([["child-1", {}]]) }, provider)
		const cbs = makeToolCallbacks()

		await new SwitchModeTool().execute({ mode_slug: "architect", reason: "x", task_id: "child-1" }, parent, cbs)

		expect(toolResults(cbs)).toContain("is no longer running")
	})

	it("reports a child already in the requested mode", async () => {
		const { parent } = buildParentWithChild({ getTaskMode: vi.fn().mockResolvedValue("architect") })
		const cbs = makeToolCallbacks()

		await new SwitchModeTool().execute({ mode_slug: "architect", reason: "x", task_id: "child-1" }, parent, cbs)

		expect(toolResults(cbs)).toContain('Child task "Child task" is already in Architect mode')
	})

	it("does not switch the child when the user rejects", async () => {
		const { parent, provider } = buildParentWithChild()
		const cbs = makeToolCallbacks(false)

		await new SwitchModeTool().execute({ mode_slug: "architect", reason: "x", task_id: "child-1" }, parent, cbs)

		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
	})
})

describe("SwitchModeTool — streaming", () => {
	it("renders the target mode and reason while the call streams", async () => {
		const task = buildTask({ ask: vi.fn().mockResolvedValue(undefined) })
		const block = {
			type: "tool_use",
			name: "switch_mode",
			params: { mode_slug: "architect", reason: "plan", task_id: "child-1" },
			partial: true,
		} as any

		await new SwitchModeTool().handlePartial(task, block)

		const payload = JSON.parse(task.ask.mock.calls[0]![1])
		expect(payload).toEqual({ tool: "switchMode", mode: "architect", reason: "plan", task_id: "child-1" })
	})
})
