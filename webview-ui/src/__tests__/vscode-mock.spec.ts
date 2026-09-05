// npx vitest src/__tests__/vscode-mock.spec.ts
//
// The webview suite resolves the bare `vscode` specifier to the double in
// `src/__mocks__/vscode.ts` (the alias is in `vitest.config.ts`). Specs that
// exercise shared modules lean on that double's SHAPE — a missing member shows
// up as an unrelated "not a function" three files away — so the surface is
// pinned here.

import vscodeDefault, {
	CodeAction,
	CodeActionKind,
	DiagnosticSeverity,
	Disposable,
	EventEmitter,
	FileType,
	OverviewRulerLane,
	Position,
	Range,
	Selection,
	ThemeIcon,
	TreeItem,
	TreeItemCollapsibleState,
	Uri,
	commands,
	env,
	extensions,
	languages,
	window,
	workspace,
} from "../__mocks__/vscode"

// The alias (`vitest.config.ts`) is what makes the bare specifier resolve here;
// the module is imported by PATH above so the double type-checks against its own
// signatures rather than against `@types/vscode`.
import * as viaBareSpecifier from "vscode"

describe("the vscode test double", () => {
	it("is what the bare `vscode` specifier resolves to", () => {
		expect((viaBareSpecifier as unknown as { workspace: unknown }).workspace).toBe(workspace)
	})

	it("exposes the same namespaces from the default export and as named exports", () => {
		expect(vscodeDefault.workspace).toBe(workspace)
		expect(vscodeDefault.window).toBe(window)
		expect(vscodeDefault.commands).toBe(commands)
		expect(vscodeDefault.languages).toBe(languages)
		expect(vscodeDefault.extensions).toBe(extensions)
		expect(vscodeDefault.env).toBe(env)
	})

	it("gives workspace an empty folder set and disposable watchers", async () => {
		expect(workspace.workspaceFolders).toEqual([])
		expect(workspace.getWorkspaceFolder()).toBeNull()
		expect(workspace.onDidChangeWorkspaceFolders()).toBe(Disposable)

		const watcher = workspace.createFileSystemWatcher()
		expect(watcher.onDidCreate()).toBe(Disposable)
		expect(watcher.onDidChange()).toBe(Disposable)
		expect(watcher.onDidDelete()).toBe(Disposable)
		expect(() => watcher.dispose()).not.toThrow()
	})

	it("returns the caller's default from getConfiguration", () => {
		expect(workspace.getConfiguration().get("anything", "fallback")).toBe("fallback")
	})

	it("stubs the workspace filesystem with empty, resolved results", async () => {
		await expect(workspace.fs.readFile()).resolves.toEqual(new Uint8Array())
		await expect(workspace.fs.writeFile()).resolves.toBeUndefined()
		await expect(workspace.fs.stat()).resolves.toEqual({ type: 1, ctime: 0, mtime: 0, size: 0 })
	})

	it("stubs the window notifications, output channel and terminal", async () => {
		expect(window.activeTextEditor).toBeNull()
		expect(window.onDidChangeActiveTextEditor()).toBe(Disposable)
		await expect(window.showErrorMessage()).resolves.toBeUndefined()
		await expect(window.showWarningMessage()).resolves.toBeUndefined()
		await expect(window.showInformationMessage()).resolves.toBeUndefined()

		const channel = window.createOutputChannel()
		for (const method of ["appendLine", "append", "clear", "show", "dispose"] as const) {
			// The double's members take no arguments; a real host's take one.
			expect(() => (channel[method] as (text?: string) => void)("x")).not.toThrow()
		}

		const terminal = window.createTerminal()
		expect(terminal.name).toBe("Shofer")
		await expect(terminal.processId).resolves.toBe(123)
		for (const method of ["dispose", "hide", "show", "sendText"] as const) {
			expect(() => (terminal[method] as (text?: string) => void)("x")).not.toThrow()
		}
		expect(window.onDidCloseTerminal()).toBe(Disposable)
		expect(() => window.createTextEditorDecorationType().dispose()).not.toThrow()
	})

	it("stubs command registration and execution", async () => {
		expect(commands.registerCommand()).toBe(Disposable)
		await expect(commands.executeCommand()).resolves.toBeUndefined()
	})

	it("stubs the diagnostic collection", () => {
		const collection = languages.createDiagnosticCollection()
		for (const method of ["set", "delete", "clear", "dispose"] as const) {
			expect(() => collection[method]()).not.toThrow()
		}
	})

	it("reports no extensions and a stubbed env", async () => {
		expect(extensions.getExtension()).toBeNull()
		await expect(env.openExternal()).resolves.toBeUndefined()
		expect(env.appRoot).toBe("/mock/app/root")
	})

	it("builds a Uri from a path and from a string", () => {
		expect(Uri.file("/a/b.ts")).toEqual({ fsPath: "/a/b.ts", path: "/a/b.ts", scheme: "file" })
		expect(Uri.parse("/a/b.ts")).toEqual({ fsPath: "/a/b.ts", path: "/a/b.ts", scheme: "file" })
	})

	it("models Range, Position and Selection", () => {
		const start = new Position(1, 2)
		const end = new Position(3, 4)
		const range = new Range(start, end)
		expect(range.start).toBe(start)
		expect(range.end).toBe(end)

		const selection = new Selection(start, end)
		expect(selection).toBeInstanceOf(Range)
		expect(selection.anchor).toBe(start)
		expect(selection.active).toBe(end)
	})

	it("models the small value types", () => {
		expect(new ThemeIcon("gear").id).toBe("gear")
		expect(FileType).toMatchObject({ File: 1, Directory: 2, SymbolicLink: 64 })
		expect(DiagnosticSeverity).toMatchObject({ Error: 0, Warning: 1, Information: 2, Hint: 3 })
		expect(OverviewRulerLane).toMatchObject({ Left: 1, Center: 2, Right: 4, Full: 7 })
		expect(TreeItemCollapsibleState).toMatchObject({ None: 0, Collapsed: 1, Expanded: 2 })

		const action = new CodeAction("Fix it", CodeActionKind.QuickFix)
		expect(action.title).toBe("Fix it")
		expect(action.kind).toEqual({ value: "quickfix" })
		expect(action.command).toBeUndefined()

		const treeItem = new TreeItem("label", TreeItemCollapsibleState.Collapsed)
		expect(treeItem.label).toBe("label")
		expect(treeItem.collapsibleState).toBe(1)
	})

	it("models an EventEmitter that fires and disposes without listeners", () => {
		const emitter = new EventEmitter()
		expect(typeof emitter.event()).toBe("function")
		expect(() => emitter.fire()).not.toThrow()
		expect(() => emitter.dispose()).not.toThrow()
	})

	it("hands out a disposable that is safe to dispose", () => {
		expect(() => Disposable.dispose()).not.toThrow()
	})
})
