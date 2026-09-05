import { render } from "ink-testing-library"

import type { TodoItem } from "@shofer/types"

import type { TUIMessage } from "../../types.js"
import ChatHistoryItem from "../ChatHistoryItem.js"
import { resetNerdFontCache } from "../Icon.js"

/**
 * The tool-message paths the sanitization-focused sibling suite does not
 * reach: the TODO special case, the structured-renderer hand-off, the reason
 * line and the fallback renderer's own truncation.
 */
describe("ChatHistoryItem tool rendering", () => {
	beforeEach(() => {
		process.env.SHOFER_NERD_FONT = "0"
		resetNerdFontCache()
	})

	afterEach(() => {
		delete process.env.SHOFER_NERD_FONT
		resetNerdFontCache()
	})

	it("renders update_todo_list through TodoDisplay", () => {
		const todos = [
			{ id: "1", content: "First task", status: "completed" },
			{ id: "2", content: "Second task", status: "pending" },
		] as TodoItem[]

		const message: TUIMessage = {
			id: "t1",
			role: "tool",
			content: "{}",
			toolName: "update_todo_list",
			todos,
		}

		const { lastFrame } = render(<ChatHistoryItem message={message} />)
		const output = lastFrame() ?? ""

		expect(output).toContain("First task")
		expect(output).toContain("Second task")
	})

	it("renders the camelCase updateTodoList the same way", () => {
		const message: TUIMessage = {
			id: "t2",
			role: "tool",
			content: "{}",
			toolName: "updateTodoList",
			todos: [{ id: "1", content: "Only task", status: "pending" }] as TodoItem[],
		}

		const { lastFrame } = render(<ChatHistoryItem message={message} />)

		expect(lastFrame()).toContain("Only task")
	})

	it("falls back to the plain tool view when the TODO list is empty", () => {
		const message: TUIMessage = {
			id: "t3",
			role: "tool",
			content: "{}",
			toolName: "update_todo_list",
			toolDisplayName: "Update TODO List",
			toolDisplayOutput: "nothing to do",
			todos: [],
		}

		const { lastFrame } = render(<ChatHistoryItem message={message} />)

		expect(lastFrame()).toContain("nothing to do")
	})

	it("hands a message with structured toolData to the matching renderer", () => {
		const message: TUIMessage = {
			id: "t4",
			role: "tool",
			content: "{}",
			toolName: "grep_search",
			toolData: { tool: "grep_search", regex: "needle", content: "a.ts:1:needle" },
		}

		const { lastFrame } = render(<ChatHistoryItem message={message} />)
		const output = lastFrame() ?? ""

		// SearchTool's own layout, not the generic fallback.
		expect(output).toContain("regex:")
		expect(output).toContain("needle")
	})

	it("renders the reason line of a fallback tool message", () => {
		const message: TUIMessage = {
			id: "t5",
			role: "tool",
			content: JSON.stringify({ tool: "switch_mode", reason: "the task needs planning" }),
			toolName: "switch_mode",
			toolDisplayName: "Switch Mode",
		}

		const { lastFrame } = render(<ChatHistoryItem message={message} />)

		expect(lastFrame()).toContain("the task needs planning")
	})

	it("truncates a long fallback output and reports the hidden lines", () => {
		const message: TUIMessage = {
			id: "t6",
			role: "tool",
			content: "{}",
			toolName: "custom_tool",
			toolDisplayName: "Custom Tool",
			toolDisplayOutput: Array.from({ length: 25 }, (_, i) => `out-${i}`).join("\n"),
		}

		const { lastFrame } = render(<ChatHistoryItem message={message} />)
		const output = lastFrame() ?? ""

		expect(output).toContain("out-0")
		expect(output).toContain("(10 more lines)")
		expect(output).not.toContain("out-24")
	})
})
