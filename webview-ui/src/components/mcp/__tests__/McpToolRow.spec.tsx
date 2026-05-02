import React from "react"
import { render, fireEvent, screen } from "@/utils/test-utils"

import McpToolRow from "../McpToolRow"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"mcp:tool.parameters": "Parameters",
				"mcp:tool.noDescription": "No description",
				"mcp:tool.togglePromptInclusion": "Toggle prompt inclusion",
			}
			return translations[key] || key
		},
	}),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: function MockVSCodeCheckbox({
		children,
		checked,
		onChange,
	}: {
		children?: React.ReactNode
		checked?: boolean
		onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
	}) {
		return (
			<label>
				<input type="checkbox" checked={checked} onChange={onChange} />
				{children}
			</label>
		)
	},
}))

describe("McpToolRow", () => {
	const mockTool = {
		name: "test-tool",
		description: "A test tool",
		enabledForPrompt: true,
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders tool name and description", () => {
		render(<McpToolRow tool={mockTool} />)

		expect(screen.getByText("test-tool")).toBeInTheDocument()
		expect(screen.getByText("A test tool")).toBeInTheDocument()
	})

	it("prevents event propagation when clicking the row container", () => {
		const mockOnClick = vi.fn()
		render(
			<div onClick={mockOnClick}>
				<McpToolRow tool={mockTool} />
			</div>,
		)

		const container = screen.getByTestId("tool-row-container")
		fireEvent.click(container)

		expect(mockOnClick).not.toHaveBeenCalled()
	})

	it("displays input schema parameters when provided", () => {
		const toolWithSchema = {
			...mockTool,
			inputSchema: {
				type: "object",
				properties: {
					param1: {
						type: "string",
						description: "First parameter",
					},
					param2: {
						type: "number",
						description: "Second parameter",
					},
				},
				required: ["param1"],
			},
		}

		render(<McpToolRow tool={toolWithSchema} />)

		expect(screen.getByText("Parameters")).toBeInTheDocument()
		expect(screen.getByText("param1")).toBeInTheDocument()
		expect(screen.getByText("param2")).toBeInTheDocument()
		expect(screen.getByText("First parameter")).toBeInTheDocument()
		expect(screen.getByText("Second parameter")).toBeInTheDocument()
	})

	it("hides parameters section when tool is disabled", () => {
		const disabledToolWithSchema = {
			...mockTool,
			enabledForPrompt: false,
			inputSchema: {
				type: "object",
				properties: {
					param1: {
						type: "string",
						description: "First parameter",
					},
				},
				required: ["param1"],
			},
		}

		render(<McpToolRow tool={disabledToolWithSchema} />)

		expect(screen.queryByText("Parameters")).not.toBeInTheDocument()
		expect(screen.queryByText("param1")).not.toBeInTheDocument()
		expect(screen.queryByText("First parameter")).not.toBeInTheDocument()
	})

	it("shows parameters section when tool is enabled", () => {
		const enabledToolWithSchema = {
			...mockTool,
			enabledForPrompt: true,
			inputSchema: {
				type: "object",
				properties: {
					param1: {
						type: "string",
						description: "First parameter",
					},
				},
				required: ["param1"],
			},
		}

		render(<McpToolRow tool={enabledToolWithSchema} />)

		expect(screen.getByText("Parameters")).toBeInTheDocument()
		expect(screen.getByText("param1")).toBeInTheDocument()
		expect(screen.getByText("First parameter")).toBeInTheDocument()
	})

	it("grays out tool name and description when tool is disabled", () => {
		const disabledTool = {
			...mockTool,
			enabledForPrompt: false,
			description: "A disabled tool",
		}
		render(<McpToolRow tool={disabledTool} />)

		const toolName = screen.getByText("test-tool")
		const toolDescription = screen.getByText("A disabled tool")

		// Check that the tool name has the grayed out classes
		expect(toolName).toHaveClass("text-vscode-descriptionForeground", "opacity-60")

		// Check that the description has reduced opacity
		expect(toolDescription).toHaveClass("opacity-40")
	})

	it("shows normal styling for tool name and description when tool is enabled", () => {
		const enabledTool = {
			...mockTool,
			enabledForPrompt: true,
			description: "An enabled tool",
		}
		render(<McpToolRow tool={enabledTool} />)

		const toolName = screen.getByText("test-tool")
		const toolDescription = screen.getByText("An enabled tool")

		// Check that the tool name has normal styling
		expect(toolName).toHaveClass("text-vscode-foreground")
		expect(toolName).not.toHaveClass("text-vscode-descriptionForeground", "opacity-60")

		// Check that the description has normal opacity
		expect(toolDescription).toHaveClass("opacity-80")
		expect(toolDescription).not.toHaveClass("opacity-40")
	})
})
