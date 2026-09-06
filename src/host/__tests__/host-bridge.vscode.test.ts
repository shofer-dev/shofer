// npx vitest src/host/__tests__/host-bridge.vscode.test.ts

/**
 * The VS Code side of the host bridge — the ONE adapter that is allowed to touch
 * `vscode.*` on core's behalf, so every translation it performs is a contract
 * core depends on and cannot see. The ones pinned here:
 *
 *  - **`config.get` reads ContextProxy FIRST for a migrated `shofer.*` key** and
 *    falls back to VS Code config only when the proxy has nothing (or does not
 *    exist yet). This is what makes the Typed Settings Rule hold for core, which
 *    never imports `ContextProxy`.
 *  - **Line/column translation.** The LSP surface is 0-based in VS Code and
 *    1-based in `HostBridge`; an off-by-one here silently points every rename and
 *    every diagnostic one line wrong.
 *  - **Optional editor APIs degrade to a no-op disposable** rather than throwing,
 *    because the shell-integration events do not exist on older builds.
 *  - **`readTerminalContents` restores the user's clipboard even when it throws**
 *    — it borrows the clipboard, it does not own it.
 */

const hoisted = vi.hoisted(() => ({
	proxyValues: {} as Record<string, unknown>,
	proxyThrows: false,
	configGet: vi.fn((_key: string, def: unknown) => def),
	executeCommand: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	findFiles: vi.fn(async (..._args: unknown[]): Promise<Array<{ fsPath: string }>> => [{ fsPath: "/w/a.ts" }]),
	diagnostics: [] as unknown[],
	clipboardText: [] as string[],
	writeText: vi.fn(async () => undefined),
	openTextDocument: vi.fn(async () => ({ lineAt: () => ({ text: "  const a = 1  " }) })),
	showTextDocument: vi.fn(async () => undefined),
	applyEdit: vi.fn(async (..._args: unknown[]): Promise<boolean> => true),
	onDidStartTerminalShellExecution: undefined as unknown,
	onDidEndTerminalShellExecution: undefined as unknown,
	openExternal: vi.fn(async () => true),
	tabGroups: { all: [] as unknown[] },
	visibleTextEditors: [] as unknown[],
	activeTextEditor: undefined as unknown,
	workspaceFolders: undefined as unknown,
	diagnosticsToProblemsString: vi.fn(async (..._args: unknown[]): Promise<string> => ""),
	openFile: vi.fn(async () => undefined),
}))

vi.mock("vscode", () => {
	class Position {
		constructor(
			public line: number,
			public character: number,
		) {}
	}
	class Range {
		constructor(
			public startLine: number,
			public startColumn: number,
			public endLine: number,
			public endColumn: number,
		) {}
	}
	class WorkspaceEdit {
		replaced: unknown[] = []
		replace(uri: unknown, range: unknown, text: string) {
			this.replaced.push({ uri, range, text })
		}
	}
	class TabInputText {
		constructor(public uri: { fsPath: string }) {}
	}
	return {
		Position,
		Range,
		WorkspaceEdit,
		TabInputText,
		Uri: {
			file: (p: string) => ({ fsPath: p, path: p, with: (o: object) => ({ fsPath: p, ...o }) }),
			parse: (p: string) => ({ fsPath: p, path: p, with: (o: object) => ({ parsed: p, ...o }) }),
		},
		RelativePattern: class {
			constructor(
				public base: unknown,
				public pattern: string,
			) {}
		},
		DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
		SymbolKind: { 4: "Class", 11: "Function" },
		window: {
			showInformationMessage: vi.fn(async () => "Info"),
			showWarningMessage: vi.fn(async () => "Warn"),
			showErrorMessage: vi.fn(async () => "Err"),
			showTextDocument: hoisted.showTextDocument,
			onDidCloseTerminal: vi.fn(() => ({ dispose: () => {} })),
			get onDidStartTerminalShellExecution() {
				return hoisted.onDidStartTerminalShellExecution
			},
			get onDidEndTerminalShellExecution() {
				return hoisted.onDidEndTerminalShellExecution
			},
			get activeTextEditor() {
				return hoisted.activeTextEditor
			},
			get visibleTextEditors() {
				return hoisted.visibleTextEditors
			},
			get tabGroups() {
				return hoisted.tabGroups
			},
		},
		workspace: {
			getConfiguration: () => ({ get: hoisted.configGet }),
			findFiles: hoisted.findFiles,
			openTextDocument: hoisted.openTextDocument,
			applyEdit: hoisted.applyEdit,
			createFileSystemWatcher: () => ({
				onDidCreate: (h: (u: { fsPath: string }) => void) => h({ fsPath: "/w/new.ts" }),
				onDidChange: (h: (u: { fsPath: string }) => void) => h({ fsPath: "/w/changed.ts" }),
				onDidDelete: (h: (u: { fsPath: string }) => void) => h({ fsPath: "/w/gone.ts" }),
				dispose: vi.fn(),
			}),
			get workspaceFolders() {
				return hoisted.workspaceFolders
			},
			getWorkspaceFolder: (uri: { fsPath: string }) =>
				uri.fsPath.startsWith("/w") ? { uri: { fsPath: "/w" } } : undefined,
			onDidChangeWorkspaceFolders: (cb: () => void) => {
				cb()
				return { dispose: () => {} }
			},
		},
		languages: { getDiagnostics: () => hoisted.diagnostics },
		commands: { executeCommand: hoisted.executeCommand },
		env: {
			language: "en",
			appRoot: "/vscode",
			machineId: "machine-1",
			openExternal: hoisted.openExternal,
			clipboard: {
				readText: async () => hoisted.clipboardText.shift() ?? "",
				writeText: hoisted.writeText,
			},
		},
	}
})

vi.mock("../../core/config/ContextProxy", () => ({
	ContextProxy: {
		get instance() {
			if (hoisted.proxyThrows) throw new Error("ContextProxy not initialized")
			return { getValue: (key: string) => hoisted.proxyValues[key] }
		},
	},
}))

vi.mock("../../integrations/editor/DiffViewProvider", () => ({
	DiffViewProvider: class {
		constructor(
			public cwd: string,
			public task: unknown,
		) {}
	},
	DIFF_VIEW_URI_SCHEME: "shofer-diff",
}))

vi.mock("../../integrations/terminal/Terminal", () => ({
	Terminal: class {
		constructor(
			public id: number,
			public existing: unknown,
			public cwd: string,
		) {}
	},
}))

vi.mock("../../integrations/terminal/ShellIntegrationManager", () => ({
	ShellIntegrationManager: { clear: vi.fn(), zshCleanupTmpDir: vi.fn() },
}))

vi.mock("../../integrations/misc/open-file", () => ({ openFile: hoisted.openFile }))
vi.mock("../../integrations/diagnostics", () => ({
	diagnosticsToProblemsString: hoisted.diagnosticsToProblemsString,
}))
vi.mock("../../utils/globalContext", () => ({ ensureSettingsDirectoryExists: vi.fn(async () => "/settings") }))
vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	effectiveModes: (persisted: unknown) => persisted ?? [],
}))

import { ShellIntegrationManager } from "../../integrations/terminal/ShellIntegrationManager"
import { createVsCodeHost } from "../host-bridge"

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.proxyValues = {}
	hoisted.proxyThrows = false
	hoisted.diagnostics = []
	hoisted.clipboardText = []
	hoisted.tabGroups = { all: [] }
	hoisted.visibleTextEditors = []
	hoisted.activeTextEditor = undefined
	hoisted.workspaceFolders = undefined
	hoisted.onDidStartTerminalShellExecution = undefined
	hoisted.onDidEndTerminalShellExecution = undefined
	hoisted.configGet.mockImplementation((_key: string, def: unknown) => def)
})

describe("the notifier", () => {
	it("maps each level onto its VS Code message kind", async () => {
		const vscode = await import("vscode")
		const host = createVsCodeHost()

		host.notifier.info("i")
		host.notifier.warn("w")
		host.notifier.error("e")

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("i")
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("w")
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("e")
	})

	it("showChoice routes by SEVERITY and forwards the modal/detail options", async () => {
		const vscode = await import("vscode")
		const host = createVsCodeHost()

		await host.notifier.showChoice("pick", ["A", "B"], { severity: "error", modal: true, detail: "why" })

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("pick", { modal: true, detail: "why" }, "A", "B")
	})

	it("showChoice defaults to the information kind", async () => {
		const vscode = await import("vscode")
		const host = createVsCodeHost()

		await host.notifier.showChoice("pick", ["A"])

		expect(vscode.window.showInformationMessage).toHaveBeenCalled()
	})

	it("showChoice uses the warning kind for a warn severity", async () => {
		const vscode = await import("vscode")
		const host = createVsCodeHost()

		await host.notifier.showChoice("pick", ["A"], { severity: "warn" })

		expect(vscode.window.showWarningMessage).toHaveBeenCalled()
	})
})

describe("config resolution", () => {
	it("prefers ContextProxy for a MIGRATED shofer key", () => {
		hoisted.proxyValues.apiRequestTimeout = 900
		const host = createVsCodeHost()

		expect(host.config.get("shofer", "apiRequestTimeout", 600)).toBe(900)
		expect(hoisted.configGet).not.toHaveBeenCalled()
	})

	it("flattens the dotted debugProxy keys onto their settings names", () => {
		hoisted.proxyValues.debugProxyEnabled = true
		const host = createVsCodeHost()

		expect(host.config.get("shofer", "debugProxy.enabled", false)).toBe(true)
	})

	it("falls back to VS Code config when the proxy has no value", () => {
		hoisted.configGet.mockReturnValue(42)
		const host = createVsCodeHost()

		expect(host.config.get("shofer", "apiRequestTimeout", 600)).toBe(42)
	})

	it("falls back when ContextProxy is not initialized at all", () => {
		hoisted.proxyThrows = true
		hoisted.configGet.mockReturnValue(7)
		const host = createVsCodeHost()

		expect(host.config.get("shofer", "apiRequestTimeout", 600)).toBe(7)
	})

	it("never consults the proxy for a NON-shofer section", () => {
		hoisted.proxyValues.apiRequestTimeout = 900
		hoisted.configGet.mockReturnValue(false)
		const host = createVsCodeHost()

		expect(host.config.get("terminal.integrated", "inheritEnv", true)).toBe(false)
	})

	it("never consults the proxy for an UNMIGRATED shofer key", () => {
		hoisted.configGet.mockReturnValue("from-vscode")
		const host = createVsCodeHost()

		expect(host.config.get("shofer", "someKeyNobodyMigrated", "d")).toBe("from-vscode")
	})
})

describe("the filesystem adapter", () => {
	it("reports a missing path as not existing rather than throwing", async () => {
		const host = createVsCodeHost()

		await expect(host.fs.exists("/definitely/not/here")).resolves.toBe(false)
	})

	it("findFiles builds a brace-grouped exclude glob and returns fsPaths", async () => {
		const host = createVsCodeHost()

		const files = await host.fs.findFiles("**/*.ts", {
			cwd: "/w",
			exclude: ["node_modules", "dist"],
			maxResults: 5,
		})

		expect(files).toEqual(["/w/a.ts"])
		expect(hoisted.findFiles.mock.calls[0][1]).toBe("{node_modules,dist}")
		expect(hoisted.findFiles.mock.calls[0][2]).toBe(5)
	})

	it("passes NO exclude glob when the caller supplies an empty list", async () => {
		const host = createVsCodeHost()

		await host.fs.findFiles("**/*.ts", { cwd: "/w", exclude: [] })

		expect(hoisted.findFiles.mock.calls[0][1]).toBeUndefined()
	})
})

describe("env identity", () => {
	it("reports the editor's language, appRoot and machine id live", () => {
		const host = createVsCodeHost()

		expect(host.env.language).toBe("en")
		expect(host.env.appRoot).toBe("/vscode")
		expect(host.env.machineId).toBe("machine-1")
	})

	it("carries the build identity the ESBuild PKG_* overrides feed", () => {
		const host = createVsCodeHost()

		expect(host.env.appInfo.name).toBeTypeOf("string")
		expect(host.env.appInfo.outputChannel).toBeTypeOf("string")
	})
})

describe("the LSP adapter translates coordinates", () => {
	it("reports diagnostics ONE-BASED, mapping every severity", async () => {
		hoisted.diagnostics = [
			[
				{ fsPath: "/w/a.ts" },
				[
					{ range: { start: { line: 0, character: 4 } }, severity: 0, message: "err", source: "ts" },
					{ range: { start: { line: 9, character: 0 } }, severity: 1, message: "warn" },
					{ range: { start: { line: 1, character: 0 } }, severity: 2, message: "info" },
					{ range: { start: { line: 2, character: 0 } }, severity: 3, message: "hint" },
					{ range: { start: { line: 3, character: 0 } }, severity: 99, message: "unknown" },
				],
			],
		]
		const host = createVsCodeHost()

		const diagnostics = await host.lsp.getDiagnostics()

		expect(diagnostics[0]).toEqual({
			filePath: "/w/a.ts",
			line: 1,
			column: 5,
			severity: "error",
			message: "err",
			source: "ts",
		})
		expect(diagnostics.map((d) => d.severity)).toEqual(["error", "warning", "info", "hint", "info"])
	})

	it("findReferences converts 1-based input to a 0-based Position and back", async () => {
		hoisted.executeCommand.mockResolvedValueOnce([
			{ uri: { fsPath: "/w/b.ts" }, range: { start: { line: 4, character: 2 } } },
		])
		const host = createVsCodeHost()

		const result = await host.lsp.findReferences("/w/a.ts", 3, 5, 10)

		const [, , position] = hoisted.executeCommand.mock.calls[0] as [
			string,
			unknown,
			{ line: number; character: number },
		]
		expect(position).toMatchObject({ line: 2, character: 4 })
		expect(result.references[0]).toMatchObject({ filePath: "/w/b.ts", line: 5, column: 3, preview: "const a = 1" })
	})

	it("findReferences reports the TOTAL even when it returns only maxResults", async () => {
		hoisted.executeCommand.mockResolvedValueOnce(
			Array.from({ length: 5 }, () => ({
				uri: { fsPath: "/w/b.ts" },
				range: { start: { line: 0, character: 0 } },
			})),
		)
		const host = createVsCodeHost()

		const result = await host.lsp.findReferences("/w/a.ts", 1, 1, 2)

		expect(result.total).toBe(5)
		expect(result.references).toHaveLength(2)
	})

	it("findReferences substitutes a placeholder when a reference's file cannot be read", async () => {
		hoisted.executeCommand.mockResolvedValueOnce([
			{ uri: { fsPath: "/w/b.ts" }, range: { start: { line: 0, character: 0 } } },
		])
		hoisted.openTextDocument
			.mockResolvedValueOnce({ lineAt: () => ({ text: "" }) })
			.mockRejectedValueOnce(new Error("gone"))
		const host = createVsCodeHost()

		const result = await host.lsp.findReferences("/w/a.ts", 1, 1, 10)

		expect(result.references[0].preview).toBe("(unable to read)")
	})

	it("findReferences answers empty when the provider returns nothing", async () => {
		hoisted.executeCommand.mockResolvedValueOnce(undefined)
		const host = createVsCodeHost()

		await expect(host.lsp.findReferences("/w/a.ts", 1, 1, 10)).resolves.toEqual({ total: 0, references: [] })
	})

	it("workspaceSymbols names the symbol KIND rather than leaking its enum value", async () => {
		hoisted.executeCommand.mockResolvedValueOnce([
			{ name: "Foo", kind: 4, location: { uri: { fsPath: "/w/a.ts" }, range: { start: { line: 0 } } } },
			{ name: "Bar", kind: 999, location: { uri: { fsPath: "/w/a.ts" }, range: { start: { line: 2 } } } },
		])
		const host = createVsCodeHost()

		const symbols = await host.lsp.workspaceSymbols("Foo")

		expect(symbols).toEqual([
			{ name: "Foo", kind: "Class", filePath: "/w/a.ts", line: 1 },
			{ name: "Bar", kind: "Unknown", filePath: "/w/a.ts", line: 3 },
		])
	})

	it("workspaceSymbols answers empty when the provider returns nothing", async () => {
		hoisted.executeCommand.mockResolvedValueOnce(undefined)
		const host = createVsCodeHost()

		await expect(host.lsp.workspaceSymbols("x")).resolves.toEqual([])
	})

	it("computeRename returns NULL — never an empty edit — when no rename is possible", async () => {
		hoisted.executeCommand.mockResolvedValueOnce(undefined)
		const host = createVsCodeHost()

		await expect(host.lsp.computeRename("/w/a.ts", 1, 1, "newName")).resolves.toBeNull()
	})

	it("computeRename flattens the workspace edit into per-file 0-based edits", async () => {
		hoisted.executeCommand.mockResolvedValueOnce({
			entries: () => [
				[
					{ fsPath: "/w/a.ts" },
					[{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: "x" }],
				],
			],
		})
		const host = createVsCodeHost()

		const edit = await host.lsp.computeRename("/w/a.ts", 2, 3, "x")

		expect(edit).toEqual({
			changes: [
				{
					filePath: "/w/a.ts",
					edits: [{ startLine: 1, startColumn: 2, endLine: 1, endColumn: 5, newText: "x" }],
				},
			],
		})
	})

	it("applyWorkspaceEdit replays every edit and reports what VS Code answered", async () => {
		const host = createVsCodeHost()

		const applied = await host.lsp.applyWorkspaceEdit({
			changes: [
				{
					filePath: "/w/a.ts",
					edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 3, newText: "abc" }],
				},
			],
		})

		expect(applied).toBe(true)
		const [edit] = hoisted.applyEdit.mock.calls[0] as [{ replaced: unknown[] }]
		expect(edit.replaced).toHaveLength(1)
	})
})

describe("the workspace adapter", () => {
	it("reports the workspace roots, and an empty list with no folders open", () => {
		const host = createVsCodeHost()
		expect(host.workspace.workspaceRoots()).toEqual([])

		hoisted.workspaceFolders = [{ uri: { fsPath: "/w" } }, { uri: { fsPath: "/other" } }]
		expect(host.workspace.workspaceRoots()).toEqual(["/w", "/other"])
	})

	it("reports the active editor's file, or undefined", () => {
		const host = createVsCodeHost()
		expect(host.workspace.activeEditorFile()).toBeUndefined()

		hoisted.activeTextEditor = { document: { uri: { fsPath: "/w/a.ts" } } }
		expect(host.workspace.activeEditorFile()).toBe("/w/a.ts")
	})

	it("visibleFiles skips an editor with no document path", () => {
		hoisted.visibleTextEditors = [{ document: { uri: { fsPath: "/w/a.ts" } } }, { document: {} }, {}]
		const host = createVsCodeHost()

		expect(host.workspace.visibleFiles()).toEqual(["/w/a.ts"])
	})

	it("openTabs counts only TEXT tabs — a diff or a webview tab has no file", async () => {
		const vscode = (await import("vscode")) as unknown as {
			TabInputText: new (uri: { fsPath: string }) => unknown
		}
		hoisted.tabGroups = {
			all: [
				{
					tabs: [{ input: new vscode.TabInputText({ fsPath: "/w/a.ts" }) }, { input: { notText: true } }],
				},
			],
		}
		const host = createVsCodeHost()

		expect(host.workspace.openTabs()).toEqual(["/w/a.ts"])
	})

	it("workspaceFolderFor answers the containing root, or undefined", () => {
		const host = createVsCodeHost()

		expect(host.workspace.workspaceFolderFor("/w/a.ts")).toBe("/w")
		expect(host.workspace.workspaceFolderFor("/elsewhere/a.ts")).toBeUndefined()
	})

	it("openFolder defaults to REUSING the window", async () => {
		const host = createVsCodeHost()

		await host.workspace.openFolder("/w")
		expect(hoisted.executeCommand).toHaveBeenCalledWith("vscode.openFolder", expect.anything(), {
			forceNewWindow: false,
		})

		await host.workspace.openFolder("/w", { newWindow: true })
		expect(hoisted.executeCommand).toHaveBeenLastCalledWith("vscode.openFolder", expect.anything(), {
			forceNewWindow: true,
		})
	})

	it("executeCommand forwards its arguments", async () => {
		const host = createVsCodeHost()

		await host.workspace.executeCommand("some.command", 1, "two")

		expect(hoisted.executeCommand).toHaveBeenCalledWith("some.command", 1, "two")
	})

	it("onDidChangeWorkspaceFolders adapts the event to a bare handler", () => {
		const host = createVsCodeHost()
		const handler = vi.fn()

		const disposable = host.workspace.onDidChangeWorkspaceFolders(handler)

		expect(handler).toHaveBeenCalled()
		expect(disposable.dispose).toBeTypeOf("function")
	})
})

describe("the watcher threads absolute paths", () => {
	it("hands each handler the changed file's fsPath", () => {
		const host = createVsCodeHost()
		const watcher = host.watcher.watch("/w", "**/*.ts")
		const created = vi.fn()
		const changed = vi.fn()
		const deleted = vi.fn()

		watcher.onCreate(created)
		watcher.onChange(changed)
		watcher.onDelete(deleted)
		watcher.dispose()

		expect(created).toHaveBeenCalledWith("/w/new.ts")
		expect(changed).toHaveBeenCalledWith("/w/changed.ts")
		expect(deleted).toHaveBeenCalledWith("/w/gone.ts")
	})
})

describe("the terminals adapter", () => {
	it("degrades to a NO-OP disposable when the shell-integration events do not exist", () => {
		const host = createVsCodeHost()

		const started = host.terminals.onDidStartShellExecution(vi.fn())
		const ended = host.terminals.onDidEndShellExecution(vi.fn())

		expect(() => started.dispose()).not.toThrow()
		expect(() => ended.dispose()).not.toThrow()
	})

	it("wraps a shell execution so core never sees a vscode type", () => {
		hoisted.onDidStartTerminalShellExecution = (cb: (e: unknown) => void) => {
			cb({ execution: { read: () => "output", commandLine: { value: "npm test" } }, terminal: { id: 1 } })
			return { dispose: () => {} }
		}
		const host = createVsCodeHost()
		const handler = vi.fn()

		host.terminals.onDidStartShellExecution(handler)

		const { execution } = handler.mock.calls[0][0]
		expect(execution.read()).toBe("output")
		expect(execution.commandLine).toBe("npm test")
	})

	it("passes an ABSENT execution through on the end event", () => {
		hoisted.onDidEndTerminalShellExecution = (cb: (e: unknown) => void) => {
			cb({ execution: undefined, terminal: { id: 1 }, exitCode: 1 })
			return { dispose: () => {} }
		}
		const host = createVsCodeHost()
		const handler = vi.fn()

		host.terminals.onDidEndShellExecution(handler)

		expect(handler).toHaveBeenCalledWith({ execution: undefined, terminal: { id: 1 }, exitCode: 1 })
	})

	it("createTerminal builds the adapter's own Terminal", () => {
		const host = createVsCodeHost()

		const terminal = host.terminals.createTerminal(7, "/w") as unknown as { id: number; cwd: string }

		expect(terminal).toMatchObject({ id: 7, cwd: "/w" })
	})

	it("cleanupShellIntegration clears EVERYTHING when given no id", () => {
		const host = createVsCodeHost()

		host.terminals.cleanupShellIntegration()
		expect(ShellIntegrationManager.clear).toHaveBeenCalled()

		host.terminals.cleanupShellIntegration(7)
		expect(ShellIntegrationManager.zshCleanupTmpDir).toHaveBeenCalledWith(7)
	})
})

describe("the editor adapter", () => {
	it("opens an external url through the editor's own handler", async () => {
		const host = createVsCodeHost()

		await host.external.openExternal("https://example.com")

		expect(hoisted.openExternal).toHaveBeenCalled()
	})

	it("revealInExplorer and openFile route to their commands", async () => {
		const host = createVsCodeHost()

		await host.editor.revealInExplorer("/w/a.ts")
		expect(hoisted.executeCommand).toHaveBeenCalledWith("revealInExplorer", expect.anything())

		await host.editor.openFile("/w/a.ts")
		expect(hoisted.openFile).toHaveBeenCalledWith("/w/a.ts")
	})

	it("focusPanel picks the right workbench view per panel", async () => {
		const host = createVsCodeHost()

		await host.editor.focusPanel("problems")
		expect(hoisted.executeCommand).toHaveBeenLastCalledWith("workbench.actions.view.problems")

		await host.editor.focusPanel("terminal")
		expect(hoisted.executeCommand).toHaveBeenLastCalledWith("workbench.action.terminal.focus")
	})

	it("showMultiFileDiff base64-encodes both sides into the virtual-document query", async () => {
		const host = createVsCodeHost()

		await host.editor.showMultiFileDiff("Changes", [
			{ paths: { absolute: "/w/a.ts", relative: "a.ts" }, content: { before: "old", after: "new" } },
		])

		const [, title, changes] = hoisted.executeCommand.mock.calls[0] as [string, string, unknown[][]]
		expect(title).toBe("Changes")
		expect((changes[0][1] as { query: string }).query).toBe(Buffer.from("old").toString("base64"))
		expect((changes[0][2] as { query: string }).query).toBe(Buffer.from("new").toString("base64"))
	})

	it("showMultiFileDiff treats missing content as empty rather than crashing", async () => {
		const host = createVsCodeHost()

		await host.editor.showMultiFileDiff("Changes", [
			{ paths: { absolute: "/w/a.ts", relative: "a.ts" }, content: {} },
		])

		const [, , changes] = hoisted.executeCommand.mock.calls[0] as [string, string, unknown[][]]
		expect((changes[0][1] as { query: string }).query).toBe("")
	})

	it("readTerminalContents RESTORES the clipboard it borrowed", async () => {
		hoisted.clipboardText = ["user's own text", "$ npm test\nfailing"]
		const host = createVsCodeHost()

		await host.editor.readTerminalContents()

		expect(hoisted.writeText).toHaveBeenCalledWith("user's own text")
	})

	it("readTerminalContents returns EMPTY when the clipboard did not change", async () => {
		hoisted.clipboardText = ["unchanged", "unchanged"]
		const host = createVsCodeHost()

		await expect(host.editor.readTerminalContents()).resolves.toBe("")
	})

	it("readTerminalContents restores the clipboard even when the copy throws", async () => {
		hoisted.clipboardText = ["user's own text"]
		hoisted.executeCommand.mockRejectedValueOnce(new Error("no terminal"))
		const host = createVsCodeHost()

		await expect(host.editor.readTerminalContents()).rejects.toThrow("no terminal")
		expect(hoisted.writeText).toHaveBeenCalledWith("user's own text")
	})

	it("getWorkspaceProblems substitutes a human sentence for an empty report", async () => {
		hoisted.diagnosticsToProblemsString.mockResolvedValueOnce("")
		const host = createVsCodeHost()

		await expect(host.editor.getWorkspaceProblems("/w", true, 10)).resolves.toBe("No errors or warnings detected.")
	})

	it("getWorkspaceProblems passes the report through when there is one", async () => {
		hoisted.diagnosticsToProblemsString.mockResolvedValueOnce("a.ts:1 error")
		const host = createVsCodeHost()

		await expect(host.editor.getWorkspaceProblems("/w", false, 3)).resolves.toBe("a.ts:1 error")
	})
})

describe("mode overrides", () => {
	it("are EMPTY without an extension context — a bare host has no user state", async () => {
		const host = createVsCodeHost()

		await expect(host.state.readModeOverrides()).resolves.toEqual({})
	})

	it("re-derive the plugin half so the prompt's MODES section is right on the first read", async () => {
		const globalState = new Map<string, unknown>([
			["customModes", [{ slug: "custom" }]],
			["customModePrompts", { code: { roleDefinition: "r" } }],
		])
		const host = createVsCodeHost({
			globalState: { get: (k: string) => globalState.get(k) },
		} as never)

		await expect(host.state.readModeOverrides()).resolves.toEqual({
			customModes: [{ slug: "custom" }],
			customModePrompts: { code: { roleDefinition: "r" } },
		})
	})

	it("leave customModePrompts undefined when nothing was persisted", async () => {
		const host = createVsCodeHost({ globalState: { get: () => undefined } } as never)

		await expect(host.state.readModeOverrides()).resolves.toMatchObject({ customModePrompts: undefined })
	})
})

describe("createDiffView", () => {
	it("builds the adapter's DiffViewProvider bound to the task's cwd", () => {
		const host = createVsCodeHost()

		const view = host.createDiffView("/w", { taskId: "t" } as never) as unknown as { cwd: string }

		expect(view.cwd).toBe("/w")
	})
})
