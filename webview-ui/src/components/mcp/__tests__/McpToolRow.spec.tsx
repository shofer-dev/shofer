import React from "react"
import { render, fireEvent, screen } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import McpToolRow from "../McpToolRow"

const mockExtensionState = { dynamicToolGroups: ["browser"] as string[] }

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockExtensionState,
}))

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

	describe("group selector", () => {
		// The selector is editable only with a server context — that is the Settings →
		// MCP Servers view, the one place a per-tool group override can be written.
		const editableProps = { serverName: "acme", serverSource: "global" as const }

		const openNewCategoryField = () => {
			fireEvent.change(screen.getByTestId("mcp-tool-group-select"), { target: { value: "__new__" } })
		}

		it("offers the builtin groups plus the registered dynamic categories", () => {
			render(<McpToolRow tool={mockTool} {...editableProps} />)

			const options = Array.from(screen.getByTestId("mcp-tool-group-select").querySelectorAll("option")).map(
				(option) => option.getAttribute("value"),
			)

			// 8 builtins, the dynamic category from the registry snapshot, the
			// server-declared default, and the free-text entry.
			expect(options).toContain("read")
			expect(options).toContain("uncategorized")
			expect(options).toContain("browser")
			expect(options).toContain("default")
			expect(options).toContain("__new__")
			// `browser` is no longer a builtin: it appears once, from the registry.
			expect(options.filter((value) => value === "browser")).toHaveLength(1)
		})

		it("posts the selected group without opening the free-text field", () => {
			render(<McpToolRow tool={mockTool} {...editableProps} />)

			fireEvent.change(screen.getByTestId("mcp-tool-group-select"), { target: { value: "read" } })

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "setMcpToolGroup",
				serverName: "acme",
				source: "global",
				toolName: "test-tool",
				toolGroup: "read",
			})
			expect(screen.queryByTestId("mcp-tool-group-new-input")).not.toBeInTheDocument()
		})

		it("clears the override when the server-declared default is chosen", () => {
			render(<McpToolRow tool={mockTool} {...editableProps} />)

			fireEvent.change(screen.getByTestId("mcp-tool-group-select"), { target: { value: "default" } })

			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "setMcpToolGroup", toolGroup: null }),
			)
		})

		it("mints a category from a valid slug", () => {
			render(<McpToolRow tool={mockTool} {...editableProps} />)

			openNewCategoryField()
			fireEvent.change(screen.getByTestId("mcp-tool-group-new-input"), { target: { value: "my-service" } })
			fireEvent.click(screen.getByTestId("mcp-tool-group-new-confirm"))

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "setMcpToolGroup",
				serverName: "acme",
				source: "global",
				toolName: "test-tool",
				toolGroup: "my-service",
			})
			expect(screen.queryByTestId("mcp-tool-group-new-error")).not.toBeInTheDocument()
		})

		it.each(["Salesforce", "sales force", "sales_force", "-lead", "trailing-", ""])(
			"refuses the non-slug name %j without posting",
			(name) => {
				render(<McpToolRow tool={mockTool} {...editableProps} />)

				openNewCategoryField()
				fireEvent.change(screen.getByTestId("mcp-tool-group-new-input"), { target: { value: name } })
				fireEvent.click(screen.getByTestId("mcp-tool-group-new-confirm"))

				expect(screen.getByTestId("mcp-tool-group-new-error")).toHaveTextContent(
					"mcp:tool.groupNewInvalidError",
				)
				expect(vscode.postMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ type: "setMcpToolGroup" }),
				)
			},
		)

		it("refuses the reserved wildcard by name, with its own message", () => {
			render(<McpToolRow tool={mockTool} {...editableProps} />)

			openNewCategoryField()
			fireEvent.change(screen.getByTestId("mcp-tool-group-new-input"), { target: { value: "*" } })
			fireEvent.click(screen.getByTestId("mcp-tool-group-new-confirm"))

			expect(screen.getByTestId("mcp-tool-group-new-error")).toHaveTextContent("mcp:tool.groupNewWildcardError")
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setMcpToolGroup" }))
		})

		it("refuses a name longer than 64 characters", () => {
			render(<McpToolRow tool={mockTool} {...editableProps} />)

			openNewCategoryField()
			fireEvent.change(screen.getByTestId("mcp-tool-group-new-input"), { target: { value: "a".repeat(65) } })
			fireEvent.click(screen.getByTestId("mcp-tool-group-new-confirm"))

			expect(screen.getByTestId("mcp-tool-group-new-error")).toBeInTheDocument()
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setMcpToolGroup" }))
		})
	})
})
