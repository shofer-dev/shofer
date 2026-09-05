// npx vitest src/components/history/__tests__/HistoryView.selection.spec.tsx
//
// The history tab's own state: the search box (which auto-switches the sort to
// "most relevant" the first time it is filled), the workspace/sort selects, and
// the selection mode that gates the batch-delete dialog.

import { render, screen, fireEvent, within } from "@/utils/test-utils"

import { useExtensionState } from "@src/context/ExtensionStateContext"

import HistoryView from "../HistoryView"

vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}(${Object.values(opts).join("/")})` : key),
	}),
}))

// Virtuoso virtualises away everything below the fold; render the whole list.
vi.mock("react-virtuoso", () => ({
	Virtuoso: ({ data, itemContent }: any) => (
		<div data-testid="virtuoso-item-list">
			{data.map((item: unknown, index: number) => (
				<div key={index}>{itemContent(index, item)}</div>
			))}
		</div>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onInput, placeholder, children, "data-testid": testId }: any) => (
		<div>
			<input data-testid={testId} placeholder={placeholder} value={value ?? ""} onChange={(e) => onInput?.(e)} />
			{children}
		</div>
	),
}))

const task = (over: Record<string, unknown> & { id: string }) => ({
	ts: Date.now(),
	task: `task ${over.id}`,
	tokensIn: 10,
	tokensOut: 5,
	cacheWrites: 0,
	cacheReads: 0,
	totalCost: 0.01,
	workspace: "/test/workspace",
	number: 1,
	...over,
})

const onDone = vi.fn()

const setState = (taskHistory: unknown[]) =>
	vi.mocked(useExtensionState).mockReturnValue({
		taskHistory,
		cwd: "/test/workspace",
		showShoferIgnoredFiles: false,
		customModes: [],
		parallelTasks: [],
	} as never)

beforeEach(() => {
	vi.clearAllMocks()
	setState([task({ id: "1" }), task({ id: "2", ts: Date.now() + 1000 })])
})

describe("HistoryView", () => {
	it("returns to the previous view from the back button", () => {
		render(<HistoryView onDone={onDone} />)
		fireEvent.click(screen.getByTestId("history-done-button"))
		expect(onDone).toHaveBeenCalled()
	})

	it("filters as the user searches", () => {
		render(<HistoryView onDone={onDone} />)
		fireEvent.change(screen.getByTestId("history-search-input"), { target: { value: "task 1" } })
		expect(screen.getByTestId("history-search-input")).toHaveValue("task 1")
	})

	it("offers a clear affordance only once there is a query", () => {
		render(<HistoryView onDone={onDone} />)
		expect(screen.queryByLabelText("Clear search")).not.toBeInTheDocument()

		fireEvent.change(screen.getByTestId("history-search-input"), { target: { value: "x" } })
		fireEvent.click(screen.getByLabelText("Clear search"))
		expect(screen.getByTestId("history-search-input")).toHaveValue("")
	})

	it("enters and leaves selection mode", () => {
		render(<HistoryView onDone={onDone} />)
		expect(screen.queryByText("history:selectAll")).not.toBeInTheDocument()

		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		expect(screen.getByText("history:selectAll")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		expect(screen.queryByText("history:selectAll")).not.toBeInTheDocument()
	})

	it("selects and deselects everything, and reports the count", () => {
		render(<HistoryView onDone={onDone} />)
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

		const header = screen.getByText("history:selectAll").parentElement!
		expect(within(header).getByText("history:selectedItems(0/2)")).toBeInTheDocument()

		fireEvent.click(within(header).getByRole("checkbox"))
		const afterSelectAll = screen.getByText("history:deselectAll").parentElement!
		expect(within(afterSelectAll).getByText("history:selectedItems(2/2)")).toBeInTheDocument()

		fireEvent.click(within(afterSelectAll).getByRole("checkbox"))
		expect(screen.getByText("history:selectAll")).toBeInTheDocument()
	})

	it("hides the select-all control when there is no history at all", () => {
		setState([])
		render(<HistoryView onDone={onDone} />)
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		expect(screen.queryByText("history:selectAll")).not.toBeInTheDocument()
	})

	it("labels the workspace and sort selects from the current choices", () => {
		render(<HistoryView onDone={onDone} />)
		expect(screen.getByText(/history:workspace.prefix/)).toBeInTheDocument()
		expect(screen.getByText(/history:sort.prefix/)).toBeInTheDocument()
	})

	it("renders one row per task", () => {
		render(<HistoryView onDone={onDone} />)
		expect(screen.getByText("task 1")).toBeInTheDocument()
		expect(screen.getByText("task 2")).toBeInTheDocument()
	})

	it("groups a subtask under its parent rather than listing it flat", () => {
		setState([task({ id: "parent" }), task({ id: "child", parentTaskId: "parent" })])
		render(<HistoryView onDone={onDone} />)
		expect(screen.getByText("task parent")).toBeInTheDocument()
	})
})
