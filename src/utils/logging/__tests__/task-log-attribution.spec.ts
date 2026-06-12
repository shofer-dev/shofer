// npx vitest utils/logging/__tests__/task-log-attribution.spec.ts

import { CompactTransport } from "../CompactTransport"
import { runWithLogTaskContext } from "../logContext"
import type { TaskScopedLogLine } from "../types"

/**
 * Verifies the per-task log attribution wired through the AsyncLocalStorage log
 * context: lines emitted inside `runWithLogTaskContext` are buffered under the
 * owning task id and streamed to listeners; lines outside any context are not.
 */
describe("CompactTransport task-scoped logs", () => {
	let transport: CompactTransport

	const write = (taskMsg: string) => transport.write({ t: Date.now(), l: "info", m: taskMsg, c: "Task" })

	beforeEach(() => {
		transport = new CompactTransport(undefined, { level: "debug" })
	})

	afterEach(() => transport.close())

	test("attributes lines to the task on the async context", async () => {
		await runWithLogTaskContext({ taskId: "task-A" }, async () => {
			write("a1")
			await Promise.resolve()
			write("a2") // still attributed after an await
		})

		const logs = transport.getTaskLogs("task-A")
		expect(logs.map((l) => l.message)).toEqual(["a1", "a2"])
		expect(logs.every((l) => l.ctx === "Task" && l.level === "info")).toBe(true)
	})

	test("does not attribute lines emitted outside any context", () => {
		write("orphan")
		expect(transport.getTaskLogs("task-A")).toEqual([])
	})

	test("keeps separate buffers per task and isolates nested child contexts", async () => {
		await runWithLogTaskContext({ taskId: "parent" }, async () => {
			write("p1")
			await runWithLogTaskContext({ taskId: "child" }, async () => {
				write("c1") // child context overrides parent for its subtree
			})
			write("p2")
		})

		expect(transport.getTaskLogs("parent").map((l) => l.message)).toEqual(["p1", "p2"])
		expect(transport.getTaskLogs("child").map((l) => l.message)).toEqual(["c1"])
	})

	test("appends the data payload to the buffered message", () => {
		runWithLogTaskContext({ taskId: "t" }, () => {
			transport.write({ t: Date.now(), l: "warn", m: "with data", c: "API", d: { code: 429 } })
		})
		expect(transport.getTaskLogs("t")[0].message).toBe('with data {"code":429}')
	})

	test("notifies registered listeners and supports unsubscribe", () => {
		const seen: Array<{ taskId: string; line: TaskScopedLogLine }> = []
		const unsub = transport.addTaskLogListener((taskId, line) => seen.push({ taskId, line }))

		runWithLogTaskContext({ taskId: "t" }, () => write("first"))
		unsub()
		runWithLogTaskContext({ taskId: "t" }, () => write("second"))

		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ taskId: "t", line: { message: "first" } })
	})

	test("clearTaskLogs drops a task's buffer", () => {
		runWithLogTaskContext({ taskId: "t" }, () => write("x"))
		expect(transport.getTaskLogs("t")).toHaveLength(1)
		transport.clearTaskLogs("t")
		expect(transport.getTaskLogs("t")).toEqual([])
	})

	test("respects the level filter for task buffers", () => {
		transport.setLevel("warn")
		runWithLogTaskContext({ taskId: "t" }, () => {
			transport.write({ t: Date.now(), l: "info", m: "dropped", c: "Task" })
			transport.write({ t: Date.now(), l: "error", m: "kept", c: "Task" })
		})
		expect(transport.getTaskLogs("t").map((l) => l.message)).toEqual(["kept"])
	})
})
