// npx vitest src/components/chat/__tests__/TaskLogsView.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import type { TaskLogLine } from "@shofer/types"

import TaskLogsView from "../TaskLogsView"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

const line = (over: Partial<TaskLogLine> = {}): TaskLogLine =>
	({ ts: Date.UTC(2026, 0, 1, 12, 0, 0, 0), level: "info", message: "hello", ...over }) as TaskLogLine

const deliver = (data: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})

beforeEach(() => vi.clearAllMocks())

describe("TaskLogsView", () => {
	it("requests a snapshot for the focused task and releases the watch on unmount", () => {
		const { unmount } = render(<TaskLogsView taskId="t1" />)
		expect(postMessage).toHaveBeenCalledWith({ type: "requestTaskLogs", taskId: "t1" })

		unmount()
		expect(postMessage).toHaveBeenLastCalledWith({ type: "requestTaskLogs" })
	})

	it("requests nothing without a task but still releases the watch", () => {
		const { unmount } = render(<TaskLogsView taskId={undefined} />)
		expect(postMessage).not.toHaveBeenCalled()
		unmount()
		expect(postMessage).toHaveBeenCalledWith({ type: "requestTaskLogs" })
	})

	it("shows the empty state until lines arrive", () => {
		render(<TaskLogsView taskId="t1" />)
		expect(screen.getByText("No logs for this task yet")).toBeInTheDocument()
		expect(screen.getByText(/Logs emitted while this task runs/)).toBeInTheDocument()
	})

	it("renders a snapshot with its timestamp, level and context tag", () => {
		render(<TaskLogsView taskId="t1" />)
		deliver({
			type: "taskLogs",
			taskLogTaskId: "t1",
			taskLogs: [line({ message: "first", ctx: "Task" })],
		})
		expect(screen.getByText("first")).toBeInTheDocument()
		expect(screen.getByText("[Task]")).toBeInTheDocument()
		expect(screen.getByText("1 line")).toBeInTheDocument()
	})

	it("appends live lines and pluralises the count", () => {
		render(<TaskLogsView taskId="t1" />)
		deliver({ type: "taskLogs", taskLogTaskId: "t1", taskLogs: [line({ message: "first" })] })
		deliver({
			type: "taskLogAppended",
			taskLogTaskId: "t1",
			taskLogLines: [line({ message: "second", level: "warn" })],
		})
		expect(screen.getByText("second")).toBeInTheDocument()
		expect(screen.getByText("2 lines")).toBeInTheDocument()
	})

	it("drops messages addressed to another task", () => {
		render(<TaskLogsView taskId="t1" />)
		deliver({ type: "taskLogs", taskLogTaskId: "other", taskLogs: [line({ message: "not mine" })] })
		expect(screen.queryByText("not mine")).not.toBeInTheDocument()
	})

	it("treats a missing snapshot array as empty", () => {
		render(<TaskLogsView taskId="t1" />)
		deliver({ type: "taskLogs", taskLogTaskId: "t1" })
		expect(screen.getByText("No logs for this task yet")).toBeInTheDocument()
	})

	it("filters on free text over the message and the context tag", () => {
		render(<TaskLogsView taskId="t1" />)
		deliver({
			type: "taskLogs",
			taskLogTaskId: "t1",
			taskLogs: [line({ message: "alpha", ctx: "Api" }), line({ message: "beta", ctx: "Mcp" })],
		})

		fireEvent.change(screen.getByPlaceholderText("Filter logs…"), { target: { value: "alph" } })
		expect(screen.queryByText("beta")).not.toBeInTheDocument()
		expect(screen.getByText("1 of 2 lines")).toBeInTheDocument()

		fireEvent.change(screen.getByPlaceholderText("Filter logs…"), { target: { value: "mcp" } })
		expect(screen.getByText("beta")).toBeInTheDocument()
	})

	it("says so when the filter matches nothing, and clears back", () => {
		render(<TaskLogsView taskId="t1" />)
		deliver({ type: "taskLogs", taskLogTaskId: "t1", taskLogs: [line({ message: "alpha" })] })

		fireEvent.change(screen.getByPlaceholderText("Filter logs…"), { target: { value: "zzz" } })
		expect(screen.getByText("No log lines match the current filter.")).toBeInTheDocument()

		fireEvent.click(screen.getByTitle("Clear text filter"))
		expect(screen.getByText("alpha")).toBeInTheDocument()
	})

	it("toggles a severity off and back on", () => {
		render(<TaskLogsView taskId="t1" />)
		deliver({
			type: "taskLogs",
			taskLogTaskId: "t1",
			taskLogs: [line({ message: "an info" }), line({ message: "an error", level: "error" })],
		})

		fireEvent.click(screen.getByTitle("Hide error lines"))
		expect(screen.queryByText("an error")).not.toBeInTheDocument()
		expect(screen.getByText("1 of 2 lines")).toBeInTheDocument()

		fireEvent.click(screen.getByTitle("Show error lines"))
		expect(screen.getByText("an error")).toBeInTheDocument()
	})

	it("re-pins to the newest line from the Follow button", () => {
		render(<TaskLogsView taskId="t1" />)
		deliver({ type: "taskLogs", taskLogTaskId: "t1", taskLogs: [line()] })

		const scroller = document.querySelector('[style*="overflow-y: auto"]') as HTMLDivElement
		// jsdom reports zero heights, so scrolling up is simulated by the delta the
		// handler reads rather than by a real layout.
		Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true })
		Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true })
		scroller.scrollTop = 0
		fireEvent.scroll(scroller)
		expect(screen.getByText("Follow")).toBeInTheDocument()

		fireEvent.click(screen.getByText("Follow"))
		expect(screen.getByText("Following")).toBeInTheDocument()
		expect(scroller.scrollTop).toBe(1000)
	})

	it("resumes following once the user scrolls back to the bottom", () => {
		render(<TaskLogsView taskId="t1" />)
		deliver({ type: "taskLogs", taskLogTaskId: "t1", taskLogs: [line()] })

		const scroller = document.querySelector('[style*="overflow-y: auto"]') as HTMLDivElement
		Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true })
		Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true })
		scroller.scrollTop = 0
		fireEvent.scroll(scroller)
		expect(screen.getByText("Follow")).toBeInTheDocument()

		scroller.scrollTop = 900
		fireEvent.scroll(scroller)
		expect(screen.getByText("Following")).toBeInTheDocument()
	})

	it("caps the rendered ring so a flood cannot grow the DOM without bound", () => {
		render(<TaskLogsView taskId="t1" />)
		const flood = Array.from({ length: 2100 }, (_, i) => line({ message: `line-${i}` }))
		deliver({ type: "taskLogs", taskLogTaskId: "t1", taskLogs: flood })
		expect(screen.getByText("2000 lines")).toBeInTheDocument()
		expect(screen.queryByText("line-0")).not.toBeInTheDocument()
		expect(screen.getByText("line-2099")).toBeInTheDocument()
		// Rendering the full ring is deliberately heavy — this is the only test
		// that does it, and it needs more than the 5s default under coverage.
	}, 30_000)

	it("clears the buffer when the focused task changes", () => {
		const { rerender } = render(<TaskLogsView taskId="t1" />)
		deliver({ type: "taskLogs", taskLogTaskId: "t1", taskLogs: [line({ message: "old" })] })

		rerender(<TaskLogsView taskId="t2" />)
		expect(screen.queryByText("old")).not.toBeInTheDocument()
		expect(postMessage).toHaveBeenCalledWith({ type: "requestTaskLogs", taskId: "t2" })
	})
})
