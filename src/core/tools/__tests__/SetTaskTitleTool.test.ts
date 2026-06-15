import { SetTaskTitleTool } from "../SetTaskTitleTool"

/**
 * Tests for SetTaskTitleTool's interaction with parent-locked titles.
 *
 * When a task was spawned via `new_task`'s `title` parameter, its title is
 * locked (`Task.nameLocked === true`) and `set_task_title` must refuse to
 * overwrite it — the parent's title stands. See docs/native_tools.md
 * §`set_task_title` "Parent-locked titles".
 */
describe("SetTaskTitleTool — parent-locked titles", () => {
	let tool: SetTaskTitleTool

	beforeEach(() => {
		tool = new SetTaskTitleTool()
	})

	function buildProvider(overrides: Record<string, any> = {}) {
		return {
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: "task-1", name: "old" } }),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			renameManagedTask: vi.fn(),
			...overrides,
		}
	}

	function buildTask(overrides: Record<string, any> = {}) {
		const providerObj = buildProvider()
		return {
			taskId: "task-1",
			nameLocked: false,
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing param"),
			providerRef: { deref: () => providerObj },
			...overrides,
		} as any
	}

	function buildCallbacks() {
		return {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		} as any
	}

	it("refuses to rename a task whose title is parent-locked", async () => {
		const task = buildTask({ nameLocked: true })
		const provider = task.providerRef.deref()
		const cbs = buildCallbacks()

		await tool.execute({ title: "My new title" }, task, cbs)

		expect(cbs.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("set by its parent and cannot be changed"),
		)
		// The persisted title must be left untouched.
		expect(provider.updateTaskHistory).not.toHaveBeenCalled()
		expect(provider.renameManagedTask).not.toHaveBeenCalled()
		// Rejecting a locked title is not a usage mistake.
		expect(task.consecutiveMistakeCount).toBe(0)
	})

	it("renames normally when the title is not locked", async () => {
		const task = buildTask({ nameLocked: false })
		const provider = task.providerRef.deref()
		const cbs = buildCallbacks()

		await tool.execute({ title: "My new title" }, task, cbs)

		expect(provider.updateTaskHistory).toHaveBeenCalledWith(expect.objectContaining({ name: "My new title" }))
		expect(provider.renameManagedTask).toHaveBeenCalledWith("task-1", "My new title")
		expect(cbs.pushToolResult).toHaveBeenCalledWith(expect.stringContaining('Task title set to: "My new title"'))
	})
})
