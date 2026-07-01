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
})
