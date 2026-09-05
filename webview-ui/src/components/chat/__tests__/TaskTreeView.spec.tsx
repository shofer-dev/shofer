// npx vitest src/components/chat/__tests__/TaskTreeView.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { HistoryItem } from "@shofer/types"

import TaskTreeView from "../TaskTreeView"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

const item = (over: Partial<HistoryItem> & { id: string }): HistoryItem =>
	({
		ts: 1,
		task: `task ${over.id}`,
		tokensIn: 0,
		tokensOut: 0,
		cacheWrites: 0,
		cacheReads: 0,
		totalCost: 0,
		...over,
	}) as HistoryItem

beforeEach(() => vi.clearAllMocks())

describe("TaskTreeView", () => {
	it("says so when there is nothing to show", () => {
		render(<TaskTreeView taskHistory={[]} />)
		expect(screen.getByText("No tasks in history.")).toBeInTheDocument()
	})

	it("renders the whole forest when no root is given", () => {
		render(
			<TaskTreeView
				taskHistory={[item({ id: "a", task: "first root" }), item({ id: "b", task: "second root" })]}
			/>,
		)
		expect(screen.getByText("first root")).toBeInTheDocument()
		expect(screen.getByText("second root")).toBeInTheDocument()
	})

	it("scopes to the focused task's tree", () => {
		render(
			<TaskTreeView
				rootTaskId="root"
				taskHistory={[
					item({ id: "root", task: "in scope" }),
					item({ id: "kid", parentTaskId: "root", rootTaskId: "root", task: "also in scope" }),
					item({ id: "far", rootTaskId: "elsewhere", task: "out of scope" }),
				]}
			/>,
		)
		expect(screen.getByText("in scope")).toBeInTheDocument()
		expect(screen.getByText("also in scope")).toBeInTheDocument()
		expect(screen.queryByText("out of scope")).not.toBeInTheDocument()
	})

	it("orders siblings newest first and draws the branch connectors", () => {
		const { container } = render(
			<TaskTreeView
				taskHistory={[
					item({ id: "root", createdAt: 1, task: "root" }),
					item({ id: "old", parentTaskId: "root", createdAt: 2, task: "older child" }),
					item({ id: "new", parentTaskId: "root", createdAt: 3, task: "newer child" }),
					item({ id: "gk", parentTaskId: "new", createdAt: 4, task: "grandchild" }),
				]}
			/>,
		)
		const titles = Array.from(container.querySelectorAll("span.truncate")).map((n) => n.textContent)
		expect(titles).toEqual(["root", "newer child", "grandchild", "older child"])
		// The last sibling gets the corner connector, the others the tee.
		expect(container.textContent).toContain("└─")
		expect(container.textContent).toContain("├─")
	})

	it("focuses a task when its row is clicked", () => {
		render(<TaskTreeView taskHistory={[item({ id: "root", task: "clickable" })]} />)
		fireEvent.click(screen.getByText("clickable"))
		expect(postMessage).toHaveBeenCalledWith({ type: "focusParallelTask", taskId: "root" })
	})

	it("shows the mode badge, active time, tokens and cost only when they carry information", () => {
		const { rerender } = render(<TaskTreeView taskHistory={[item({ id: "bare", task: "bare" })]} />)
		expect(screen.queryByText(/tok$/)).not.toBeInTheDocument()
		expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()

		rerender(
			<TaskTreeView
				taskHistory={[
					item({
						id: "rich",
						task: "rich",
						mode: "code",
						activeTimeMs: 95_000,
						tokensIn: 1200,
						tokensOut: 300,
						totalCost: 0.125,
					}),
				]}
			/>,
		)
		expect(screen.getByText("code")).toBeInTheDocument()
		expect(screen.getByText("1m 35s")).toBeInTheDocument()
		expect(screen.getByText("1.5K tok")).toBeInTheDocument()
		expect(screen.getByText("$0.13")).toBeInTheDocument()
	})

	it("formats a sub-minute duration and a sub-thousand token count without a unit suffix", () => {
		render(
			<TaskTreeView
				taskHistory={[item({ id: "s", task: "short", activeTimeMs: 12_000, tokensIn: 40, tokensOut: 2 })]}
			/>,
		)
		expect(screen.getByText("12s")).toBeInTheDocument()
		expect(screen.getByText("42 tok")).toBeInTheDocument()
	})

	it("drops the seconds from a whole-minute duration", () => {
		render(<TaskTreeView taskHistory={[item({ id: "s", task: "round", activeTimeMs: 120_000 })]} />)
		expect(screen.getByText("2m")).toBeInTheDocument()
	})

	it("gives a running task a pulsing dot and a completed-well task the rating colour", () => {
		const { container } = render(
			<TaskTreeView
				taskHistory={[
					item({ id: "r", task: "running", taskState: { lifecycle: "running" } }),
					item({ id: "c", task: "done", taskState: { lifecycle: "completed", rating: "well" } }),
					item({ id: "u", task: "unknown", taskState: { lifecycle: "nonsense" } as never }),
				]}
			/>,
		)
		expect(container.querySelector(".animate-pulse")).toBeTruthy()
		expect(container.querySelectorAll(".rounded-full")).toHaveLength(3)
	})

	it("treats an orphaned child (parent absent from history) as a root", () => {
		render(<TaskTreeView taskHistory={[item({ id: "orphan", parentTaskId: "gone", task: "orphan" })]} />)
		expect(screen.getByText("orphan")).toBeInTheDocument()
	})
})
