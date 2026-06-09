// npx vitest run core/webview/__tests__/ShoferProvider.providerYamlSync.spec.ts

/**
 * Pins the bidirectional sync between custom-mode YAML `provider:` and the
 * in-memory `modeApiConfigs` mapping introduced alongside the custom-mode
 * `provider` field.
 *
 * Covers:
 *   - `handleModeSwitch` precedence: YAML `provider:` wins over saved per-mode mapping.
 *   - `handleModeSwitch` fallback: saved mapping is used when no YAML provider is set.
 *   - `syncCustomModeProviderToYaml`:
 *       * skipped for built-in modes (no `source` ⇒ no YAML),
 *       * short-circuits when the YAML field already matches,
 *       * targets the project (`.shofer/shofermodes`) file when a workspace is open,
 *       * targets the global file when no workspace is open.
 */

import * as vscode from "vscode"
import { TelemetryService } from "@shofer/telemetry"
import { ShoferProvider } from "../ShoferProvider"
import { ContextProxy } from "../../config/ContextProxy"

let workspaceFolders: ReadonlyArray<unknown> | undefined = undefined

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Uri: { joinPath: vi.fn(), file: vi.fn() },
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		visibleTextEditors: [],
		tabGroups: { all: [], onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })) },
	},
	workspace: {
		// Tests mutate the outer `workspaceFolders` to simulate workspace presence.
		get workspaceFolders() {
			return workspaceFolders
		},
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: { uriScheme: "vscode", language: "en", appName: "Visual Studio Code" },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	version: "1.85.0",
	// `extension.ts` transitively imports `ContextDropZoneProvider`, which references
	// these vscode classes at module-evaluation time; provide minimal stand-ins so
	// the import graph resolves under vitest's `vscode` mock.
	TreeItem: class {
		constructor(
			public label?: string,
			public collapsibleState?: number,
		) {}
	},
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: class {
		constructor(public id: string) {}
	},
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
}))

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation((options) => ({
		taskId: options.taskId || "test-task-id",
		emit: vi.fn(),
		updateApiConfiguration: vi.fn(),
		setTaskApiConfigName: vi.fn(),
	})),
}))

vi.mock("../../prompts/sections/custom-instructions")
vi.mock("../../../utils/safeWriteJson")

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({ id: "claude-3-sonnet" }),
	}),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(() => ({
		initializeFilePaths: vi.fn(),
		dispose: vi.fn(),
	})),
}))

vi.mock("../../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(() => ({
		getName: () => "test-strategy",
		applyDiff: vi.fn(),
	})),
}))

vi.mock("@shofer/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return { isAuthenticated: vi.fn().mockReturnValue(false) }
		},
	},
	getShoferApiUrl: vi.fn().mockReturnValue("https://app.shofer.dev"),
}))

// Built-in mode `code` plus a custom mode `reviewer` are returned via getModeBySlug.
// Each test replaces this default with a more specific mock.
vi.mock("../../../shared/modes", () => {
	const builtins = [{ slug: "code", name: "Code Mode", roleDefinition: "code", groups: ["read", "write"] }]
	return {
		modes: builtins,
		getAllModes: vi.fn(() => [...builtins]),
		getModeBySlug: vi.fn(),
		defaultModeSlug: "code",
	}
})

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue(""),
}))

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	readdir: vi.fn().mockResolvedValue([]),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/storage")>()
	return {
		...actual,
		getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
		getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
		getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	}
})

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		createInstance: vi.fn(),
		get instance() {
			return {
				trackEvent: vi.fn(),
				trackError: vi.fn(),
				setProvider: vi.fn(),
				captureModeSwitch: vi.fn(),
			}
		},
	},
}))

describe("ShoferProvider - custom-mode YAML provider sync", () => {
	let provider: ShoferProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: vscode.WebviewView

	beforeEach(async () => {
		vi.clearAllMocks()
		workspaceFolders = undefined

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, unknown> = {
			mode: "code",
			currentApiConfigName: "default-profile",
		}
		const workspaceState: Record<string, unknown> = {}
		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: {} as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => globalState[key]),
				update: vi.fn().mockImplementation((key: string, value: unknown) => {
					globalState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => Object.keys(globalState)),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => secrets[key]),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					secrets[key] = value
					return Promise.resolve()
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					delete secrets[key]
					return Promise.resolve()
				}),
			},
			workspaceState: {
				get: vi.fn().mockImplementation((key: string, defaultValue?: unknown) => {
					return key in workspaceState ? workspaceState[key] : defaultValue
				}),
				update: vi.fn().mockImplementation((key: string, value: unknown) => {
					workspaceState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => Object.keys(workspaceState)),
			},
			subscriptions: [],
			extension: { packageJSON: { version: "1.0.0" } },
			globalStorageUri: { fsPath: "/test/storage/path" },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockWebviewView = {
			webview: {
				postMessage: vi.fn(),
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			onDidDispose: vi.fn().mockImplementation((callback) => {
				callback()
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
		} as unknown as vscode.WebviewView

		provider = new ShoferProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

		provider.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue([]),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})

		await provider.resolveWebviewView(mockWebviewView)
	})

	describe("handleModeSwitch precedence", () => {
		it("YAML provider:` field overrides saved per-mode mapping", async () => {
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug).mockReturnValue({
				slug: "reviewer",
				name: "Reviewer",
				roleDefinition: "review",
				groups: ["read"],
				source: "global",
				provider: "yaml-profile",
			})

			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("saved-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-id", apiProvider: "anthropic" },
				{ name: "yaml-profile", id: "yaml-id", apiProvider: "openai" },
			])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "yaml-profile",
				apiProvider: "openai",
			})
			// Custom-mode list (used by syncCustomModeProviderToYaml — already in sync, no write)
			vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([
				{
					slug: "reviewer",
					name: "Reviewer",
					roleDefinition: "review",
					groups: ["read"],
					source: "global",
					provider: "yaml-profile",
				},
			])
			const updateCustomModeSpy = vi
				.spyOn(provider.customModesManager, "updateCustomMode")
				.mockResolvedValue(undefined)
			const activateSpy = vi.spyOn(provider, "activateProviderProfile").mockResolvedValue(undefined)

			await provider.handleUserModeSwitch("reviewer")

			expect(activateSpy).toHaveBeenCalledWith({ name: "yaml-profile" })
			// Already in sync ⇒ no YAML write.
			expect(updateCustomModeSpy).not.toHaveBeenCalled()
		})

		it("falls back to saved mapping when YAML has no provider field", async () => {
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug).mockReturnValue({
				slug: "reviewer",
				name: "Reviewer",
				roleDefinition: "review",
				groups: ["read"],
				source: "global",
			})

			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("saved-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-id", apiProvider: "anthropic" },
			])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "saved-profile",
				apiProvider: "anthropic",
			})
			const activateSpy = vi.spyOn(provider, "activateProviderProfile").mockResolvedValue(undefined)

			await provider.handleUserModeSwitch("reviewer")

			expect(activateSpy).toHaveBeenCalledWith({ name: "saved-profile" })
		})
	})

	describe("syncCustomModeProviderToYaml", () => {
		const callSync = (mode: string, name: string) =>
			(
				provider as unknown as { syncCustomModeProviderToYaml: (m: string, n: string) => Promise<void> }
			).syncCustomModeProviderToYaml(mode, name)

		it("is a no-op for built-in modes (no source)", async () => {
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug).mockReturnValue({
				slug: "code",
				name: "Code",
				roleDefinition: "code",
				groups: ["read", "write"],
			})
			vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([])
			const updateSpy = vi.spyOn(provider.customModesManager, "updateCustomMode").mockResolvedValue(undefined)

			await callSync("code", "any-profile")

			expect(updateSpy).not.toHaveBeenCalled()
		})

		it("short-circuits when YAML provider already matches", async () => {
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug).mockReturnValue({
				slug: "reviewer",
				name: "Reviewer",
				roleDefinition: "review",
				groups: ["read"],
				source: "global",
				provider: "same-profile",
			})
			vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([])
			const updateSpy = vi.spyOn(provider.customModesManager, "updateCustomMode").mockResolvedValue(undefined)

			// No workspace ⇒ target is global; current source is global; provider matches ⇒ no-op.
			workspaceFolders = undefined
			await callSync("reviewer", "same-profile")

			expect(updateSpy).not.toHaveBeenCalled()
		})

		it("writes to project (.shofer/shofermodes) when a workspace is open", async () => {
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug).mockReturnValue({
				slug: "reviewer",
				name: "Reviewer",
				roleDefinition: "review",
				groups: ["read"],
				source: "global",
				provider: "old-profile",
			})
			vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([])
			const updateSpy = vi.spyOn(provider.customModesManager, "updateCustomMode").mockResolvedValue(undefined)

			workspaceFolders = [{}] // simulate at least one open workspace folder

			await callSync("reviewer", "new-profile")

			expect(updateSpy).toHaveBeenCalledTimes(1)
			expect(updateSpy).toHaveBeenCalledWith(
				"reviewer",
				expect.objectContaining({ source: "project", provider: "new-profile" }),
			)
		})

		it("writes to global when no workspace is open", async () => {
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug).mockReturnValue({
				slug: "reviewer",
				name: "Reviewer",
				roleDefinition: "review",
				groups: ["read"],
				source: "global",
				provider: "old-profile",
			})
			vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([])
			const updateSpy = vi.spyOn(provider.customModesManager, "updateCustomMode").mockResolvedValue(undefined)

			workspaceFolders = undefined

			await callSync("reviewer", "new-profile")

			expect(updateSpy).toHaveBeenCalledTimes(1)
			expect(updateSpy).toHaveBeenCalledWith(
				"reviewer",
				expect.objectContaining({ source: "global", provider: "new-profile" }),
			)
		})
	})
})
