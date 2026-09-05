import { render } from "ink-testing-library"

import type { TodoItem } from "@shofer/types"

import { resetNerdFontCache } from "../Icon.js"
import TodoDisplay from "../TodoDisplay.js"

/**
 * The `showChangesOnly` diff mode, which the behaviour-focused sibling suite
 * does not exercise.
 */
describe("TodoDisplay diff mode", () => {
	beforeEach(() => {
		process.env.SHOFER_NERD_FONT = "0"
		resetNerdFontCache()
	})

	afterEach(() => {
		delete process.env.SHOFER_NERD_FONT
		resetNerdFontCache()
	})

	const todo = (over: Partial<TodoItem> & { id: string }): TodoItem =>
		({ content: `task ${over.id}`, status: "pending", ...over }) as TodoItem

	it("shows an item whose status changed", () => {
		const previousTodos = [todo({ id: "1", status: "pending" })]
		const todos = [todo({ id: "1", status: "completed" })]

		const { lastFrame } = render(
			<TodoDisplay todos={todos} previousTodos={previousTodos} showChangesOnly showProgress={false} />,
		)

		expect(lastFrame()).toContain("task 1")
		expect(lastFrame()).toContain("done")
	})

	it("shows an item that is new since the previous list", () => {
		const previousTodos = [todo({ id: "1", status: "pending" })]
		const todos = [todo({ id: "1", status: "pending" }), todo({ id: "2", status: "pending" })]

		const { lastFrame } = render(
			<TodoDisplay todos={todos} previousTodos={previousTodos} showChangesOnly showProgress={false} />,
		)
		const output = lastFrame() ?? ""

		expect(output).toContain("task 2")
		expect(output).not.toContain("task 1")
	})

	it("renders nothing when no item changed", () => {
		const same = [todo({ id: "1", status: "pending" })]

		const { lastFrame } = render(
			<TodoDisplay todos={same} previousTodos={same} showChangesOnly showProgress={false} />,
		)

		expect(lastFrame()).toBe("")
	})

	it("labels a started item", () => {
		const previousTodos = [todo({ id: "1", status: "pending" })]
		const todos = [todo({ id: "1", status: "in_progress" })]

		const { lastFrame } = render(<TodoDisplay todos={todos} previousTodos={previousTodos} showProgress={false} />)

		expect(lastFrame()).toContain("started")
	})

	it("labels an item that moved back to pending as reset", () => {
		const previousTodos = [todo({ id: "1", status: "completed" })]
		const todos = [todo({ id: "1", status: "pending" })]

		const { lastFrame } = render(<TodoDisplay todos={todos} previousTodos={previousTodos} showProgress={false} />)

		expect(lastFrame()).toContain("reset")
	})

	it("matches a previous item by content when the ids differ", () => {
		const previousTodos = [todo({ id: "old", content: "shared text", status: "pending" })]
		const todos = [todo({ id: "new", content: "shared text", status: "pending" })]

		const { lastFrame } = render(
			<TodoDisplay todos={todos} previousTodos={previousTodos} showChangesOnly showProgress={false} />,
		)

		// Matched by content and unchanged, so the diff view is empty.
		expect(lastFrame()).toBe("")
	})

	it("shows every item when the previous list is empty, even in diff mode", () => {
		const todos = [todo({ id: "1" }), todo({ id: "2" })]

		const { lastFrame } = render(<TodoDisplay todos={todos} showChangesOnly showProgress={false} />)
		const output = lastFrame() ?? ""

		expect(output).toContain("task 1")
		expect(output).toContain("task 2")
	})
})
