// npx vitest src/components/chat/__tests__/TaskSelector.spec.tsx
//
// The task drawer and the state-rendering tables that `webview-ui/AGENTS.md`
// makes normative: the fixed `runtime?.state ?? item.taskState ?? IDLE` chain,
// `resolveStateVisual`, and the fact that every state renders through the
// LIFECYCLE_VISUAL / RATING_VISUAL codicon tables rather than a per-value SVG.

import { render, screen, fireEvent, act, within } from "@/utils/test-utils"

import type { HistoryItem, TaskLifecycle, CompletionRating } from "@shofer/types"

import {
	LIFECYCLE_VISUAL,
	RATING_VISUAL,
	TASK_SIDEBAR_TOGGLE_EVENT,
	TaskSelector,
	getTaskDisplayName,
	resolveStateVisual,
	type ManagedTask,
} from "../TaskSelector"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

const item = (over: Partial<HistoryItem> & { id: string }): HistoryItem =>
	({
		ts: Date.now(),
		task: `task ${over.id}`,
		number: 1,
		tokensIn: 0,
		tokensOut: 0,
		cacheWrites: 0,
		cacheReads: 0,
		totalCost: 0,
		...over,
	}) as HistoryItem

const managed = (id: string, lifecycle: TaskLifecycle): ManagedTask =>
	({ id, taskId: id, state: { lifecycle } }) as ManagedTask

const renderSelector = (props: Partial<React.ComponentProps<typeof TaskSelector>> = {}) =>
	render(
		<TaskSelector
			taskHistory={[]}
			parallelTasks={[]}
			currentTaskId={undefined}
			modes={[]}
			workspacePath="/repo"
			{...props}
		/>,
	)

// The row's hover actions are icon-only buttons labelled by a tooltip, so they
// are addressed by the lucide glyph they carry.
const rowAction = (icon: string, index = 0) => {
	const found = Array.from(document.querySelectorAll(`.lucide-${icon}`))
	const el = found[index]?.closest("button")
	if (!el) throw new Error(`no row action with icon ${icon} (#${index})`)
	return el as HTMLButtonElement
}

/** The drawer only mounts its list once the title-bar toggle fires. */
const openDrawer = () =>
	act(() => {
		window.dispatchEvent(new Event(TASK_SIDEBAR_TOGGLE_EVENT))
	})

beforeEach(() => vi.clearAllMocks())

describe("resolveStateVisual", () => {
	it("defaults to idle for an absent state", () => {
		expect(resolveStateVisual(undefined)).toBe(LIFECYCLE_VISUAL.idle)
	})

	it("returns the lifecycle row for every lifecycle", () => {
		for (const lifecycle of Object.keys(LIFECYCLE_VISUAL) as TaskLifecycle[]) {
			expect(resolveStateVisual({ lifecycle })).toBe(LIFECYCLE_VISUAL[lifecycle])
		}
	})

	it("overlays the rating table only on a completed task", () => {
		for (const rating of Object.keys(RATING_VISUAL) as CompletionRating[]) {
			expect(resolveStateVisual({ lifecycle: "completed", rating })).toMatchObject(RATING_VISUAL[rating])
			// A rating on a non-terminal lifecycle must not change its visual.
			expect(resolveStateVisual({ lifecycle: "running", rating })).toBe(LIFECYCLE_VISUAL.running)
		}
	})

	it("renders every state through a codicon, never a bespoke glyph", () => {
		for (const visual of [...Object.values(LIFECYCLE_VISUAL), ...Object.values(RATING_VISUAL)]) {
			expect(visual.icon).toMatch(/^codicon-/)
		}
	})
})

describe("getTaskDisplayName", () => {
	it("prefers a user-set name", () => {
		expect(getTaskDisplayName(item({ id: "a", name: "My task", task: "the prompt" }))).toBe("My task")
	})

	it("falls back to the trimmed prompt, elided past 60 characters", () => {
		expect(getTaskDisplayName(item({ id: "a", task: "  short prompt  " }))).toBe("short prompt")
		const long = "x".repeat(80)
		expect(getTaskDisplayName(item({ id: "a", task: long })).endsWith("…")).toBe(true)
		expect(getTaskDisplayName(item({ id: "a", task: long })).length).toBe(61)
	})

	it("falls back to the task number when there is neither", () => {
		expect(getTaskDisplayName(item({ id: "a", task: "", number: 7 }))).toBe("Task 7")
	})
})

describe("TaskSelector drawer", () => {
	it("mounts no rows until the title-bar toggle opens it", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello" })] })
		expect(screen.queryByText("hello")).not.toBeInTheDocument()

		openDrawer()
		expect(screen.getByText("hello")).toBeInTheDocument()
	})

	it("closes on Escape, on the backdrop and on the close button", () => {
		const { container } = renderSelector({ taskHistory: [item({ id: "a", task: "hello" })] })

		openDrawer()
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
		})
		expect(screen.queryByText("hello")).not.toBeInTheDocument()

		openDrawer()
		fireEvent.click(container.querySelector(".fixed.inset-0")!)
		expect(screen.queryByText("hello")).not.toBeInTheDocument()

		openDrawer()
		fireEvent.click(screen.getByLabelText("Close"))
		expect(screen.queryByText("hello")).not.toBeInTheDocument()
	})

	it("ignores an unrelated key while open", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello" })] })
		openDrawer()
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
		})
		expect(screen.getByText("hello")).toBeInTheDocument()
	})

	it("says so when there is nothing at all", () => {
		renderSelector()
		openDrawer()
		expect(screen.getByText("No tasks yet")).toBeInTheDocument()
	})

	it("lets the runtime overlay win over the persisted state", () => {
		renderSelector({
			taskHistory: [item({ id: "a", task: "hello", taskState: { lifecycle: "error" } })],
			parallelTasks: [managed("a", "running")],
		})
		openDrawer()

		expect(screen.getByLabelText(LIFECYCLE_VISUAL.running.label)).toBeInTheDocument()
		expect(screen.queryByLabelText(LIFECYCLE_VISUAL.error.label)).not.toBeInTheDocument()
	})

	it("falls back to the persisted state, then to idle", () => {
		const { rerender } = renderSelector({
			taskHistory: [item({ id: "a", task: "hello", taskState: { lifecycle: "paused" } })],
		})
		openDrawer()
		expect(screen.getByLabelText(LIFECYCLE_VISUAL.paused.label)).toBeInTheDocument()

		rerender(
			<TaskSelector
				taskHistory={[item({ id: "a", task: "hello" })]}
				parallelTasks={[]}
				currentTaskId={undefined}
				modes={[]}
				workspacePath="/repo"
			/>,
		)
		expect(screen.getByLabelText(LIFECYCLE_VISUAL.idle.label)).toBeInTheDocument()
	})

	it("buckets tasks by the root's timestamp", () => {
		const day = 24 * 60 * 60 * 1000
		// Pin the clock to local noon: the buckets are local-midnight relative, so
		// a run started near midnight would otherwise put "yesterday" in "last7".
		const noon = new Date()
		noon.setHours(12, 0, 0, 0)
		vi.useFakeTimers()
		vi.setSystemTime(noon)
		const now = Date.now()
		renderSelector({
			taskHistory: [
				item({ id: "t", task: "today task", ts: now }),
				item({ id: "y", task: "yesterday task", ts: now - day - 60 * 60 * 1000 }),
				item({ id: "w", task: "last week task", ts: now - 4 * day }),
				item({ id: "o", task: "ancient task", ts: now - 40 * day }),
			],
		})
		openDrawer()

		for (const label of ["Today", "Yesterday", "Last 7 Days", "Older"]) {
			expect(screen.getByText(label)).toBeInTheDocument()
		}
		vi.useRealTimers()
	})

	it("keeps a subtask in its parent's bucket and starts subtrees collapsed", () => {
		const day = 24 * 60 * 60 * 1000
		const noon = new Date()
		noon.setHours(12, 0, 0, 0)
		vi.useFakeTimers()
		vi.setSystemTime(noon)
		const now = Date.now()
		renderSelector({
			taskHistory: [
				item({ id: "p", task: "old parent", ts: now - 40 * day, childIds: ["c"] }),
				item({ id: "c", task: "recent child", parentTaskId: "p", ts: now }),
			],
		})
		openDrawer()

		expect(screen.getByText("Older")).toBeInTheDocument()
		expect(screen.queryByText("Today")).not.toBeInTheDocument()
		// Collapsed by default.
		expect(screen.queryByText("recent child")).not.toBeInTheDocument()

		fireEvent.click(screen.getByLabelText("Expand subtasks"))
		expect(screen.getByText("recent child")).toBeInTheDocument()

		fireEvent.click(screen.getByLabelText("Collapse subtasks"))
		expect(screen.queryByText("recent child")).not.toBeInTheDocument()
		vi.useRealTimers()
	})

	it("separates pinned and archived roots from the date buckets", () => {
		renderSelector({
			taskHistory: [
				item({ id: "p", task: "pinned one", pinned: true }),
				item({ id: "a", task: "archived one", archived: true }),
				item({ id: "n", task: "normal one" }),
			],
		})
		openDrawer()

		expect(screen.getByText("Pinned")).toBeInTheDocument()
		expect(screen.getByText("pinned one")).toBeInTheDocument()
		expect(screen.getByText("normal one")).toBeInTheDocument()

		// Archived is its own collapsed section.
		expect(screen.getByText("Archived")).toBeInTheDocument()
		expect(screen.queryByText("archived one")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Archived"))
		expect(screen.getByText("archived one")).toBeInTheDocument()
	})

	it("treats an archived-and-pinned root as archived", () => {
		renderSelector({
			taskHistory: [item({ id: "a", task: "both", pinned: true, archived: true })],
		})
		openDrawer()
		expect(screen.queryByText("Pinned")).not.toBeInTheDocument()
		expect(screen.getByText("Archived")).toBeInTheDocument()
	})

	it("focuses a task and closes the drawer", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello" })] })
		openDrawer()

		fireEvent.click(screen.getByText("hello"))
		expect(postMessage).toHaveBeenCalledWith({ type: "focusParallelTask", taskId: "a" })
		expect(screen.queryByText("hello")).not.toBeInTheDocument()
	})

	it("routes each hover action to its own typed message", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello" })] })
		openDrawer()

		fireEvent.click(rowAction("pin"))
		expect(postMessage).toHaveBeenCalledWith({ type: "pinParallelTask", taskId: "a" })

		fireEvent.click(rowAction("archive"))
		expect(postMessage).toHaveBeenCalledWith({ type: "archiveParallelTask", taskId: "a" })

		// The group header carries a bin too; the row's is the second.
		fireEvent.click(rowAction("trash-2", 1))
		expect(postMessage).toHaveBeenCalledWith({ type: "deleteParallelTask", taskId: "a" })
	})

	it("offers unpin and unarchive for a task already in that state", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello", pinned: true, archived: true })] })
		openDrawer()
		fireEvent.click(screen.getByText("Archived"))

		fireEvent.click(rowAction("pin-off"))
		expect(postMessage).toHaveBeenCalledWith({ type: "unpinParallelTask", taskId: "a" })

		// The section header shows an archive glyph too; the row's is the second.
		fireEvent.click(rowAction("archive", 1))
		expect(postMessage).toHaveBeenCalledWith({ type: "unarchiveParallelTask", taskId: "a" })
	})

	it("renames a task, and refuses an empty name", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello" })] })
		openDrawer()

		fireEvent.click(rowAction("pencil"))
		const input = screen.getByRole("textbox")
		expect(input).toHaveValue("hello")

		fireEvent.change(input, { target: { value: "  " } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "renameParallelTask" }))

		fireEvent.click(rowAction("pencil"))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "  renamed  " } })
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
		expect(postMessage).toHaveBeenCalledWith({ type: "renameParallelTask", taskId: "a", text: "renamed" })
	})

	it("abandons a rename on Escape and on the cancel button", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello" })] })
		openDrawer()

		fireEvent.click(rowAction("pencil"))
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()

		fireEvent.click(rowAction("pencil"))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } })
		// The two icon buttons beside the field are confirm and cancel.
		const row = screen.getByRole("textbox").parentElement!
		fireEvent.click(within(row).getAllByRole("button")[1])
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "renameParallelTask" }))
	})

	it("confirms a rename from the check button", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello" })] })
		openDrawer()

		fireEvent.click(rowAction("pencil"))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "confirmed" } })
		const row = screen.getByRole("textbox").parentElement!
		fireEvent.click(within(row).getAllByRole("button")[0])
		expect(postMessage).toHaveBeenCalledWith({ type: "renameParallelTask", taskId: "a", text: "confirmed" })
	})

	it("confirms before bulk-deleting a group, and can be cancelled", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "one" }), item({ id: "b", task: "two" })] })
		openDrawer()

		fireEvent.click(screen.getByLabelText("Delete all in group"))
		expect(postMessage).not.toHaveBeenCalled()

		fireEvent.click(screen.getByLabelText("Cancel"))
		expect(screen.getByLabelText("Delete all in group")).toBeInTheDocument()

		fireEvent.click(screen.getByLabelText("Delete all in group"))
		fireEvent.click(screen.getByLabelText("Delete all"))
		expect(postMessage).toHaveBeenCalledWith({ type: "deleteParallelTask", taskId: "a" })
		expect(postMessage).toHaveBeenCalledWith({ type: "deleteParallelTask", taskId: "b" })
	})

	it("shows the mode name, diff stats and a foreign working directory", () => {
		renderSelector({
			taskHistory: [
				item({
					id: "a",
					task: "hello",
					mode: "code",
					insertions: 12,
					deletions: 3,
					cwd: "/repo-worktrees/feature-x",
				}),
			],
			modes: [{ slug: "code", name: "Code" }],
		})
		openDrawer()

		expect(screen.getByText("Code")).toBeInTheDocument()
		expect(screen.getByText("+12")).toBeInTheDocument()
		expect(screen.getByText("-3")).toBeInTheDocument()
		expect(screen.getByText("feature-x")).toBeInTheDocument()
	})

	it("omits the directory label for a task running in the workspace", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello", cwd: "/repo" })] })
		openDrawer()
		expect(screen.queryByText("repo")).not.toBeInTheDocument()
	})

	it("highlights the task the chat panel is showing", () => {
		const { container } = renderSelector({
			taskHistory: [item({ id: "a", task: "current" }), item({ id: "b", task: "other" })],
			currentTaskId: "a",
		})
		openDrawer()
		expect(container.querySelectorAll("[class*='list-activeSelectionBackground']")).toHaveLength(1)
	})

	it("links out to the full history view", () => {
		renderSelector({ taskHistory: [item({ id: "a", task: "hello" })] })
		openDrawer()

		fireEvent.click(screen.getByText("View All Tasks"))
		expect(postMessage).toHaveBeenCalledWith({ type: "switchTab", tab: "history" })
		expect(screen.queryByText("hello")).not.toBeInTheDocument()
	})

	it("orders siblings newest first and draws the tree connectors", () => {
		renderSelector({
			taskHistory: [
				item({ id: "p", task: "parent", createdAt: 1, childIds: ["c1", "c2"] }),
				item({ id: "c1", task: "older child", parentTaskId: "p", createdAt: 2 }),
				item({ id: "c2", task: "newer child", parentTaskId: "p", createdAt: 3 }),
			],
		})
		openDrawer()
		fireEvent.click(screen.getByLabelText("Expand subtasks"))

		const titles = Array.from(document.querySelectorAll("span.truncate.text-sm")).map((n) => n.textContent)
		expect(titles).toEqual(["parent", "newer child", "older child"])
		expect(document.body.textContent).toContain("├")
		expect(document.body.textContent).toContain("└")
	})
})
