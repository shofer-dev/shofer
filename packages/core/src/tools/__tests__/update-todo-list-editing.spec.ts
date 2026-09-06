import {
	addTodoToTask,
	getTodoListForTask,
	parseMarkdownChecklist,
	removeTodoFromTask,
	restoreTodoListForTask,
	setTodoListForTask,
	updateTodoStatusForTask,
	UpdateTodoListTool,
} from "../UpdateTodoListTool.js"
import { makeToolCallbacks, toolResults } from "./helpers/fakeEditTask.js"

/**
 * `update_todo_list` takes a markdown checklist, normalizes it, and — crucially
 * — lets the USER edit the list inside the approval prompt. That editing path
 * is the one worth pinning: the webview mutates `task.pendingTodoApproval` while
 * the tool is awaiting approval, and the tool must adopt what came back rather
 * than the list it proposed, tell the model that the user edited it, and say so
 * with the edited markdown.
 *
 * The per-task snapshot (rather than a module-level global) is what keeps two
 * concurrent tasks from overwriting each other's pending list.
 */

function buildTask(overrides: Record<string, any> = {}) {
	return {
		taskId: "task-1",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		todoList: undefined as unknown,
		pendingTodoApproval: undefined as unknown,
		shoferMessages: [],
		recordToolError: vi.fn(),
		say: vi.fn(),
		ask: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as any
}

describe("parseMarkdownChecklist", () => {
	it("reads the three checkbox states, with or without a leading dash", () => {
		const todos = parseMarkdownChecklist(
			["[ ] pending", "- [x] done", "[-] in progress", "[~] also in progress"].join("\n"),
		)

		expect(todos.map((t) => [t.content, t.status])).toEqual([
			["pending", "pending"],
			["done", "completed"],
			["in progress", "in_progress"],
			["also in progress", "in_progress"],
		])
	})

	it("gives each item a content-derived id, so the same list parses identically", () => {
		const [first] = parseMarkdownChecklist("[ ] same")
		const [second] = parseMarkdownChecklist("[ ] same")

		expect(first!.id).toBe(second!.id)
		// The status is part of the id, so a state change is a different item.
		expect(parseMarkdownChecklist("[x] same")[0]!.id).not.toBe(first!.id)
	})

	it("ignores lines that are not checklist items, and non-string input", () => {
		expect(parseMarkdownChecklist("just prose\n\n[ ] real")).toHaveLength(1)
		expect(parseMarkdownChecklist(undefined as never)).toEqual([])
	})
})

describe("UpdateTodoListTool.execute", () => {
	it("normalizes and stores the list, then confirms to the model", async () => {
		const task = buildTask()
		const cbs = makeToolCallbacks()

		await new UpdateTodoListTool().execute({ todos: "[ ] one\n[x] two" }, task, cbs)

		expect(task.todoList.map((t: { content: string; status: string }) => [t.content, t.status])).toEqual([
			["one", "pending"],
			["two", "completed"],
		])
		expect(toolResults(cbs)).toContain("Todo list updated successfully.")
		// The pending snapshot is released once the decision is in.
		expect(task.pendingTodoApproval).toBeUndefined()
	})

	it("reports the user's decline without touching the stored list", async () => {
		const task = buildTask({ todoList: [{ id: "x", content: "kept", status: "pending" }] })
		const cbs = makeToolCallbacks(false)

		await new UpdateTodoListTool().execute({ todos: "[ ] replacement" }, task, cbs)

		expect(task.todoList).toEqual([{ id: "x", content: "kept", status: "pending" }])
		expect(task.pendingTodoApproval).toBeUndefined()
		expect(toolResults(cbs)).toBe("User declined to update the todoList.")
	})

	it("adopts the list the USER edited during approval and hands it back as markdown", async () => {
		const task = buildTask()
		const cbs = makeToolCallbacks()
		// What the webview does while the tool is awaiting the decision.
		cbs.askApproval = vi.fn(async () => {
			task.pendingTodoApproval = [
				{ id: "e1", content: "edited by the user", status: "in_progress" },
				{ id: "e2", content: "and another", status: "completed" },
			]
			return true
		})

		await new UpdateTodoListTool().execute({ todos: "[ ] what the model proposed" }, task, cbs)

		expect(task.todoList.map((t: { content: string }) => t.content)).toEqual(["edited by the user", "and another"])
		expect(task.say).toHaveBeenCalledWith("user_edit_todos", expect.stringContaining("edited by the user"))
		const result = toolResults(cbs)
		expect(result).toContain("User edits todo:")
		expect(result).toContain("[-] edited by the user")
		expect(result).toContain("[x] and another")
	})

	it("treats an empty list as a valid clear", async () => {
		const task = buildTask({ todoList: [{ id: "x", content: "old", status: "pending" }] })
		const cbs = makeToolCallbacks()

		await new UpdateTodoListTool().execute({ todos: "" }, task, cbs)

		expect(task.todoList).toEqual([])
		expect(toolResults(cbs)).toContain("Todo list updated successfully.")
	})

	it("routes a failure through handleError", async () => {
		const task = buildTask()
		const cbs = makeToolCallbacks()
		cbs.askApproval = vi.fn().mockRejectedValue(new Error("boom"))

		await new UpdateTodoListTool().execute({ todos: "[ ] one" }, task, cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("update todo list", expect.any(Error))
	})

	it("renders the parsed list while the call is still streaming", async () => {
		const task = buildTask()

		await new UpdateTodoListTool().handlePartial(task, {
			type: "tool_use",
			name: "update_todo_list",
			params: { todos: "[ ] streaming" },
			partial: true,
		} as never)

		const payload = JSON.parse(task.ask.mock.calls[0]![1])
		expect(payload.tool).toBe("updateTodoList")
		expect(payload.todos[0].content).toBe("streaming")
	})
})

describe("todo-list helpers", () => {
	it("adds, reads and removes items", () => {
		const task = buildTask()

		const todo = addTodoToTask(task, "first")
		addTodoToTask(task, "second", "completed", "fixed-id")

		expect(getTodoListForTask(task)!.map((t) => t.content)).toEqual(["first", "second"])
		expect(removeTodoFromTask(task, todo.id)).toBe(true)
		expect(removeTodoFromTask(task, "no-such-id")).toBe(false)
		expect(getTodoListForTask(task)!.map((t) => t.id)).toEqual(["fixed-id"])
	})

	it("returns a COPY of the list, so a caller cannot mutate the task's own", () => {
		const task = buildTask()
		addTodoToTask(task, "first")

		getTodoListForTask(task)!.pop()

		expect(getTodoListForTask(task)).toHaveLength(1)
	})

	it("advances a status only along pending → in_progress → completed", () => {
		const task = buildTask()
		const todo = addTodoToTask(task, "work")

		expect(updateTodoStatusForTask(task, todo.id, "completed")).toBe(false)
		expect(updateTodoStatusForTask(task, todo.id, "in_progress")).toBe(true)
		expect(updateTodoStatusForTask(task, todo.id, "completed")).toBe(true)
		// Re-asserting the current status is allowed; going back is not.
		expect(updateTodoStatusForTask(task, todo.id, "completed")).toBe(true)
		expect(updateTodoStatusForTask(task, todo.id, "pending")).toBe(false)
	})

	it("refuses a status change for an unknown id or an absent list", () => {
		expect(updateTodoStatusForTask(buildTask(), "x", "in_progress")).toBe(false)
		expect(removeTodoFromTask(buildTask(), "x")).toBe(false)
	})

	it("sets an absent or non-array list to the empty list", async () => {
		const task = buildTask()
		await setTodoListForTask(task, undefined)
		expect(task.todoList).toEqual([])

		// A missing task is a no-op rather than a throw.
		await expect(setTodoListForTask(undefined, [])).resolves.toBeUndefined()
	})

	it("restores an explicit list, and otherwise recovers the latest one from the messages", () => {
		const task = buildTask()
		restoreTodoListForTask(task, [{ id: "a", content: "explicit", status: "pending" }])
		expect(task.todoList).toEqual([{ id: "a", content: "explicit", status: "pending" }])

		const fromMessages = buildTask({
			shoferMessages: [
				{
					ts: 1,
					type: "ask",
					ask: "tool",
					text: JSON.stringify({
						tool: "updateTodoList",
						todos: [{ id: "b", content: "from history", status: "pending" }],
					}),
				},
			],
		})
		restoreTodoListForTask(fromMessages)
		expect(fromMessages.todoList).toEqual([{ id: "b", content: "from history", status: "pending" }])
	})
})
