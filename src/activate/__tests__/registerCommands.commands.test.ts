// npx vitest src/activate/__tests__/registerCommands.commands.test.ts

/**
 * The typed-command table. Per the Typed Command Rule every command is
 * registered here from the `CommandId` plumbing rather than ad-hoc, so this test
 * drives the table the way VS Code does — register once, then invoke each id —
 * and pins the two behaviours that are invisible from the outside:
 *
 *  - every title-bar command REFUSES QUIETLY when no webview is visible (it logs
 *    and returns; it must not throw into VS Code's command dispatcher), and
 *  - the two webview-recovery commands are gated on the liveness-monitor
 *    experiment, because their command ids stay invokable from the Command
 *    Palette even when the `when`-clause hides the buttons.
 */

const hoisted = vi.hoisted(() => ({
	registered: new Map<string, (...args: unknown[]) => unknown>(),
	executeCommand: vi.fn(async () => undefined),
	openExternal: vi.fn(async () => true),
	notifier: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		showChoice: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
	},
	visibleInstance: undefined as unknown,
	captureTitleButtonClicked: vi.fn(),
	promptForCustomStoragePath: vi.fn(async () => undefined),
	importSettingsWithFeedback: vi.fn(async () => undefined),
	focusPanel: vi.fn(async () => undefined),
	handleNewTask: vi.fn(async () => undefined),
	mkdir: vi.fn(async () => undefined),
	writeHeapSnapshot: vi.fn((p: string): string => p),
	workspaceFolders: [{ uri: { fsPath: "/workspace" } }] as Array<{ uri: { fsPath: string } }> | undefined,
	constructed: [] as unknown[][],
	resolveWebviewView: vi.fn(async () => undefined),
	visibleTextEditors: [] as Array<{ viewColumn?: number }>,
	createWebviewPanel: vi.fn(),
}))

vi.mock("vscode", () => ({
	commands: {
		registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
			hoisted.registered.set(id, cb)
			return { dispose: () => {} }
		},
		executeCommand: hoisted.executeCommand,
	},
	env: { openExternal: hoisted.openExternal },
	Uri: { parse: (v: string) => ({ toString: () => v, value: v }), joinPath: (...p: unknown[]) => ({ p }) },
	ViewColumn: { Active: -1, Two: 2 },
	window: {
		get visibleTextEditors() {
			return hoisted.visibleTextEditors
		},
		createWebviewPanel: (...args: unknown[]) => hoisted.createWebviewPanel(...args),
	},
	workspace: {
		get workspaceFolders() {
			return hoisted.workspaceFolders
		},
	},
}))

vi.mock("v8", () => ({ writeHeapSnapshot: (p: string) => hoisted.writeHeapSnapshot(p) }))

vi.mock("fs/promises", () => ({ default: { mkdir: hoisted.mkdir }, mkdir: hoisted.mkdir }))

vi.mock("delay", () => ({ default: async () => undefined }))

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({ notifier: hoisted.notifier }),
}))

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			get captureTitleButtonClicked() {
				return hoisted.captureTitleButtonClicked
			},
		},
	},
}))

vi.mock("../../core/webview/ShoferProvider", () => {
	class ShoferProvider {
		static tabPanelId = "shofer.TabPanelProvider"
		static sideBarId = "shofer.SidebarProvider"
		static getVisibleInstance = () => hoisted.visibleInstance
		resolveWebviewView = hoisted.resolveWebviewView
		constructor(...args: unknown[]) {
			hoisted.constructed.push(args)
		}
	}
	return { ShoferProvider }
})

vi.mock("../../core/config/ContextProxy", () => ({
	ContextProxy: { getInstance: async () => ({ marker: "context-proxy" }) },
}))

vi.mock("../../utils/storage", () => ({ promptForCustomStoragePath: hoisted.promptForCustomStoragePath }))

vi.mock("../../utils/focusPanel", () => ({ focusPanel: hoisted.focusPanel }))

vi.mock("../handleTask", () => ({ handleNewTask: hoisted.handleNewTask }))

vi.mock("../../core/config/importExport", () => ({ importSettingsWithFeedback: hoisted.importSettingsWithFeedback }))

import { EXPERIMENT_IDS } from "@shofer/types"

import { getPanel, openShoferInNewTab, registerCommands, setPanel } from "../registerCommands"

type Provider = {
	postMessageToWebview: ReturnType<typeof vi.fn>
	contextProxy: { getValue: ReturnType<typeof vi.fn> }
	customModesManager: unknown
	refreshWebview: ReturnType<typeof vi.fn>
}

const outputChannel = { appendLine: vi.fn() } as unknown as import("vscode").OutputChannel
const context = { subscriptions: [] as unknown[] } as unknown as import("vscode").ExtensionContext

function makeVisibleProvider(experimentsValue: Record<string, boolean> | undefined = {}): Provider {
	return {
		postMessageToWebview: vi.fn(async () => undefined),
		contextProxy: { getValue: vi.fn(() => experimentsValue) },
		customModesManager: {},
		refreshWebview: vi.fn(async () => undefined),
	}
}

/** Register the table once per test and hand back the id→callback map. */
function commands() {
	hoisted.registered.clear()
	registerCommands({ context, outputChannel, provider: {} as never })
	return hoisted.registered
}

async function invoke(id: string, ...args: unknown[]) {
	const cb = commands().get(id)
	expect(cb, `command ${id} is not registered`).toBeDefined()
	return await cb!(...args)
}

/** The postMessageToWebview payloads a command produced. */
function posted(provider: Provider) {
	return provider.postMessageToWebview.mock.calls.map(([m]) => m)
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.visibleInstance = undefined
	hoisted.workspaceFolders = [{ uri: { fsPath: "/workspace" } }]
})

describe("registerCommands", () => {
	it("registers every command against the extension's subscriptions", () => {
		const subscriptions: unknown[] = []
		hoisted.registered.clear()

		registerCommands({
			context: { subscriptions } as unknown as import("vscode").ExtensionContext,
			outputChannel,
			provider: {} as never,
		})

		expect(hoisted.registered.size).toBeGreaterThan(20)
		expect(subscriptions).toHaveLength(hoisted.registered.size)
	})

	it("prefixes every id — nothing bare reaches vscode.commands", () => {
		for (const id of commands().keys()) {
			expect(id.startsWith("shofer.")).toBe(true)
		}
	})

	it("activationCompleted is a no-op marker command", async () => {
		await expect(invoke("shofer.activationCompleted")).resolves.toBeUndefined()
	})
})

describe("title-bar commands with no visible webview", () => {
	const ids = [
		"shofer.plusButtonClicked",
		"shofer.settingsButtonClicked",
		"shofer.aboutButtonClicked",
		"shofer.historyButtonClicked",
		"shofer.welcomeButtonClicked",
		"shofer.tasksButtonClicked",
		"shofer.acceptInput",
		"shofer.toggleAutoApprove",
		"shofer.importSettings",
		"shofer.refreshWebview",
		"shofer.reloadWindow",
	]

	it.each(ids)("%s logs and returns rather than throwing", async (id) => {
		await expect(invoke(id)).resolves.not.toThrow?.()
		expect(outputChannel.appendLine).toHaveBeenCalledWith("Cannot find any visible Shofer instances.")
		expect(hoisted.captureTitleButtonClicked).not.toHaveBeenCalled()
	})
})

describe("title-bar commands with a visible webview", () => {
	let provider: Provider

	beforeEach(() => {
		provider = makeVisibleProvider()
		hoisted.visibleInstance = provider
	})

	it("plusButtonClicked opens the in-webview launcher", async () => {
		await invoke("shofer.plusButtonClicked")

		expect(hoisted.captureTitleButtonClicked).toHaveBeenCalledWith("plus")
		expect(posted(provider)).toEqual([{ type: "action", action: "newMenuButtonClicked" }])
	})

	it("settingsButtonClicked ALSO posts didBecomeVisible, which is what makes the scroll land", async () => {
		await invoke("shofer.settingsButtonClicked")

		expect(posted(provider)).toEqual([
			{ type: "action", action: "settingsButtonClicked" },
			{ type: "action", action: "didBecomeVisible" },
		])
	})

	it("aboutButtonClicked routes through settings with a section target — About is not its own view", async () => {
		await invoke("shofer.aboutButtonClicked")

		expect(posted(provider)[0]).toEqual({
			type: "action",
			action: "settingsButtonClicked",
			values: { section: "about" },
		})
		expect(hoisted.captureTitleButtonClicked).toHaveBeenCalledWith("about")
	})

	it.each([
		["shofer.historyButtonClicked", "history", "historyButtonClicked"],
		["shofer.welcomeButtonClicked", "welcome", "welcomeButtonClicked"],
		["shofer.tasksButtonClicked", "tasks", "tasksButtonClicked"],
	])("%s posts %s", async (id, telemetry, action) => {
		await invoke(id)

		expect(hoisted.captureTitleButtonClicked).toHaveBeenCalledWith(telemetry)
		expect(posted(provider)).toEqual([{ type: "action", action }])
	})

	it("acceptInput posts the bare acceptInput message", async () => {
		await invoke("shofer.acceptInput")
		expect(posted(provider)).toEqual([{ type: "acceptInput" }])
	})

	it("toggleAutoApprove posts the toggle action", async () => {
		await invoke("shofer.toggleAutoApprove")
		expect(posted(provider)).toEqual([{ type: "action", action: "toggleAutoApprove" }])
	})

	it("importSettings delegates to the shared importer, forwarding an explicit path", async () => {
		await invoke("shofer.importSettings", "/tmp/settings.json")

		expect(hoisted.importSettingsWithFeedback).toHaveBeenCalledWith(
			expect.objectContaining({ provider, customModesManager: provider.customModesManager }),
			"/tmp/settings.json",
		)
	})
})

describe("webview recovery commands are experiment-gated", () => {
	it("refreshWebview does nothing while the liveness experiment is off", async () => {
		const provider = makeVisibleProvider({})
		hoisted.visibleInstance = provider

		await invoke("shofer.refreshWebview")

		expect(provider.refreshWebview).not.toHaveBeenCalled()
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[refreshWebview] Skipped (webview liveness monitor experiment disabled)",
		)
	})

	it("refreshWebview runs once the experiment is on", async () => {
		const provider = makeVisibleProvider({ [EXPERIMENT_IDS.WEBVIEW_LIVENESS_MONITOR]: true })
		hoisted.visibleInstance = provider

		await invoke("shofer.refreshWebview")

		expect(provider.refreshWebview).toHaveBeenCalled()
	})

	it("treats an ABSENT experiments value as off", async () => {
		const provider = makeVisibleProvider(undefined)
		hoisted.visibleInstance = provider

		await invoke("shofer.refreshWebview")

		expect(provider.refreshWebview).not.toHaveBeenCalled()
	})

	it("reloadWindow is gated the same way", async () => {
		hoisted.visibleInstance = makeVisibleProvider({})

		await invoke("shofer.reloadWindow")

		expect(hoisted.notifier.showChoice).not.toHaveBeenCalled()
		expect(hoisted.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
	})

	it("reloadWindow CONFIRMS before nuking the window, and does nothing if declined", async () => {
		hoisted.visibleInstance = makeVisibleProvider({ [EXPERIMENT_IDS.WEBVIEW_LIVENESS_MONITOR]: true })
		hoisted.notifier.showChoice.mockResolvedValueOnce(undefined)

		await invoke("shofer.reloadWindow")

		expect(hoisted.notifier.showChoice).toHaveBeenCalledWith(expect.any(String), ["Reload Window"], {
			severity: "warn",
			modal: true,
		})
		expect(hoisted.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
	})

	it("reloadWindow reloads once the user confirms", async () => {
		hoisted.visibleInstance = makeVisibleProvider({ [EXPERIMENT_IDS.WEBVIEW_LIVENESS_MONITOR]: true })
		hoisted.notifier.showChoice.mockResolvedValueOnce("Reload Window")

		await invoke("shofer.reloadWindow")

		expect(hoisted.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow")
	})
})

describe("panel focus commands", () => {
	afterEach(() => setPanel(undefined, "tab"))

	it("setPanel keeps exactly ONE panel — a tab supersedes the sidebar and vice versa", () => {
		const sidebar = { id: "sidebar" } as never
		const tab = { id: "tab" } as never

		setPanel(sidebar, "sidebar")
		expect(getPanel()).toBe(sidebar)

		setPanel(tab, "tab")
		expect(getPanel()).toBe(tab)

		setPanel(sidebar, "sidebar")
		expect(getPanel()).toBe(sidebar)
	})

	it("focusInput posts focusInput only for the SIDEBAR", async () => {
		const provider = makeVisibleProvider()
		setPanel({ id: "sidebar" } as never, "sidebar")
		hoisted.registered.clear()
		registerCommands({ context, outputChannel, provider: provider as never })

		await hoisted.registered.get("shofer.focusInput")!()

		expect(hoisted.focusPanel).toHaveBeenCalled()
		expect(posted(provider)).toEqual([{ type: "action", action: "focusInput" }])
	})

	it("focusInput posts nothing for a TAB panel", async () => {
		const provider = makeVisibleProvider()
		setPanel({ id: "tab" } as never, "tab")
		hoisted.registered.clear()
		registerCommands({ context, outputChannel, provider: provider as never })

		await hoisted.registered.get("shofer.focusInput")!()

		expect(posted(provider)).toEqual([])
	})

	it("focusInput logs a focus failure instead of rejecting", async () => {
		hoisted.focusPanel.mockRejectedValueOnce(new Error("no view"))

		await invoke("shofer.focusInput")

		expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Error focusing input"))
	})

	it("focusPanel logs a focus failure instead of rejecting", async () => {
		hoisted.focusPanel.mockRejectedValueOnce(new Error("no view"))

		await invoke("shofer.focusPanel")

		expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Error focusing panel"))
	})
})

describe("standalone commands", () => {
	it("newTask delegates to the shared handler", async () => {
		await invoke("shofer.newTask", { prompt: "do it" })
		expect(hoisted.handleNewTask).toHaveBeenCalledWith({ prompt: "do it" })
	})

	it("setCustomStoragePath lazily imports the prompt", async () => {
		await invoke("shofer.setCustomStoragePath")
		expect(hoisted.promptForCustomStoragePath).toHaveBeenCalled()
	})

	it("heapSnapshot writes INSIDE the prepared directory, not process.cwd()", async () => {
		await invoke("shofer.heapSnapshot")

		expect(hoisted.mkdir).toHaveBeenCalledWith("/workspace/.shofer/heap-snapshots", { recursive: true })
		const [target] = hoisted.writeHeapSnapshot.mock.calls[0]
		expect(target).toMatch(/^\/workspace\/\.shofer\/heap-snapshots\/heap-.*\.heapsnapshot$/)
		expect(hoisted.notifier.info).toHaveBeenCalledWith(expect.stringContaining(target))
	})

	it("heapSnapshot falls back to the process cwd with no workspace open", async () => {
		hoisted.workspaceFolders = undefined

		await invoke("shofer.heapSnapshot")

		expect(hoisted.mkdir).toHaveBeenCalledWith(expect.stringContaining(".shofer/heap-snapshots"), {
			recursive: true,
		})
	})

	it.each([
		["shofer.walkthrough.openDocumentation", "USER_MANUAL.md"],
		["shofer.walkthrough.joinDiscord", "discord.gg"],
		["shofer.walkthrough.openCopilotGuide", "shofer_for_copilot_users.md"],
		["shofer.walkthrough.openRoocodeGuide", "shofer_for_roocode_users.md"],
		["shofer.walkthrough.openClaudeCodeGuide", "shofer_for_claude_code_users.md"],
		["shofer.walkthrough.openOpencodeGuide", "shofer_for_opencode_users.md"],
	])("%s opens %s externally", async (id, fragment) => {
		await invoke(id)

		expect(hoisted.openExternal).toHaveBeenCalledWith(
			expect.objectContaining({ value: expect.stringContaining(fragment) }),
		)
	})

	it("walkthrough.open asks the workbench for the walkthrough by qualified id", async () => {
		await invoke("shofer.walkthrough.open")

		expect(hoisted.executeCommand).toHaveBeenCalledWith(
			"workbench.action.openWalkthrough",
			expect.stringContaining("#shofer.getStarted"),
			false,
		)
	})
})

describe("openShoferInNewTab", () => {
	function makePanel() {
		return {
			webview: { postMessage: vi.fn() },
			iconPath: undefined as unknown,
			visible: true,
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		}
	}

	beforeEach(() => {
		hoisted.constructed = []
		hoisted.visibleTextEditors = []
		setPanel(undefined, "tab")
	})

	afterEach(() => setPanel(undefined, "tab"))

	it("opens a NEW editor group when there is nothing visible to sit beside", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)

		await openShoferInNewTab({ context, outputChannel })

		expect(hoisted.executeCommand).toHaveBeenCalledWith("workbench.action.newGroupRight")
		expect(hoisted.createWebviewPanel.mock.calls[0][2]).toBe(2 /* ViewColumn.Two */)
	})

	it("places the panel one column PAST the right-most visible editor", async () => {
		hoisted.visibleTextEditors = [{ viewColumn: 1 }, { viewColumn: 3 }]
		hoisted.createWebviewPanel.mockReturnValueOnce(makePanel())

		await openShoferInNewTab({ context, outputChannel })

		expect(hoisted.executeCommand).not.toHaveBeenCalledWith("workbench.action.newGroupRight")
		expect(hoisted.createWebviewPanel.mock.calls[0][2]).toBe(4)
	})

	it("retains context when hidden — a backgrounded tab must not lose the conversation", async () => {
		hoisted.createWebviewPanel.mockReturnValueOnce(makePanel())

		await openShoferInNewTab({ context, outputChannel })

		expect(hoisted.createWebviewPanel.mock.calls[0][3]).toMatchObject({
			enableScripts: true,
			retainContextWhenHidden: true,
		})
	})

	it("registers the panel, resolves the webview, and LOCKS the editor group", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)

		const provider = await openShoferInNewTab({ context, outputChannel })

		expect(hoisted.constructed).toHaveLength(1)
		expect(hoisted.resolveWebviewView).toHaveBeenCalledWith(panel)
		expect(getPanel()).toBe(panel)
		expect(hoisted.executeCommand).toHaveBeenCalledWith("workbench.action.lockEditorGroup")
		expect(provider).toBeDefined()
	})

	it("tells the webview it became visible again on a view-state change", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)

		await openShoferInNewTab({ context, outputChannel })
		const [onViewState] = panel.onDidChangeViewState.mock.calls[0]

		onViewState({ webviewPanel: { visible: true, webview: panel.webview } })
		expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: "action", action: "didBecomeVisible" })

		panel.webview.postMessage.mockClear()
		onViewState({ webviewPanel: { visible: false, webview: panel.webview } })
		expect(panel.webview.postMessage).not.toHaveBeenCalled()
	})

	it("clears the panel reference when the tab is closed", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)

		await openShoferInNewTab({ context, outputChannel })
		expect(getPanel()).toBe(panel)

		panel.onDidDispose.mock.calls[0][0]()
		expect(getPanel()).toBeUndefined()
	})
})
