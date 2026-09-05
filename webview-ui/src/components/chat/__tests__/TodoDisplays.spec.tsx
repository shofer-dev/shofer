// npx vitest src/components/chat/__tests__/TodoDisplays.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import { TodoListDisplay } from "../TodoListDisplay"
import { TodoChangeDisplay } from "../TodoChangeDisplay"

vi.mock("i18next", () => ({
	t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${Object.values(opts).join("/")}` : key),
}))

describe("TodoListDisplay", () => {
	it("renders nothing for an empty list", () => {
		const { container } = render(<TodoListDisplay todos={[]} />)
		expect(container).toBeEmptyDOMElement()
	})

	it("collapsed, it surfaces the in-progress item and the completed count", () => {
		render(
			<TodoListDisplay
				todos={[
					{ id: "1", content: "done one", status: "completed" },
					{ id: "2", content: "the current one", status: "in_progress" },
					{ id: "3", content: "later", status: "pending" },
				]}
			/>,
		)
		expect(screen.getByText("the current one")).toBeInTheDocument()
		expect(screen.getByText("1/3")).toBeInTheDocument()
	})

	it("collapsed with no in-progress item, it shows the first unfinished one", () => {
		render(
			<TodoListDisplay
				todos={[
					{ id: "1", content: "done", status: "completed" },
					{ id: "2", content: "next up", status: "pending" },
				]}
			/>,
		)
		expect(screen.getByText("next up")).toBeInTheDocument()
	})

	it("reports completion once every todo is done", () => {
		render(
			<TodoListDisplay
				todos={[
					{ id: "1", content: "a", status: "completed" },
					{ id: "2", content: "b", status: "completed" },
				]}
			/>,
		)
		expect(screen.getByText("chat:todo.complete:2")).toBeInTheDocument()
		expect(screen.queryByText("2/2")).not.toBeInTheDocument()
	})

	it("expands to the full list on click and reports the partial progress", () => {
		render(
			<TodoListDisplay
				todos={[
					{ id: "1", content: "first", status: "completed" },
					{ id: "2", content: "second", status: "in_progress" },
					{ id: "3", content: "third", status: "pending" },
				]}
			/>,
		)

		fireEvent.click(screen.getByText("second"))
		expect(screen.getByText("chat:todo.partial:1/3")).toBeInTheDocument()
		expect(screen.getByText("first")).toBeInTheDocument()
		expect(screen.getByText("third")).toBeInTheDocument()
	})

	it("expands a list whose todos are all complete (no scroll target)", () => {
		render(<TodoListDisplay todos={[{ id: "1", content: "only", status: "completed" }]} />)
		fireEvent.click(screen.getByText("chat:todo.complete:1"))
		expect(screen.getByText("only")).toBeInTheDocument()
	})
})

describe("TodoChangeDisplay", () => {
	it("renders nothing when nothing changed", () => {
		const { container } = render(
			<TodoChangeDisplay
				previousTodos={[{ id: "1", content: "a", status: "completed" }]}
				newTodos={[{ id: "1", content: "a", status: "completed" }]}
			/>,
		)
		expect(container).toBeEmptyDOMElement()
	})

	it("shows the whole list on the first update", () => {
		render(
			<TodoChangeDisplay
				previousTodos={[]}
				newTodos={[
					{ id: "1", content: "first", status: "pending" },
					{ id: "2", content: "second", status: "in_progress" },
				]}
			/>,
		)
		expect(screen.getByText("chat:todo.updated")).toBeInTheDocument()
		expect(screen.getByText("first")).toBeInTheDocument()
		expect(screen.getByText("second")).toBeInTheDocument()
	})

	it("afterwards shows only the todos that just completed or just started", () => {
		render(
			<TodoChangeDisplay
				previousTodos={[
					{ id: "1", content: "a", status: "in_progress" },
					{ id: "2", content: "b", status: "pending" },
					{ id: "3", content: "c", status: "completed" },
				]}
				newTodos={[
					{ id: "1", content: "a", status: "completed" },
					{ id: "2", content: "b", status: "in_progress" },
					{ id: "3", content: "c", status: "completed" },
				]}
			/>,
		)
		expect(screen.getByText("a")).toBeInTheDocument()
		expect(screen.getByText("b")).toBeInTheDocument()
		// `c` was already completed — not a change.
		expect(screen.queryByText("c")).not.toBeInTheDocument()
	})

	it("matches a todo by content when it carries no id", () => {
		const { container } = render(
			<TodoChangeDisplay
				previousTodos={[{ content: "same text", status: "completed" }]}
				newTodos={[{ content: "same text", status: "completed" }]}
			/>,
		)
		expect(container).toBeEmptyDOMElement()
	})

	it("treats a todo the previous list never had as newly changed", () => {
		render(
			<TodoChangeDisplay
				previousTodos={[{ id: "1", content: "a", status: "pending" }]}
				newTodos={[{ id: "9", content: "brand new", status: "completed" }]}
			/>,
		)
		expect(screen.getByText("brand new")).toBeInTheDocument()
	})

	it("defaults a status-less todo to pending", () => {
		render(<TodoChangeDisplay previousTodos={[]} newTodos={[{ id: "1", content: "no status" }]} />)
		expect(screen.getByText("no status")).toBeInTheDocument()
	})
})
