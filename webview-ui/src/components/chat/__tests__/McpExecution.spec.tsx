// npx vitest src/components/chat/__tests__/McpExecution.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import type { ShoferAskUseMcpServer } from "@shofer/types"

import { McpExecution } from "../McpExecution"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}))

vi.mock("../../common/CodeBlock", () => ({
	default: ({ source, language }: { source: string; language: string }) => (
		<pre data-testid={`code-${language}`}>{source}</pre>
	),
}))

vi.mock("../../mcp/McpToolRow", () => ({
	default: ({ tool }: { tool: { name: string; description?: string } }) => (
		<div data-testid="tool-row" data-description={tool.description}>
			{tool.name}
		</div>
	),
}))

vi.mock("../Markdown", () => ({
	Markdown: ({ markdown, partial }: { markdown?: string; partial?: boolean }) => (
		<div data-testid="markdown" data-partial={String(!!partial)}>
			{markdown}
		</div>
	),
}))

/** Push an `mcpExecutionStatus` message the way the host does. */
const status = (payload: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "mcpExecutionStatus", text: JSON.stringify(payload) } }),
		)
	})

describe("McpExecution", () => {
	it("names the server and renders a tool row for a use_mcp_tool ask", () => {
		render(
			<McpExecution
				executionId="e1"
				serverName="files"
				useMcpServer={{ type: "use_mcp_tool", serverName: "files", toolName: "read" } as ShoferAskUseMcpServer}
				server={{ tools: [{ name: "read", description: "reads a file" }] }}
			/>,
		)
		expect(screen.getByText("files")).toBeInTheDocument()
		expect(screen.getByTestId("tool-row")).toHaveTextContent("read")
		expect(screen.getByTestId("tool-row")).toHaveAttribute("data-description", "reads a file")
	})

	it("falls back to an empty description when the server does not describe the tool", () => {
		render(
			<McpExecution
				executionId="e1"
				useMcpServer={{ type: "use_mcp_tool", toolName: "unknown" } as ShoferAskUseMcpServer}
				server={{ tools: [] }}
			/>,
		)
		expect(screen.getByTestId("tool-row")).toHaveAttribute("data-description", "")
	})

	it("renders a tool row from the bare server/tool names when there is no ask", () => {
		render(<McpExecution executionId="e1" serverName="files" toolName="write" />)
		expect(screen.getByTestId("tool-row")).toHaveTextContent("write")
	})

	it("badges an async invocation", () => {
		render(
			<McpExecution
				executionId="e1"
				serverName="files"
				useMcpServer={{ type: "use_mcp_tool", async: true } as ShoferAskUseMcpServer}
			/>,
		)
		expect(screen.getByText("async")).toBeInTheDocument()
	})

	it("uses the wrench glyph for an external LM tool", () => {
		const { container } = render(
			<McpExecution
				executionId="e1"
				useMcpServer={{ type: "use_mcp_tool", external_lm_tool: true } as ShoferAskUseMcpServer}
			/>,
		)
		expect(container.querySelector(".lucide-wrench")).toBeTruthy()
	})

	it("pretty-prints complete JSON arguments and leaves partial ones alone", () => {
		const { rerender } = render(<McpExecution executionId="e1" text='{"a":1}' isArguments />)
		expect(screen.getByTestId("code-json").textContent).toBe('{\n  "a": 1\n}')

		rerender(<McpExecution executionId="e2" text='{"a":' isArguments />)
		expect(screen.getByTestId("code-json").textContent).toBe('{"a":')
	})

	it("leaves structurally-complete but invalid JSON arguments verbatim", () => {
		render(<McpExecution executionId="e1" text="{not json}" isArguments />)
		expect(screen.getByTestId("code-json").textContent).toBe("{not json}")
	})

	it("reports the running, completed and error statuses the host announces", () => {
		const { rerender } = render(<McpExecution executionId="e1" />)

		status({ executionId: "e1", status: "started", serverName: "files", toolName: "read" })
		expect(screen.getByText("execution.running")).toBeInTheDocument()

		status({ executionId: "e1", status: "completed", response: "done" })
		expect(screen.getByText("execution.completed")).toBeInTheDocument()

		rerender(<McpExecution executionId="e1" />)
		status({ executionId: "e1", status: "error", error: "it broke" })
		expect(screen.getByText("execution.error")).toBeInTheDocument()
		expect(screen.getByText("(it broke)")).toBeInTheDocument()
	})

	it("ignores a status addressed to another execution", () => {
		render(<McpExecution executionId="mine" />)
		status({ executionId: "theirs", status: "started", serverName: "s", toolName: "t" })
		expect(screen.queryByText("execution.running")).not.toBeInTheDocument()
	})

	it("ignores a payload that does not match the status schema", () => {
		render(<McpExecution executionId="e1" />)
		status({ executionId: "e1", status: "not-a-status" })
		expect(screen.queryByText("execution.running")).not.toBeInTheDocument()
	})

	it("accumulates streamed output chunks and replaces them on completion", () => {
		render(<McpExecution executionId="e1" />)

		status({ executionId: "e1", status: "output", response: "part one " })
		status({ executionId: "e1", status: "output", response: "part two" })
		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByTestId("markdown")).toHaveTextContent("part one part two")
		// Still streaming, so the markdown is flagged partial (no copy affordance).
		expect(screen.getByTestId("markdown")).toHaveAttribute("data-partial", "true")

		status({ executionId: "e1", status: "completed", response: "the whole answer" })
		expect(screen.getByTestId("markdown")).toHaveTextContent("the whole answer")
		expect(screen.getByTestId("markdown")).toHaveAttribute("data-partial", "false")
	})

	it("keeps the response collapsed until the chevron is used", () => {
		render(
			<McpExecution
				executionId="e1"
				useMcpServer={{ type: "use_mcp_tool", response: "hello" } as ShoferAskUseMcpServer}
			/>,
		)
		expect(screen.queryByTestId("markdown")).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByTestId("markdown")).toHaveTextContent("hello")
	})

	it("renders a completed JSON response as a code block, not markdown", () => {
		render(<McpExecution executionId="e1" />)
		status({ executionId: "e1", status: "completed", response: '{"ok":true}' })
		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByTestId("code-json").textContent).toBe('{\n  "ok": true\n}')
		expect(screen.queryByTestId("markdown")).not.toBeInTheDocument()
	})

	it("offers no expander at all without a response", () => {
		render(<McpExecution executionId="e1" serverName="files" toolName="read" />)
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})

	it("adopts a changed server and tool name from its props", () => {
		const { rerender } = render(<McpExecution executionId="e1" serverName="one" toolName="a" />)
		expect(screen.getByText("one")).toBeInTheDocument()

		rerender(<McpExecution executionId="e1" serverName="two" toolName="b" />)
		expect(screen.getByText("two")).toBeInTheDocument()
		expect(screen.getByTestId("tool-row")).toHaveTextContent("b")
	})
})
