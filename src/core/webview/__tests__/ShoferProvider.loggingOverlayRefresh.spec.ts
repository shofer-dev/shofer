// npx vitest run core/webview/__tests__/ShoferProvider.loggingOverlayRefresh.spec.ts
//
// A `.shofer/` scope change (org bundle re-materialized, worker ConfigMap swap)
// that moves `logLevel` / `logCategories` must be re-applied to the LIVE logging
// transport. The transport is otherwise wired only at activation and on a
// webview settings edit — neither fires on a headless host, so without the
// overlay-refresh hook a projected logging change sat inert until restart.

import * as vscode from "vscode"
import { setLogLevel, setLogCategories } from "@shofer/core"
import { TelemetryService } from "@shofer/telemetry"
import { ShoferProvider } from "../ShoferProvider"
import { ContextProxy } from "../../config/ContextProxy"

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
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
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
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
	default: vi.fn().mockImplementation(() => ({
		initializeFilePaths: vi.fn(),
		dispose: vi.fn(),
	})),
}))

vi.mock("@shofer/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
			}
		},
	},
	getShoferApiUrl: vi.fn().mockReturnValue("https://app.shofer.dev"),
}))

// Partial mock: keep the real barrel, replace the two live-transport setters the
// SUT re-applies (both the static import here and the handler's dynamic
// `await import("@shofer/core")` resolve to this mocked module).
vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	setLogLevel: vi.fn(),
	setLogCategories: vi.fn(),
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
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
	rename: vi.fn().mockResolvedValue(undefined),
}))

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

/** Let the handler's fire-and-forget async body (dynamic import) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("ShoferProvider - logging settings re-applied on overlay refresh", () => {
	let provider: ShoferProvider
	let contextProxy: ContextProxy

	beforeEach(async () => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, unknown> = { mode: "code" }
		const secrets: Record<string, string | undefined> = {}

		const mockContext = {
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
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		const mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		contextProxy = new ContextProxy(mockContext)
		provider = new ShoferProvider(mockContext, mockOutputChannel, "sidebar", contextProxy)
		await flush()
	})

	afterEach(async () => {
		await provider.dispose()
	})

	const fireOverlayRefresh = (keys: string[]) => {
		;(contextProxy as any)._onDidRefreshOverlayEmitter.fire({ keys })
	}

	it("re-applies a changed logCategories whitelist to the live transport", async () => {
		vi.spyOn(contextProxy, "getValue").mockImplementation(
			(key: any) => (key === "logCategories" ? ["mcp", "provider"] : undefined) as any,
		)

		fireOverlayRefresh(["logCategories"])
		await flush()

		expect(setLogCategories).toHaveBeenCalledWith(["mcp", "provider"])
		expect(setLogLevel).not.toHaveBeenCalled()
	})

	it("maps a removed or emptied logCategories to undefined (show all)", async () => {
		vi.spyOn(contextProxy, "getValue").mockReturnValue(undefined as any)

		fireOverlayRefresh(["logCategories"])
		await flush()

		expect(setLogCategories).toHaveBeenCalledWith(undefined)
	})

	it("re-applies a changed logLevel, and leaves the level alone when removed", async () => {
		vi.spyOn(contextProxy, "getValue").mockImplementation(
			(key: any) => (key === "logLevel" ? "debug" : undefined) as any,
		)

		fireOverlayRefresh(["logLevel"])
		await flush()

		expect(setLogLevel).toHaveBeenCalledWith("debug")

		// Removal: the key changed but now resolves to nothing — no reset call,
		// the current level stands (there is no single default to restore).
		vi.mocked(setLogLevel).mockClear()
		vi.spyOn(contextProxy, "getValue").mockReturnValue(undefined as any)

		fireOverlayRefresh(["logLevel"])
		await flush()

		expect(setLogLevel).not.toHaveBeenCalled()
	})

	it("does not touch the transport when unrelated keys change", async () => {
		fireOverlayRefresh(["alwaysAllowWrite"])
		await flush()

		expect(setLogLevel).not.toHaveBeenCalled()
		expect(setLogCategories).not.toHaveBeenCalled()
	})
})
