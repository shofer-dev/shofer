// npx vitest src/components/chat/__tests__/UpdateTodoListToolBlock.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import UpdateTodoListToolBlock from "../UpdateTodoListToolBlock"

vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown?: string }) => <div data-testid="markdown">{markdown}</div>,
}))

const onChange = vi.fn()

const todos = [
	{ id: "a", content: "write the spec", status: "" },
	{ id: "b", content: "run the suite", status: "in_progress" },
	{ id: "c", content: "ship it", status: "completed" },
]

const enterEditMode = () => fireEvent.click(screen.getByText("Edit"))

beforeEach(() => vi.clearAllMocks())

describe("UpdateTodoListToolBlock", () => {
	it("renders the user-edit variant with no list at all", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} userEdited />)
		expect(screen.getByText("User Edit")).toBeInTheDocument()
		expect(screen.queryByText("write the spec")).not.toBeInTheDocument()
	})

	it("falls back to the raw markdown when there are no todos", () => {
		render(<UpdateTodoListToolBlock todos={[]} content="- [ ] something" onChange={onChange} />)
		expect(screen.getByTestId("markdown")).toHaveTextContent("- [ ] something")
	})

	it("lists every todo read-only until Edit is pressed", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		expect(screen.getByText("write the spec")).toBeInTheDocument()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()

		enterEditMode()
		expect(screen.getAllByRole("textbox")).toHaveLength(3)
		expect(screen.getByText("Done")).toBeInTheDocument()
	})

	it("hides the Edit affordance when editing is not allowed", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} editable={false} />)
		expect(screen.queryByText("Edit")).not.toBeInTheDocument()
	})

	it("leaves edit mode when the parent revokes editability", () => {
		const { rerender } = render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()
		expect(screen.getAllByRole("textbox")).toHaveLength(3)

		rerender(<UpdateTodoListToolBlock todos={todos} onChange={onChange} editable={false} />)
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})

	it("reports an edited content back to the caller", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()

		fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "write the specs" } })
		expect(onChange).toHaveBeenCalledWith([
			expect.objectContaining({ id: "a", content: "write the specs" }),
			expect.objectContaining({ id: "b" }),
			expect.objectContaining({ id: "c" }),
		])
	})

	it("reports a status change", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()

		fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "completed" } })
		expect(onChange).toHaveBeenCalledWith([
			expect.objectContaining({ id: "a", status: "completed" }),
			expect.objectContaining({ id: "b" }),
			expect.objectContaining({ id: "c" }),
		])
	})

	it("confirms before deleting, and can be cancelled", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()

		fireEvent.click(screen.getAllByTitle("Remove")[0])
		expect(screen.getByText("Are you sure you want to delete this todo item?")).toBeInTheDocument()

		fireEvent.click(screen.getByText("Cancel"))
		expect(onChange).not.toHaveBeenCalled()
		expect(screen.getByDisplayValue("write the spec")).toBeInTheDocument()
	})

	it("removes the todo once the deletion is confirmed", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()

		fireEvent.click(screen.getAllByTitle("Remove")[0])
		fireEvent.click(screen.getByText("Delete"))
		expect(onChange).toHaveBeenCalledWith([
			expect.objectContaining({ id: "b" }),
			expect.objectContaining({ id: "c" }),
		])
	})

	it("dismisses the confirmation on a backdrop click but not on a dialog click", () => {
		const { container } = render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()
		fireEvent.click(screen.getAllByTitle("Remove")[0])

		const backdrop = container.querySelector('[style*="position: fixed"]') as HTMLElement
		fireEvent.click(backdrop.firstElementChild as HTMLElement)
		expect(screen.getByText("Are you sure you want to delete this todo item?")).toBeInTheDocument()

		fireEvent.click(backdrop)
		expect(screen.queryByText("Are you sure you want to delete this todo item?")).not.toBeInTheDocument()
	})

	it("raises the delete confirmation when a todo is blurred empty", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()

		fireEvent.blur(screen.getAllByRole("textbox")[0], { target: { value: "   " } })
		expect(screen.getByText("Are you sure you want to delete this todo item?")).toBeInTheDocument()
	})

	it("leaves a non-empty todo alone on blur", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()

		fireEvent.blur(screen.getAllByRole("textbox")[0], { target: { value: "still here" } })
		expect(screen.queryByText("Are you sure you want to delete this todo item?")).not.toBeInTheDocument()
	})

	it("adds a todo through the inline composer", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()
		fireEvent.click(screen.getByText("+ Add Todo"))

		const composer = screen.getByPlaceholderText("Enter todo item, press Enter to add")
		expect(screen.getByText("Add").closest("button")).toBeDisabled()

		fireEvent.change(composer, { target: { value: "  a fourth  " } })
		fireEvent.click(screen.getByText("Add"))

		expect(onChange).toHaveBeenCalledWith([
			expect.objectContaining({ id: "a" }),
			expect.objectContaining({ id: "b" }),
			expect.objectContaining({ id: "c" }),
			expect.objectContaining({ content: "a fourth", status: "" }),
		])
		expect(screen.queryByPlaceholderText("Enter todo item, press Enter to add")).not.toBeInTheDocument()
	})

	it("adds on Enter and abandons the composer on Escape", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()

		fireEvent.click(screen.getByText("+ Add Todo"))
		let composer = screen.getByPlaceholderText("Enter todo item, press Enter to add")
		fireEvent.change(composer, { target: { value: "by keyboard" } })
		fireEvent.keyDown(composer, { key: "Enter" })
		expect(onChange).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ content: "by keyboard" })]),
		)

		onChange.mockClear()
		fireEvent.click(screen.getByText("+ Add Todo"))
		composer = screen.getByPlaceholderText("Enter todo item, press Enter to add")
		fireEvent.change(composer, { target: { value: "abandoned" } })
		fireEvent.keyDown(composer, { key: "Escape" })
		expect(onChange).not.toHaveBeenCalled()
		expect(screen.queryByPlaceholderText("Enter todo item, press Enter to add")).not.toBeInTheDocument()
	})

	it("refuses a whitespace-only addition on Enter", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()
		fireEvent.click(screen.getByText("+ Add Todo"))

		const composer = screen.getByPlaceholderText("Enter todo item, press Enter to add")
		fireEvent.change(composer, { target: { value: "   " } })
		fireEvent.keyDown(composer, { key: "Enter" })
		expect(onChange).not.toHaveBeenCalled()
		expect(screen.getByPlaceholderText("Enter todo item, press Enter to add")).toBeInTheDocument()
	})

	it("cancels the composer from its Cancel button", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		enterEditMode()
		fireEvent.click(screen.getByText("+ Add Todo"))
		fireEvent.click(screen.getByText("Cancel"))
		expect(screen.queryByPlaceholderText("Enter todo item, press Enter to add")).not.toBeInTheDocument()
	})

	it("mints ids for todos that arrive without one, and resyncs when the props change", () => {
		const { rerender } = render(<UpdateTodoListToolBlock todos={[{ content: "no id" }]} onChange={onChange} />)
		expect(screen.getByText("no id")).toBeInTheDocument()

		rerender(<UpdateTodoListToolBlock todos={[{ content: "replaced" }]} onChange={onChange} />)
		expect(screen.getByText("replaced")).toBeInTheDocument()
		expect(screen.queryByText("no id")).not.toBeInTheDocument()
	})
})
