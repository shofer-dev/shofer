// Mock VSCode API for Vitest tests (webview-ui)
// This is a TypeScript conversion of the host-side mock at
// extensions/shofer/src/__mocks__/vscode.js

const mockDisposable = { dispose: () => {} }

export const workspace = {
	workspaceFolders: [] as any[],
	getWorkspaceFolder: () => null,
	onDidChangeWorkspaceFolders: () => mockDisposable,
	getConfiguration: () => ({
		get: (_key: string, defaultValue: any) => defaultValue,
	}),
	createFileSystemWatcher: () => ({
		onDidCreate: () => mockDisposable,
		onDidChange: () => mockDisposable,
		onDidDelete: () => mockDisposable,
		dispose: () => {},
	}),
	fs: {
		readFile: () => Promise.resolve(new Uint8Array()),
		writeFile: () => Promise.resolve(),
		stat: () => Promise.resolve({ type: 1, ctime: 0, mtime: 0, size: 0 }),
	},
}

export const window = {
	activeTextEditor: null as any,
	onDidChangeActiveTextEditor: () => mockDisposable,
	showErrorMessage: () => Promise.resolve(),
	showWarningMessage: () => Promise.resolve(),
	showInformationMessage: () => Promise.resolve(),
	createOutputChannel: () => ({
		appendLine: () => {},
		append: () => {},
		clear: () => {},
		show: () => {},
		dispose: () => {},
	}),
	createTerminal: () => ({
		exitStatus: undefined,
		name: "Shofer",
		processId: Promise.resolve(123),
		creationOptions: {} as any,
		state: { isInteractedWith: true } as any,
		dispose: () => {},
		hide: () => {},
		show: () => {},
		sendText: () => {},
	}),
	onDidCloseTerminal: () => mockDisposable,
	createTextEditorDecorationType: () => ({ dispose: () => {} }),
}

export const commands = {
	registerCommand: () => mockDisposable,
	executeCommand: () => Promise.resolve(),
}

export const languages = {
	createDiagnosticCollection: () => ({
		set: () => {},
		delete: () => {},
		clear: () => {},
		dispose: () => {},
	}),
}

export const extensions = {
	getExtension: () => null,
}

export const env = {
	openExternal: () => Promise.resolve(),
	appRoot: "/mock/app/root",
}

export const Uri = {
	file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
	parse: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
}

export const Range = class {
	start: any
	end: any
	constructor(start: any, end: any) {
		this.start = start
		this.end = end
	}
}

export const Position = class {
	line: number
	character: number
	constructor(line: number, character: number) {
		this.line = line
		this.character = character
	}
}

export const Selection = class extends Range {
	anchor: any
	active: any
	constructor(start: any, end: any) {
		super(start, end)
		this.anchor = start
		this.active = end
	}
}

export const Disposable = mockDisposable

export const ThemeIcon = class {
	id: string
	constructor(id: string) {
		this.id = id
	}
}

export const FileType = {
	File: 1,
	Directory: 2,
	SymbolicLink: 64,
}

export const DiagnosticSeverity = {
	Error: 0,
	Warning: 1,
	Information: 2,
	Hint: 3,
}

export const OverviewRulerLane = {
	Left: 1,
	Center: 2,
	Right: 4,
	Full: 7,
}

export const CodeAction = class {
	title: string
	kind: any
	command: any = undefined
	constructor(title: string, kind: any) {
		this.title = title
		this.kind = kind
	}
}

export const CodeActionKind = {
	QuickFix: { value: "quickfix" },
	RefactorRewrite: { value: "refactor.rewrite" },
}

export const TreeItemCollapsibleState = {
	None: 0,
	Collapsed: 1,
	Expanded: 2,
}

export const TreeItem = class {
	label: string
	collapsibleState: number
	constructor(label: string, collapsibleState: number) {
		this.label = label
		this.collapsibleState = collapsibleState
	}
}

export const EventEmitter = class {
	event = () => () => {}
	fire = () => {}
	dispose = () => {}
}

export default {
	workspace,
	window,
	commands,
	languages,
	extensions,
	env,
	Uri,
	Range,
	Position,
	Selection,
	Disposable,
	ThemeIcon,
	FileType,
	DiagnosticSeverity,
	OverviewRulerLane,
	EventEmitter,
	CodeAction,
	CodeActionKind,
	TreeItem,
	TreeItemCollapsibleState,
}
