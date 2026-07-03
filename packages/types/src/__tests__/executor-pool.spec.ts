import { describe, it, expect, vi } from "vitest"

import type { AgentApi, ServerEvent } from "../agent-api.js"
import { ExecutorPool } from "../executor-pool.js"

/** A mock executor whose task ids are namespaced + whose event stream is drivable. */
function makeExecutor(id: string) {
	let emit: (e: ServerEvent) => void = () => {}
	let seq = 0
	const api: AgentApi = {
		createTask: vi.fn(async () => ({ taskId: `${id}-task-${++seq}` })),
		sendMessage: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		respondToAsk: vi.fn(async () => {}),
		subscribe: (listener) => {
			emit = listener
			return () => {
				emit = () => {}
			}
		},
	}
	return { id, api, emit: (e: ServerEvent) => emit(e) }
}

describe("ExecutorPool (§13 controller side)", () => {
	it("round-robins new root tasks across executors and remembers the owner", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new ExecutorPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })

		const t1 = await pool.createTask({ prompt: "1" }) // → A
		const t2 = await pool.createTask({ prompt: "2" }) // → B
		expect(t1.taskId).toBe("A-task-1")
		expect(t2.taskId).toBe("B-task-1")

		await pool.sendMessage(t1.taskId, "hi")
		expect(a.api.sendMessage).toHaveBeenCalledWith("A-task-1", "hi")
		expect(b.api.sendMessage).not.toHaveBeenCalled()

		await pool.cancelTask(t2.taskId)
		expect(b.api.cancelTask).toHaveBeenCalledWith("B-task-1")

		await pool.respondToAsk(t1.taskId, { askResponse: "yesButtonClicked", askId: "a1" })
		expect(a.api.respondToAsk).toHaveBeenCalledWith("A-task-1", {
			askResponse: "yesButtonClicked",
			askId: "a1",
		})
		expect(b.api.respondToAsk).not.toHaveBeenCalled()
	})

	it("merges executor event streams, tagging each with executorId", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new ExecutorPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })
		const seen: ServerEvent[] = []
		pool.subscribe((e) => seen.push(e))

		a.emit({ type: "Message", text: "from A" })
		b.emit({ type: "TaskCompleted" })
		expect(seen).toEqual([
			{ type: "Message", text: "from A", executorId: "A" },
			{ type: "TaskCompleted", executorId: "B" },
		])
	})

	it("skips disabled executors and stops forwarding events after remove", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new ExecutorPool()
		pool.add({ id: a.id, api: a.api, disabled: true })
		pool.add({ id: b.id, api: b.api })

		const t = await pool.createTask({ prompt: "x" }) // A disabled → B
		expect(t.taskId).toBe("B-task-1")

		const seen: ServerEvent[] = []
		pool.subscribe((e) => seen.push(e))
		pool.remove("B")
		b.emit({ type: "Message" })
		expect(seen).toEqual([]) // B removed, no forwarding
	})

	it("throws when no executor is available", async () => {
		const pool = new ExecutorPool()
		await expect(pool.createTask({ prompt: "x" })).rejects.toThrow(/no executor/)
	})

	it("exposes ids/has and ownerOf for assigned tasks", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new ExecutorPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })

		expect(pool.ids()).toEqual(["A", "B"])
		expect(pool.has("A")).toBe(true)
		expect(pool.has("Z")).toBe(false)
		expect(pool.ownerOf("nope")).toBeUndefined()

		const t1 = await pool.createTask({ prompt: "1" }) // → A
		const t2 = await pool.createTask({ prompt: "2" }) // → B
		expect(pool.ownerOf(t1.taskId)).toBe("A")
		expect(pool.ownerOf(t2.taskId)).toBe("B")
	})

	it("pickNext advances round-robin without dispatching; createTaskOn dispatches to a specific executor", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new ExecutorPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })

		// pickNext advances the cursor but dispatches nothing.
		expect(pool.pickNext()).toBe("A")
		expect(pool.pickNext()).toBe("B")
		expect(a.api.createTask).not.toHaveBeenCalled()
		expect(b.api.createTask).not.toHaveBeenCalled()
		expect(pool.assignableIds()).toEqual(["A", "B"])

		// createTaskOn dispatches to exactly the named executor and records ownership.
		const t = await pool.createTaskOn("B", { prompt: "hi" })
		expect(b.api.createTask).toHaveBeenCalledTimes(1)
		expect(a.api.createTask).not.toHaveBeenCalled()
		expect(pool.ownerOf(t.taskId)).toBe("B")

		// createTaskOn on an unknown id throws.
		await expect(pool.createTaskOn("Z", { prompt: "x" })).rejects.toThrow(/unknown executor/)
	})

	it("assignOwner records ownership for an out-of-band task (Local bypass) without dispatch", async () => {
		const a = makeExecutor("A")
		const pool = new ExecutorPool()
		pool.add({ id: a.id, api: a.api })
		pool.assignOwner("local-task-1", "A")
		expect(pool.ownerOf("local-task-1")).toBe("A")
		expect(a.api.createTask).not.toHaveBeenCalled()
	})

	it("pickNext returns undefined when no executor is assignable", () => {
		const pool = new ExecutorPool()
		expect(pool.pickNext()).toBeUndefined()
		expect(pool.assignableIds()).toEqual([])
	})

	it("round-robins over enabled executors and skips a runtime-disabled one via setDisabled", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const c = makeExecutor("C")
		const pool = new ExecutorPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })
		pool.add({ id: c.id, api: c.api })

		// Distributes across all three enabled executors.
		const first = await Promise.all([
			pool.createTask({ prompt: "1" }),
			pool.createTask({ prompt: "2" }),
			pool.createTask({ prompt: "3" }),
		])
		expect(first.map((t) => pool.ownerOf(t.taskId)).sort()).toEqual(["A", "B", "C"])

		// Disable B at runtime → subsequent assignments never land on B.
		pool.setDisabled("B", true)
		const after = await Promise.all([
			pool.createTask({ prompt: "4" }),
			pool.createTask({ prompt: "5" }),
			pool.createTask({ prompt: "6" }),
		])
		const owners = after.map((t) => pool.ownerOf(t.taskId))
		expect(owners).not.toContain("B")
		expect(new Set(owners)).toEqual(new Set(["A", "C"]))

		// Re-enable B → it returns to the rotation.
		pool.setDisabled("B", false)
		const backCalls = (b.api.createTask as ReturnType<typeof vi.fn>).mock.calls.length
		for (let i = 0; i < 6; i++) await pool.createTask({ prompt: `re-${i}` })
		expect((b.api.createTask as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(backCalls)
	})
})
