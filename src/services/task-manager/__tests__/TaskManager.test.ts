import type { TaskState } from "@shofer/types"

import { TaskManager, ManagedTask } from "../TaskManager"

describe("TaskManager.countActiveTasks", () => {
	let taskManager: TaskManager

	beforeEach(() => {
		taskManager = new TaskManager({} as any)
		// Clear the managedTasks map via addManagedTask + a helper.
	})

	function makeManagedTask(id: string, lifecycle: TaskState["lifecycle"]): ManagedTask {
		return {
			id,
			name: `Task ${id}`,
			taskId: id,
			rootTaskId: "root-1",
			workspace: "/tmp/test",
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			state: { lifecycle, rating: undefined },
			activeTimeMs: 0,
			_runningSince: 0,
		}
	}

	function addManagedTask(id: string, lifecycle: TaskState["lifecycle"]) {
		const mt = makeManagedTask(id, lifecycle)
		// Access the private managedTasks map via (taskManager as any)
		;(taskManager as any).managedTasks.set(id, mt)
	}

	it("returns 0 when there are no managed tasks", () => {
		expect(taskManager.countActiveTasks()).toBe(0)
	})

	it("counts only running and waiting tasks", () => {
		addManagedTask("t1", "running")
		addManagedTask("t2", "waiting")

		expect(taskManager.countActiveTasks()).toBe(2)
	})

	it("excludes idle tasks", () => {
		addManagedTask("t1", "running")
		addManagedTask("t2", "idle")

		expect(taskManager.countActiveTasks()).toBe(1)
	})

	it("excludes paused tasks", () => {
		addManagedTask("t1", "running")
		addManagedTask("t2", "paused")

		expect(taskManager.countActiveTasks()).toBe(1)
	})

	it("excludes waiting_input tasks", () => {
		addManagedTask("t1", "running")
		addManagedTask("t2", "waiting_input")

		expect(taskManager.countActiveTasks()).toBe(1)
	})

	it("excludes terminal states (completed, error)", () => {
		addManagedTask("t1", "running")
		addManagedTask("t2", "completed")
		addManagedTask("t3", "error")

		expect(taskManager.countActiveTasks()).toBe(1)
	})

	it("returns correct count with all lifecycle types mixed", () => {
		addManagedTask("t1", "running")
		addManagedTask("t2", "waiting")
		addManagedTask("t3", "idle")
		addManagedTask("t4", "paused")
		addManagedTask("t5", "waiting_input")
		addManagedTask("t6", "completed")
		addManagedTask("t7", "error")

		// Only running + waiting = 2
		expect(taskManager.countActiveTasks()).toBe(2)
	})

	it("returns 0 when only terminal and idle states exist", () => {
		addManagedTask("t1", "idle")
		addManagedTask("t2", "completed")
		addManagedTask("t3", "error")
		addManagedTask("t4", "paused")
		addManagedTask("t5", "waiting_input")

		expect(taskManager.countActiveTasks()).toBe(0)
	})
})
