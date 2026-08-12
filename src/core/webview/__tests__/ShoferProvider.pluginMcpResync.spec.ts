// npx vitest core/webview/__tests__/ShoferProvider.pluginMcpResync.spec.ts

/**
 * A plugin's `contributes.mcpServers` must reach the MCP hub on a HEADLESS host.
 *
 * `McpHub` reads the shared plugin manager exactly once, in its constructor, and
 * the manager is installed lazily by `getPluginManager()` — usually afterwards.
 * A host with a Plugins panel closes that gap by accident: the next
 * enable/disable runs `resyncAfterPluginChange`. A headless worker has no panel,
 * no `.shofer/mcp.json` edit and no workspace-folder change, so before this fix
 * nothing ever re-synced and a plugin's declared MCP server was never spawned —
 * silently, with the plugin itself loading normally.
 */

import * as vscode from "vscode"

import { TelemetryService } from "@shofer/telemetry"

import { PluginManager } from "@shofer/core"

import { ContextProxy } from "../../config/ContextProxy"
import { ShoferProvider } from "../ShoferProvider"
import { McpServerManager } from "../../../services/mcp/McpServerManager"

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	Uri: { joinPath: vi.fn(), file: vi.fn() },
	commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue([]), update: vi.fn() }),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
		workspaceFolders: undefined,
	},
	env: { uriScheme: "vscode", language: "en", appName: "Visual Studio Code" },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	CodeActionKind: { QuickFix: { value: "quickfix" }, RefactorRewrite: { value: "refactor.rewrite" } },
	version: "1.85.0",
	TreeItem: vi.fn(),
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: vi.fn(),
	EventEmitter: vi.fn().mockImplementation(() => ({
		event: vi.fn(() => ({ dispose: vi.fn() })),
		fire: vi.fn(),
		dispose: vi.fn(),
	})),
	TreeDragAndDropController: vi.fn(),
	TreeDataProvider: vi.fn(),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(() => ({ initializeFilePaths: vi.fn(), dispose: vi.fn() })),
}))

vi.mock("@shofer/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(false),
		get instance() {
			return { isAuthenticated: vi.fn().mockReturnValue(false) }
		},
	},
	getShoferApiUrl: vi.fn().mockReturnValue("https://app.shofer.dev"),
}))

// The hub is a singleton behind an async factory; this stands in for it so the
// test asserts the WIRING (who re-syncs, and when), not the hub's own merge —
// which `McpHub.spec.ts` covers at its own seam.
const refreshProjectMcpServers = vi.fn().mockResolvedValue(undefined)
const waitUntilReady = vi.fn().mockResolvedValue(undefined)
vi.mock("../../../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		getInstance: vi.fn(),
		unregisterProvider: vi.fn(),
		notifyProviders: vi.fn(),
		cleanup: vi.fn(),
	},
}))

describe("ShoferProvider — plugin-contributed MCP servers reach a headless host", () => {
	let provider: ShoferProvider

	beforeEach(() => {
		vi.clearAllMocks()
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		vi.mocked(McpServerManager.getInstance).mockResolvedValue({
			registerClient: vi.fn(),
			getAllServers: vi.fn().mockReturnValue([]),
			waitUntilReady,
			refreshProjectMcpServers,
		} as never)

		const globalState: Record<string, unknown> = {}
		const context = {
			extensionPath: "/test/path",
			extensionUri: {} as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => globalState[key]),
				update: vi.fn().mockImplementation((key: string, value: unknown) => (globalState[key] = value)),
				keys: vi.fn().mockImplementation(() => Object.keys(globalState)),
			},
			secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
			workspaceState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined), keys: vi.fn(() => []) },
			subscriptions: [],
			extension: { packageJSON: { version: "1.0.0" } },
			globalStorageUri: { fsPath: "/test/storage/path" },
		} as unknown as vscode.ExtensionContext

		const outputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		provider = new ShoferProvider(context, outputChannel, "sidebar", new ContextProxy(context))
	})

	it("re-syncs the MCP hub once the plugin manager lands and its plugins are active", async () => {
		// Nothing has installed a manager yet, so a hub built now would have read
		// an empty contribution set — the headless steady state before this fix.
		expect(refreshProjectMcpServers).not.toHaveBeenCalled()

		await provider.getPluginManager()
		// The re-sync is fire-and-forget; let its microtasks run.
		await vi.waitFor(() => expect(refreshProjectMcpServers).toHaveBeenCalled())

		// And it waits for the hub's own initial connect first, so the re-sync
		// cannot race the connections the constructor is still making.
		expect(waitUntilReady).toHaveBeenCalled()
	})

	// The second half of the ordering, and the one that decides whether a
	// contributed server's `${env:…}` resolves: `activateCodePlugins` awaits each
	// plugin's `initialize` AND its services' `start`, which is where a plugin
	// publishes the process env its own MCP server is declared against. Spawning
	// the child first hands it the literal placeholder string, silently.
	it("does not connect contributed servers before code plugins have activated", async () => {
		let releaseActivation: () => void = () => {}
		const activation = new Promise<void>((resolve) => {
			releaseActivation = resolve
		})
		const spy = vi.spyOn(PluginManager.prototype, "activateCodePlugins").mockReturnValue(activation)

		try {
			await provider.getPluginManager()
			// Activation is still in flight: nothing may have been connected yet.
			await Promise.resolve()
			expect(refreshProjectMcpServers).not.toHaveBeenCalled()

			releaseActivation()
			await vi.waitFor(() => expect(refreshProjectMcpServers).toHaveBeenCalled())
		} finally {
			spy.mockRestore()
		}
	})
})
