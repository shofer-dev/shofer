/**
 * Tests for Task.rehydrateBackgroundChildren().
 *
 * After a process restart, the in-memory `backgroundChildren` Map is empty
 * (it is never serialized). rehydrateBackgroundChildren rebuilds it from the
 * persisted task history so that check_task_status / cancel_tasks — both of
 * which gate on
 * `task.backgroundChildren.get(task_id)` — can still recognize the parent's
 * own children.
 *
 * Rather than constructing a full Task (which requires extensive mocking of
 * the constructor's intra-core dependencies), these tests extract the method
 * via Object.getOwnPropertyDescriptor and bind it to a minimal Task shape.
 * This directly exercises the real implementation logic.
 */
import { Task } from "../Task.js"

describe("Task.rehydrateBackgroundChildren", () => {
	// Extract the method from the prototype descriptor so we can bind it to a
	// minimal object without invoking the Task constructor.
	const methodDescriptor = Object.getOwnPropertyDescriptor(Task.prototype, "rehydrateBackgroundChildren")
	const rehydrate = methodDescriptor?.value as (() => Promise<void>) | undefined

	// Sanity: if this fails, the method was renamed or removed from Task.
	it("exists on Task.prototype", () => {
		expect(typeof rehydrate).toBe("function")
	})

	function buildTask(providerOverrides: Record<string, any> = {}) {
		const providerObj = {
			taskManager: {
				getTaskState: vi.fn().mockReturnValue(undefined),
			},
			taskHistoryStore: {
				getAll: vi.fn().mockReturnValue([]),
			},
			...providerOverrides,
		}

		const task = {
			taskId: "parent-1",
			backgroundChildren: new Map(),
			providerRef: { deref: () => providerObj },
		} as any

		// Bind the real method to the minimal shape.
		task.rehydrateBackgroundChildren = rehydrate!.bind(task)

		return { task, providerObj }
	}

	it("repopulates backgroundChildren from persisted history", async () => {
		const { task } = buildTask({
			taskHistoryStore: {
				getAll: () => [
					{
						id: "child-1",
						isBackground: true,
						parentTaskId: "parent-1",
						taskState: { lifecycle: "completed" },
						createdAt: 100,
					},
					{
						id: "child-2",
						isBackground: true,
						parentTaskId: "parent-1",
						taskState: { lifecycle: "idle" },
						createdAt: 200,
					},
				],
			},
		})

		await task.rehydrateBackgroundChildren()

		expect(task.backgroundChildren.size).toBe(2)
		expect(task.backgroundChildren.get("child-1").status).toBe("completed")
		expect(task.backgroundChildren.get("child-2").status).toBe("running")
	})

	it("skips tasks that are not background children of this task", async () => {
		const { task } = buildTask({
			taskHistoryStore: {
				getAll: () => [
					{
						id: "other-child",
						isBackground: true,
						parentTaskId: "different-parent",
						taskState: { lifecycle: "running" },
					},
					{
						id: "foreground-child",
						isBackground: false,
						parentTaskId: "parent-1",
						taskState: { lifecycle: "running" },
					},
				],
			},
		})

		await task.rehydrateBackgroundChildren()

		expect(task.backgroundChildren.size).toBe(0)
	})

	it("prefers live TaskManager state over persisted lifecycle", async () => {
		const { task } = buildTask({
			taskManager: {
				getTaskState: vi.fn().mockReturnValue({ lifecycle: "completed" }),
			},
			taskHistoryStore: {
				getAll: () => [
					{
						id: "child-1",
						isBackground: true,
						parentTaskId: "parent-1",
						// Persisted says idle, but live says completed.
						taskState: { lifecycle: "idle" },
						createdAt: 100,
					},
				],
			},
		})

		await task.rehydrateBackgroundChildren()

		// Live state wins → completed.
		expect(task.backgroundChildren.get("child-1").status).toBe("completed")
	})

	it("preserves existing live handles (idempotent)", async () => {
		const existingHandle = {
			taskId: "child-1",
			status: "waiting_for_parent" as const,
			createdAt: 100,
			parentTaskId: "parent-1",
		}
		const { task } = buildTask({
			taskHistoryStore: {
				getAll: () => [
					{
						id: "child-1",
						isBackground: true,
						parentTaskId: "parent-1",
						taskState: { lifecycle: "completed" },
						createdAt: 100,
					},
				],
			},
		})
		task.backgroundChildren.set("child-1", existingHandle)

		await task.rehydrateBackgroundChildren()

		// The live handle is preserved — not overwritten by the persisted snapshot.
		expect(task.backgroundChildren.get("child-1")).toBe(existingHandle)
		expect(task.backgroundChildren.get("child-1").status).toBe("waiting_for_parent")
	})

	it("maps error lifecycle to error handle status", async () => {
		const { task } = buildTask({
			taskHistoryStore: {
				getAll: () => [
					{
						id: "child-err",
						isBackground: true,
						parentTaskId: "parent-1",
						taskState: { lifecycle: "error" },
						createdAt: 300,
					},
				],
			},
		})

		await task.rehydrateBackgroundChildren()

		expect(task.backgroundChildren.get("child-err").status).toBe("error")
	})

	it("is a no-op when provider is unavailable", async () => {
		const task = {
			taskId: "parent-1",
			backgroundChildren: new Map(),
			providerRef: { deref: () => undefined },
		} as any
		task.rehydrateBackgroundChildren = rehydrate!.bind(task)

		await task.rehydrateBackgroundChildren()

		expect(task.backgroundChildren.size).toBe(0)
	})
})
