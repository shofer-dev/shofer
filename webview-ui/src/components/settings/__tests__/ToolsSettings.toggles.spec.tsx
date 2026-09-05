// npx vitest src/components/settings/__tests__/ToolsSettings.toggles.spec.tsx
//
// The global tool-enablement panel. Two different stores back it — native tools
// live in the save-gated `disabledTools` field, MCP tools in a per-server
// `mcp.json` the panel STAGES and only writes on Save — and the essential tools
// can be toggled by nobody.

import { createRef } from "react"
import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { ALWAYS_AVAILABLE_TOOLS, type McpServer } from "@shofer/types"

import { ToolsSettings, type ToolsSettingsRef } from "../ToolsSettings"

const postMessage = vi.fn()
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}(${Object.values(opts)})` : key),
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, disabled, onChange, "data-testid": testId }: any) => (
		<input
			type="checkbox"
			data-testid={testId}
			checked={!!checked}
			disabled={disabled}
			onChange={() => onChange?.()}
		/>
	),
}))

const setCachedStateField = vi.fn()
const onToolsDirty = vi.fn()

const mcpServer = (over: Partial<McpServer> = {}): McpServer =>
	({
		name: "acme",
		source: "global",
		status: "connected",
		config: "{}",
		tools: [{ name: "acme_query", group: "read", enabledForPrompt: true }],
		...over,
	}) as unknown as McpServer

const renderPanel = (props: Record<string, unknown> = {}) => {
	const ref = createRef<ToolsSettingsRef>()
	const utils = render(
		<ToolsSettings
			ref={ref}
			setCachedStateField={setCachedStateField}
			onToolsDirty={onToolsDirty}
			{...(props as object)}
		/>,
	)
	return { ...utils, ref }
}

beforeEach(() => vi.clearAllMocks())

describe("native tools", () => {
	it("stages a disable into the cached field rather than posting it", () => {
		renderPanel()

		const toggle = screen.getByTestId("tool-toggle-execute_command")
		expect(toggle).toBeChecked()
		fireEvent.click(toggle)

		expect(setCachedStateField).toHaveBeenCalledWith("disabledTools", expect.arrayContaining(["execute_command"]))
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("re-enables a tool by removing it from the list", () => {
		renderPanel({ disabledTools: ["execute_command"] })

		const toggle = screen.getByTestId("tool-toggle-execute_command")
		expect(toggle).not.toBeChecked()
		fireEvent.click(toggle)
		expect(setCachedStateField).toHaveBeenCalledWith("disabledTools", [])
	})

	it("refuses to let an essential tool be turned off", () => {
		renderPanel()
		const essential = ALWAYS_AVAILABLE_TOOLS[0]
		const toggle = screen.getByTestId(`tool-toggle-${essential}`)

		expect(toggle).toBeDisabled()
		fireEvent.click(toggle)
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("lists each tool exactly once", () => {
		renderPanel()
		const ids = screen.getAllByRole("checkbox").map((el) => el.getAttribute("data-testid"))
		expect(new Set(ids).size).toBe(ids.length)
	})
})

describe("MCP tools", () => {
	it("stages a per-tool toggle and writes it only on Save", () => {
		const { ref } = renderPanel({ mcpServers: [mcpServer()] })

		const toggle = screen.getByTestId("tool-toggle-mcp--acme--acme_query")
		expect(toggle).toBeChecked()

		fireEvent.click(toggle)
		expect(onToolsDirty).toHaveBeenCalled()
		expect(postMessage).not.toHaveBeenCalled()

		act(() => ref.current!.commitToolBuffers())
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "toggleToolEnabledForPrompt", serverName: "acme" }),
		)
	})

	it("drops a staged toggle on Discard", () => {
		const { ref } = renderPanel({ mcpServers: [mcpServer()] })

		fireEvent.click(screen.getByTestId("tool-toggle-mcp--acme--acme_query"))
		act(() => ref.current!.discardToolBuffers())
		act(() => ref.current!.commitToolBuffers())

		expect(postMessage).not.toHaveBeenCalled()
		expect(screen.getByTestId("tool-toggle-mcp--acme--acme_query")).toBeChecked()
	})

	it("shows the staged state immediately, before Save", () => {
		renderPanel({ mcpServers: [mcpServer()] })

		const toggle = screen.getByTestId("tool-toggle-mcp--acme--acme_query")
		fireEvent.click(toggle)
		expect(screen.getByTestId("tool-toggle-mcp--acme--acme_query")).not.toBeChecked()
	})

	it("skips a disabled server's tools entirely", () => {
		renderPanel({ mcpServers: [mcpServer({ disabled: true })] })
		expect(screen.queryByTestId("tool-toggle-mcp--acme--acme_query")).not.toBeInTheDocument()
	})

	it("reads a tool disabled in the server's own config as off", () => {
		renderPanel({
			mcpServers: [
				mcpServer({ tools: [{ name: "acme_query", group: "read", enabledForPrompt: false }] as never }),
			],
		})
		expect(screen.getByTestId("tool-toggle-mcp--acme--acme_query")).not.toBeChecked()
	})
})
