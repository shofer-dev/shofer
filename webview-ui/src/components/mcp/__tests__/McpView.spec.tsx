// npx vitest src/components/mcp/__tests__/McpView.spec.tsx

import { render, screen, fireEvent, within } from "@/utils/test-utils"

import type { McpServer } from "@shofer/types"

import McpView from "../McpView"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
	useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e)} />
			{children}
		</label>
	),
}))

vi.mock("../McpServerConfigEditor", () => ({
	default: ({ server }: { server: McpServer }) => <div data-testid="config-editor">{server.name}</div>,
}))

const state = {
	mcpServers: [] as McpServer[],
	mcpEnabled: true,
	setMcpEnabled: vi.fn(),
	orgLockedResources: undefined as { mcp?: string[] } | undefined,
}

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => state,
}))

const server = (over: Partial<McpServer> & { name: string }): McpServer =>
	({ config: "{}", status: "connected", ...over }) as McpServer

beforeEach(() => {
	vi.clearAllMocks()
	state.mcpServers = []
	state.mcpEnabled = true
	state.orgLockedResources = undefined
})

describe("McpView", () => {
	it("hides everything but the enable toggle while MCP is off", () => {
		state.mcpEnabled = false
		state.mcpServers = [server({ name: "files" })]
		render(<McpView />)

		expect(screen.getByText("mcp:enableToggle.title")).toBeInTheDocument()
		expect(screen.queryByText("mcp:editGlobalMCP")).not.toBeInTheDocument()
		expect(screen.queryByText("files")).not.toBeInTheDocument()
	})

	it("opens the global and project config files and refreshes all servers", () => {
		render(<McpView />)

		fireEvent.click(screen.getByText("mcp:editGlobalMCP"))
		expect(postMessage).toHaveBeenCalledWith({ type: "openMcpSettings" })

		fireEvent.click(screen.getByText("mcp:editProjectMCP"))
		expect(postMessage).toHaveBeenCalledWith({ type: "openProjectMcpSettings" })

		fireEvent.click(screen.getByText("mcp:refreshMCP"))
		expect(postMessage).toHaveBeenCalledWith({ type: "refreshAllMcpServers" })
	})

	it("stages the enable toggle through updateSettings", () => {
		render(<McpView />)
		fireEvent.click(screen.getByRole("checkbox"))
		expect(state.setMcpEnabled).toHaveBeenCalledWith(false)
		expect(postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { mcpEnabled: false },
		})
	})

	it("warns when the connected servers advertise too many tools", () => {
		const manyTools = Array.from({ length: 200 }, (_, i) => ({ name: `tool${i}` }))
		state.mcpServers = [server({ name: "big", tools: manyTools as never })]
		render(<McpView />)
		expect(screen.getByText("chat:tooManyTools.title")).toBeInTheDocument()
	})

	it("does not warn for a modest tool count", () => {
		state.mcpServers = [server({ name: "small", tools: [{ name: "a" }] as never })]
		render(<McpView />)
		expect(screen.queryByText("chat:tooManyTools.title")).not.toBeInTheDocument()
	})

	it("names a server, badges its source, and toggles it", () => {
		state.mcpServers = [server({ name: "files", source: "project" })]
		render(<McpView />)

		expect(screen.getByText("files")).toBeInTheDocument()
		expect(screen.getByText("project")).toBeInTheDocument()

		fireEvent.click(screen.getByLabelText("Toggle files server"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "toggleMcpServer",
			serverName: "files",
			source: "project",
			disabled: true,
		})
	})

	it("restarts a server and refuses while it is already connecting", () => {
		state.mcpServers = [server({ name: "files" })]
		const { rerender } = render(<McpView />)

		const restart = document.querySelector(".codicon-refresh")!.closest("button")!
		fireEvent.click(restart)
		expect(postMessage).toHaveBeenCalledWith({
			type: "restartMcpServer",
			text: "files",
			source: "global",
		})

		state.mcpServers = [server({ name: "files", status: "connecting" })]
		rerender(<McpView />)
		expect(screen.getByText("mcp:serverStatus.retrying")).toBeInTheDocument()
	})

	it("surfaces a disconnected server's multi-line error with a retry button", () => {
		state.mcpServers = [server({ name: "files", status: "disconnected", error: "line one\nline two" })]
		render(<McpView />)

		expect(screen.getByText(/line one/)).toBeInTheDocument()
		fireEvent.click(screen.getByText("mcp:serverStatus.retryConnection"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "restartMcpServer",
			text: "files",
			source: "global",
		})
	})

	it("shows a disconnected server's retry affordance even with no error text", () => {
		state.mcpServers = [server({ name: "files", status: "disconnected" })]
		render(<McpView />)
		expect(screen.getByText("mcp:serverStatus.retryConnection")).toBeInTheDocument()
	})

	it("shows no status banner for a disabled server", () => {
		state.mcpServers = [server({ name: "files", status: "disconnected", disabled: true })]
		render(<McpView />)
		expect(screen.queryByText("mcp:serverStatus.retryConnection")).not.toBeInTheDocument()
	})

	it("renders server instructions when the server supplies them", () => {
		state.mcpServers = [server({ name: "files", instructions: "call read first" })]
		render(<McpView />)
		expect(screen.getByText("call read first")).toBeInTheDocument()
	})

	it("keeps each tree group collapsed until it is opened", () => {
		state.mcpServers = [
			server({
				name: "files",
				tools: [{ name: "read" }] as never,
				resources: [{ uri: "file://a", mimeType: "text/plain" }] as never,
				resourceTemplates: [{ uriTemplate: "file://{p}" }] as never,
			}),
		]
		render(<McpView />)

		expect(screen.queryByTestId("config-editor")).not.toBeInTheDocument()

		fireEvent.click(screen.getByText("mcp:tabs.configuration"))
		expect(screen.getByTestId("config-editor")).toHaveTextContent("files")

		fireEvent.click(screen.getByText("mcp:tabs.tools"))
		expect(screen.getAllByText("read").length).toBeGreaterThan(0)

		fireEvent.click(screen.getByText("mcp:tabs.resources"))
		expect(screen.getByText("file://a")).toBeInTheDocument()
		expect(screen.getByText("file://{p}")).toBeInTheDocument()
	})

	it("says so when a server advertises neither tools nor resources", () => {
		state.mcpServers = [server({ name: "bare" })]
		render(<McpView />)

		fireEvent.click(screen.getByText("mcp:tabs.tools"))
		expect(screen.getByText("mcp:emptyState.noTools")).toBeInTheDocument()

		fireEvent.click(screen.getByText("mcp:tabs.resources"))
		expect(screen.getByText("mcp:emptyState.noResources")).toBeInTheDocument()
	})

	it("shows the log group only when there is error history, newest first", () => {
		const { rerender } = render(<McpView />)
		state.mcpServers = [server({ name: "quiet" })]
		rerender(<McpView />)
		expect(screen.queryByText("mcp:tabs.logs")).not.toBeInTheDocument()

		state.mcpServers = [
			server({
				name: "noisy",
				errorHistory: [
					{ message: "older", timestamp: 1, level: "warn" },
					{ message: "newer", timestamp: 2, level: "error" },
				] as never,
			}),
		]
		rerender(<McpView />)
		fireEvent.click(screen.getByText("mcp:tabs.logs"))
		const entries = screen.getAllByText(/older|newer/).map((n) => n.textContent)
		expect(entries).toEqual(["newer", "older"])
	})

	it("reads the timeout from the server config and posts a change", () => {
		state.mcpServers = [server({ name: "files", config: JSON.stringify({ timeout: 300 }) })]
		render(<McpView />)

		const select = screen.getByRole("combobox")
		expect(select).toHaveValue("300")

		fireEvent.change(select, { target: { value: "900" } })
		expect(postMessage).toHaveBeenCalledWith({
			type: "updateMcpTimeout",
			serverName: "files",
			source: "global",
			timeout: 900,
		})
	})

	it("defaults the timeout to a minute when the config does not set one", () => {
		state.mcpServers = [server({ name: "files" })]
		render(<McpView />)
		expect(screen.getByRole("combobox")).toHaveValue("60")
	})

	it("confirms before deleting a server, and can be dismissed", () => {
		state.mcpServers = [server({ name: "files" })]
		render(<McpView />)

		fireEvent.click(document.querySelector(".codicon-trash")!.closest("button")!)
		expect(screen.getByText("mcp:deleteDialog.title")).toBeInTheDocument()

		fireEvent.click(screen.getByText("mcp:deleteDialog.cancel"))
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deleteMcpServer" }))
	})

	it("deletes the server once confirmed", () => {
		state.mcpServers = [server({ name: "files" })]
		render(<McpView />)

		fireEvent.click(document.querySelector(".codicon-trash")!.closest("button")!)
		fireEvent.click(screen.getByText("mcp:deleteDialog.delete"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "deleteMcpServer",
			serverName: "files",
			source: "global",
		})
	})

	it("locks delete, disable and timeout for an org-locked global server", () => {
		state.mcpServers = [server({ name: "locked" })]
		state.orgLockedResources = { mcp: ["locked"] }
		render(<McpView />)

		expect(screen.getByTestId("mcp-org-locked-icon")).toBeInTheDocument()
		expect(document.querySelector(".codicon-trash")!.closest("button")).toBeDisabled()
		expect(screen.getByRole("combobox")).toBeDisabled()
	})

	it("does not lock a project-scoped server of the same name", () => {
		state.mcpServers = [server({ name: "locked", source: "project" })]
		state.orgLockedResources = { mcp: ["locked"] }
		render(<McpView />)
		expect(screen.queryByTestId("mcp-org-locked-icon")).not.toBeInTheDocument()
	})

	it("renders a resource row's description, name and mime type", () => {
		state.mcpServers = [
			server({
				name: "files",
				resources: [
					{ uri: "a", name: "A", description: "the a", mimeType: "text/plain" },
					{ uri: "b", description: "only description" },
					{ uri: "c", name: "only name" },
					{ uri: "d" },
				] as never,
			}),
		]
		render(<McpView />)
		fireEvent.click(screen.getByText("mcp:tabs.resources"))

		expect(screen.getByText("A: the a")).toBeInTheDocument()
		expect(screen.getByText("only description")).toBeInTheDocument()
		expect(screen.getByText("only name")).toBeInTheDocument()
		expect(screen.getByText("No description")).toBeInTheDocument()
		expect(screen.getAllByText("Unknown").length).toBe(3)
		expect(within(screen.getByText("A: the a").parentElement!).getByText("text/plain")).toBeInTheDocument()
	})
})
