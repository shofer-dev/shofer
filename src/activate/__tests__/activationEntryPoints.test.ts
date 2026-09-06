// npx vitest src/activate/__tests__/activationEntryPoints.test.ts

/**
 * The remaining activation entry points: the `vscode://` URI handler, the
 * "New Task" command, and the code-action / terminal-action command families.
 *
 * Each is a small dispatcher whose failure mode is silence, so the tests pin the
 * refusals rather than the happy paths: an unknown URI path does nothing, a
 * provider-less window does nothing, a cancelled task prompt focuses the sidebar
 * instead of starting an empty task, and a terminal action with no content warns
 * rather than sending an empty prompt to the model.
 */

const hoisted = vi.hoisted(() => ({
	visibleInstance: undefined as unknown,
	instance: undefined as unknown,
	handleCodeAction: vi.fn(async () => undefined),
	handleTerminalAction: vi.fn(async () => undefined),
	registered: new Map<string, (...args: unknown[]) => unknown>(),
	executeCommand: vi.fn(async () => undefined),
	showInputBox: vi.fn(async () => undefined as string | undefined),
	notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	editorContext: undefined as unknown,
	terminalContents: "" as string,
}))

vi.mock("vscode", () => ({
	commands: {
		registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
			hoisted.registered.set(id, cb)
			return { dispose: () => {} }
		},
		executeCommand: hoisted.executeCommand,
	},
	window: { showInputBox: hoisted.showInputBox },
}))

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({ notifier: hoisted.notifier }),
}))

vi.mock("../../core/webview/ShoferProvider", () => ({
	ShoferProvider: {
		getVisibleInstance: () => hoisted.visibleInstance,
		getInstance: async () => hoisted.instance,
		handleCodeAction: hoisted.handleCodeAction,
		handleTerminalAction: hoisted.handleTerminalAction,
	},
}))

vi.mock("../../integrations/editor/EditorUtils", () => ({
	EditorUtils: { getEditorContext: () => hoisted.editorContext },
}))

vi.mock("../../integrations/terminal/Terminal", () => ({
	Terminal: { getTerminalContents: vi.fn(async () => hoisted.terminalContents) },
}))

import { handleUri } from "../handleUri"
import { handleNewTask } from "../handleTask"
import { registerCodeActions } from "../registerCodeActions"
import { registerTerminalActions } from "../registerTerminalActions"
import { Terminal } from "../../integrations/terminal/Terminal"

const context = { subscriptions: [] as unknown[] } as unknown as import("vscode").ExtensionContext

function uri(path: string, query = "") {
	return { path, query } as import("vscode").Uri
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.registered.clear()
	hoisted.visibleInstance = undefined
	hoisted.instance = undefined
	hoisted.editorContext = undefined
	hoisted.terminalContents = ""
})

describe("handleUri", () => {
	function makeProvider() {
		return {
			handleOpenRouterCallback: vi.fn(async () => undefined),
			handleRequestyCallback: vi.fn(async () => undefined),
		}
	}

	it("does nothing when no webview is visible to receive the callback", async () => {
		await expect(handleUri(uri("/openrouter", "code=abc"))).resolves.toBeUndefined()
	})

	it("hands an OpenRouter code to the visible provider", async () => {
		const provider = makeProvider()
		hoisted.visibleInstance = provider

		await handleUri(uri("/openrouter", "code=abc123"))

		expect(provider.handleOpenRouterCallback).toHaveBeenCalledWith("abc123")
	})

	it("ignores an OpenRouter callback carrying no code", async () => {
		const provider = makeProvider()
		hoisted.visibleInstance = provider

		await handleUri(uri("/openrouter", "state=xyz"))

		expect(provider.handleOpenRouterCallback).not.toHaveBeenCalled()
	})

	it("passes Requesty's optional baseUrl through", async () => {
		const provider = makeProvider()
		hoisted.visibleInstance = provider

		await handleUri(uri("/requesty", "code=c1&baseUrl=https://api.example"))

		expect(provider.handleRequestyCallback).toHaveBeenCalledWith("c1", "https://api.example")
	})

	it("passes a null baseUrl when Requesty omits it", async () => {
		const provider = makeProvider()
		hoisted.visibleInstance = provider

		await handleUri(uri("/requesty", "code=c1"))

		expect(provider.handleRequestyCallback).toHaveBeenCalledWith("c1", null)
	})

	it("ignores a Requesty callback carrying no code", async () => {
		const provider = makeProvider()
		hoisted.visibleInstance = provider

		await handleUri(uri("/requesty", "baseUrl=https://api.example"))

		expect(provider.handleRequestyCallback).not.toHaveBeenCalled()
	})

	it("ESCAPES `+` so a base64 code survives URLSearchParams' space decoding", async () => {
		const provider = makeProvider()
		hoisted.visibleInstance = provider

		await handleUri(uri("/openrouter", "code=a+b/c="))

		expect(provider.handleOpenRouterCallback).toHaveBeenCalledWith("a+b/c=")
	})

	it("ignores an unknown path", async () => {
		const provider = makeProvider()
		hoisted.visibleInstance = provider

		await handleUri(uri("/something-else", "code=abc"))

		expect(provider.handleOpenRouterCallback).not.toHaveBeenCalled()
		expect(provider.handleRequestyCallback).not.toHaveBeenCalled()
	})
})

describe("handleNewTask", () => {
	it("uses a supplied prompt without asking", async () => {
		const provider = { createManagedTask: vi.fn(async () => undefined) }
		hoisted.instance = provider

		await handleNewTask({ prompt: "refactor this" })

		expect(hoisted.showInputBox).not.toHaveBeenCalled()
		expect(provider.createManagedTask).toHaveBeenCalledWith(undefined, "refactor this", undefined)
	})

	it("prompts when invoked with no params at all", async () => {
		const provider = { createManagedTask: vi.fn(async () => undefined) }
		hoisted.instance = provider
		hoisted.showInputBox.mockResolvedValueOnce("typed prompt")

		await handleNewTask(undefined)

		expect(provider.createManagedTask).toHaveBeenCalledWith(undefined, "typed prompt", undefined)
	})

	it("focuses the sidebar and starts NOTHING when the prompt is cancelled", async () => {
		const provider = { createManagedTask: vi.fn(async () => undefined) }
		hoisted.instance = provider
		hoisted.showInputBox.mockResolvedValueOnce(undefined)

		await handleNewTask(null)

		expect(hoisted.executeCommand).toHaveBeenCalledWith("shofer.SidebarProvider.focus")
		expect(provider.createManagedTask).not.toHaveBeenCalled()
	})

	it("does not throw when there is no provider to create the task on", async () => {
		await expect(handleNewTask({ prompt: "go" })).resolves.toBeUndefined()
	})
})

describe("registerCodeActions", () => {
	it("registers the four code actions against the extension's subscriptions", () => {
		const subscriptions: unknown[] = []

		registerCodeActions({ subscriptions } as unknown as import("vscode").ExtensionContext)

		expect([...hoisted.registered.keys()]).toEqual([
			"shofer.explainCode",
			"shofer.fixCode",
			"shofer.improveCode",
			"shofer.addToContext",
		])
		expect(subscriptions).toHaveLength(4)
	})

	it("forwards a code-action invocation's positional args, stringifying the line numbers", async () => {
		registerCodeActions(context)

		await hoisted.registered.get("shofer.fixCode")!("/w/a.ts", "const a = 1", 3, 7, [{ message: "unused" }])

		expect(hoisted.handleCodeAction).toHaveBeenCalledWith("fixCode", "FIX", {
			filePath: "/w/a.ts",
			selectedText: "const a = 1",
			startLine: "3",
			endLine: "7",
			diagnostics: [{ message: "unused" }],
		})
	})

	it("falls back to the ACTIVE EDITOR when invoked from the command palette", async () => {
		hoisted.editorContext = {
			filePath: "/w/b.ts",
			selectedText: "x",
			startLine: 1,
			endLine: 1,
			diagnostics: undefined,
		}
		registerCodeActions(context)

		await hoisted.registered.get("shofer.explainCode")!()

		expect(hoisted.handleCodeAction).toHaveBeenCalledWith("explainCode", "EXPLAIN", {
			filePath: "/w/b.ts",
			selectedText: "x",
			startLine: "1",
			endLine: "1",
		})
	})

	it("does nothing at all when there is no editor context to act on", async () => {
		registerCodeActions(context)

		await hoisted.registered.get("shofer.improveCode")!()

		expect(hoisted.handleCodeAction).not.toHaveBeenCalled()
	})

	it("omits undefined line numbers rather than sending the string 'undefined'", async () => {
		hoisted.editorContext = { filePath: "/w/c.ts", selectedText: "y" }
		registerCodeActions(context)

		await hoisted.registered.get("shofer.addToContext")!()

		expect(hoisted.handleCodeAction).toHaveBeenCalledWith("addToContext", "ADD_TO_CONTEXT", {
			filePath: "/w/c.ts",
			selectedText: "y",
		})
	})
})

describe("registerTerminalActions", () => {
	it("registers the three terminal actions", () => {
		const subscriptions: unknown[] = []

		registerTerminalActions({ subscriptions } as unknown as import("vscode").ExtensionContext)

		expect([...hoisted.registered.keys()]).toEqual([
			"shofer.terminalAddToContext",
			"shofer.terminalFixCommand",
			"shofer.terminalExplainCommand",
		])
		expect(subscriptions).toHaveLength(3)
	})

	it("uses the terminal SELECTION when there is one, without scraping the buffer", async () => {
		registerTerminalActions(context)

		await hoisted.registered.get("shofer.terminalFixCommand")!({ selection: "npm run build" })

		expect(Terminal.getTerminalContents).not.toHaveBeenCalled()
		expect(hoisted.handleTerminalAction).toHaveBeenCalledWith("terminalFixCommand", "TERMINAL_FIX", {
			terminalContent: "npm run build",
		})
	})

	it("scrapes the WHOLE buffer for 'add to context' and the LAST command otherwise", async () => {
		hoisted.terminalContents = "scraped"
		registerTerminalActions(context)

		await hoisted.registered.get("shofer.terminalAddToContext")!({})
		expect(Terminal.getTerminalContents).toHaveBeenLastCalledWith(-1)

		await hoisted.registered.get("shofer.terminalExplainCommand")!({})
		expect(Terminal.getTerminalContents).toHaveBeenLastCalledWith(1)
	})

	it("treats an EMPTY selection as absent and falls back to scraping", async () => {
		hoisted.terminalContents = "scraped"
		registerTerminalActions(context)

		await hoisted.registered.get("shofer.terminalFixCommand")!({ selection: "" })

		expect(Terminal.getTerminalContents).toHaveBeenCalled()
		expect(hoisted.handleTerminalAction).toHaveBeenCalledWith("terminalFixCommand", "TERMINAL_FIX", {
			terminalContent: "scraped",
		})
	})

	it("WARNS instead of sending an empty prompt when nothing could be captured", async () => {
		hoisted.terminalContents = ""
		registerTerminalActions(context)

		await hoisted.registered.get("shofer.terminalExplainCommand")!(undefined)

		expect(hoisted.notifier.warn).toHaveBeenCalled()
		expect(hoisted.handleTerminalAction).not.toHaveBeenCalled()
	})
})
