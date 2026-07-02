/**
 * Host boundary (v3 architecture §9).
 *
 * The agent core currently reaches directly into the VS Code API. §9 puts
 * everything host-specific behind narrow interfaces so the core can run with
 * **zero `vscode` imports** — in the extension (a VS Code-backed adapter), the
 * CLI (today via `vscode-shim`), or a future headless server.
 *
 * `HostBridge` is the aggregate seam. It starts with the two clearest couplings —
 * user notifications and filesystem — alongside the already-extracted message
 * persistence (`MessagePersistencePort`, §5). Editor selection and diff
 * presentation are added as their call sites are migrated (the XL strangler).
 *
 * In-memory reference implementations live in `host-memory.ts` for the CLI/tests;
 * a VS Code-backed adapter is the extension's implementation.
 */

import type { DiffView, DiffViewTaskHandle } from "./diff-view.js"
import type { ShoferTerminal } from "./terminal-provider.js"

/** Options for a choice dialog (maps to `vscode.MessageOptions` + severity). */
export interface NotifyChoiceOptions {
	/** Which `vscode.window.show*Message` variant backs the dialog. Default `info`. */
	severity?: "info" | "warn" | "error"
	/** Show as a blocking modal dialog. */
	modal?: boolean
	/** Secondary detail text (modal only, in VS Code). */
	detail?: string
}

/** User-facing notifications (maps to `vscode.window.show*Message`). */
export interface Notifier {
	info(message: string): void
	warn(message: string): void
	error(message: string): void
	/**
	 * Show a message with action buttons and resolve to the chosen label, or
	 * `undefined` if dismissed (maps to `vscode.window.show*Message(msg, opts,
	 * ...items)`). Covers the choice-dialog call sites that need a return value;
	 * `opts.severity` selects the info/warning/error variant.
	 */
	showChoice(message: string, options: string[], opts?: NotifyChoiceOptions): Promise<string | undefined>
}

/** Configuration reads the core needs (maps to `vscode.workspace.getConfiguration`). */
export interface HostConfig {
	/**
	 * Read a config value. `section` is the configuration namespace (e.g. the
	 * extension id), `key` the setting within it; returns `defaultValue` when unset.
	 * Maps to `vscode.workspace.getConfiguration(section).get(key, defaultValue)`.
	 */
	get<T>(section: string, key: string, defaultValue: T): T
}

/** Diagnostic severity, mirroring `vscode.DiagnosticSeverity` as a string. */
export type HostDiagnosticSeverity = "error" | "warning" | "info" | "hint"

/** A single diagnostic (maps to one `vscode.Diagnostic`). Positions are 1-based. */
export interface HostDiagnostic {
	filePath: string
	line: number
	column: number
	severity: HostDiagnosticSeverity
	message: string
	source?: string
}

/** A symbol reference / usage (maps to one `vscode.Location`). Positions are 1-based. */
export interface HostReference {
	filePath: string
	line: number
	column: number
	/** Trimmed source line at the reference (for display). */
	preview: string
}

/** Result of a reference query: the windowed `references` plus the unsliced `total`. */
export interface HostReferencesResult {
	total: number
	references: HostReference[]
}

/** A workspace symbol (maps to one `vscode.SymbolInformation`). `line` is 1-based. */
export interface HostSymbol {
	name: string
	/** Symbol kind name (e.g. "Function", "Class") — `vscode.SymbolKind` rendered as a string. */
	kind: string
	filePath: string
	line: number
}

/** A single text edit. Positions are 0-based (mirroring `vscode.Range`) for round-trip fidelity. */
export interface HostTextEdit {
	startLine: number
	startColumn: number
	endLine: number
	endColumn: number
	newText: string
}

/** Edits to a single file. */
export interface HostFileEdit {
	filePath: string
	edits: HostTextEdit[]
}

/** A multi-file edit (maps to `vscode.WorkspaceEdit`). */
export interface HostWorkspaceEdit {
	changes: HostFileEdit[]
}

/**
 * Language-service queries the core needs (maps to `vscode.languages` +
 * `vscode.executeXProvider` commands). Read-only; a headless host returns empty
 * results (the feature degrades rather than failing).
 */
export interface HostLsp {
	/**
	 * All current workspace diagnostics (maps to `vscode.languages.getDiagnostics`).
	 * Async so the whole `HostLsp` surface is transport-agnostic (remoteable).
	 */
	getDiagnostics(): Promise<HostDiagnostic[]>
	/**
	 * References to the symbol at a 1-based `line`/`column` in `filePath`, windowed
	 * to `maxResults` (maps to `vscode.executeReferenceProvider`).
	 */
	findReferences(filePath: string, line: number, column: number, maxResults: number): Promise<HostReferencesResult>
	/** Workspace symbols matching `query` (maps to `vscode.executeWorkspaceSymbolProvider`). */
	workspaceSymbols(query: string): Promise<HostSymbol[]>
	/**
	 * Compute (but do not apply) the rename of the symbol at a 1-based `line`/`column`
	 * to `newName` (maps to `vscode.executeDocumentRenameProvider`). Returns `null`
	 * when no rename provider is available or the symbol can't be renamed.
	 */
	computeRename(filePath: string, line: number, column: number, newName: string): Promise<HostWorkspaceEdit | null>
	/** Apply a multi-file edit (maps to `vscode.workspace.applyEdit`). Returns success. */
	applyWorkspaceEdit(edit: HostWorkspaceEdit): Promise<boolean>
}

/** A disposable resource (maps to `vscode.Disposable`). */
export interface HostDisposable {
	dispose(): void
}

/**
 * A file-system watcher over a glob (maps to `vscode.FileSystemWatcher`). Each
 * `on*` registers a handler and returns its own disposable; `dispose()` tears the
 * whole watcher down.
 */
export interface HostFileWatcher extends HostDisposable {
	onCreate(handler: () => void): HostDisposable
	onChange(handler: () => void): HostDisposable
	onDelete(handler: () => void): HostDisposable
}

/** File-watching the core needs (maps to `vscode.workspace.createFileSystemWatcher`). */
export interface HostWatcher {
	/**
	 * Watch files matching glob `pattern` under `baseDir` (maps to
	 * `createFileSystemWatcher(new RelativePattern(baseDir, pattern))`). A headless
	 * host may return a no-op watcher.
	 */
	watch(baseDir: string, pattern: string): HostFileWatcher
}

/** Workspace-level host actions (maps to `vscode.commands` workspace operations). */
export interface HostWorkspace {
	/**
	 * Open a folder as the active workspace (maps to the `vscode.openFolder`
	 * command). A headless host has no IDE window and may no-op.
	 */
	openFolder(path: string, options?: { newWindow?: boolean }): Promise<void>
	/**
	 * Execute a host command and return its result (maps to
	 * `vscode.commands.executeCommand`). Used for provider-contributed
	 * (private-tool) commands. A headless host throws (no command registry).
	 */
	executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T>
	/** Absolute paths of the open workspace roots (maps to `vscode.workspace.workspaceFolders`). */
	workspaceRoots(): string[]
	/** Absolute path of the file in the active editor, if any (maps to `vscode.window.activeTextEditor`). */
	activeEditorFile(): string | undefined
	/**
	 * Absolute paths of the files shown in the currently visible editors (maps to
	 * `vscode.window.visibleTextEditors`, mapped to `document.uri.fsPath`, empty
	 * paths dropped). A headless host with no IDE window returns `[]`. Callers do
	 * their own workspace-relative rewriting and windowing.
	 */
	visibleFiles(): string[]
	/**
	 * Absolute paths of the text-input tabs open across all tab groups (maps to
	 * `vscode.window.tabGroups.all` flattened, filtered to `TabInputText`, mapped
	 * to `uri.fsPath`, empty paths dropped). A headless host with no IDE window
	 * returns `[]`. Callers do their own workspace-relative rewriting and windowing.
	 */
	openTabs(): string[]
	/** The workspace root containing `filePath`, if any (maps to `vscode.workspace.getWorkspaceFolder`). */
	workspaceFolderFor(filePath: string): string | undefined
	/**
	 * Register `handler` to run when the set of open workspace folders changes
	 * (maps to `vscode.workspace.onDidChangeWorkspaceFolders`). A headless host
	 * with no IDE window returns a no-op disposable.
	 */
	onDidChangeWorkspaceFolders(handler: () => void): HostDisposable
}

/** Host environment facts the core needs (maps to `vscode.env`). */
/**
 * Front-end/build identity — what the extension's `package.json` + `PKG_*` build env
 * used to expose as `shared/package`'s `Package`. Host-provided so the portable core
 * doesn't read the extension's `package.json`.
 */
export interface AppInfo {
	readonly publisher?: string
	readonly name: string
	readonly version: string
	readonly outputChannel: string
	readonly sha?: string
	readonly changelog?: string
}

export interface HostEnv {
	/** UI display language / locale (maps to `vscode.env.language`, e.g. "en"). */
	readonly language: string
	/** Application install root, used to locate bundled binaries (maps to `vscode.env.appRoot`). */
	readonly appRoot: string
	/** Stable anonymous machine id for telemetry (maps to `vscode.env.machineId`). */
	readonly machineId: string
	/** Front-end/build identity (publisher/name/version/…) — supplants `shared/package`. */
	readonly appInfo: AppInfo
}

/** Options for {@link HostFileSystem.findFiles}. */
export interface FindFilesOptions {
	/** Base directory the glob `pattern` is relative to. */
	cwd: string
	/** Glob patterns to exclude. */
	exclude?: string[]
	/** Maximum number of results. */
	maxResults?: number
}

/** Minimal filesystem the core needs, independent of `vscode.workspace.fs` or `node:fs`. */
export interface HostFileSystem {
	readFile(path: string): Promise<string>
	writeFile(path: string, content: string): Promise<void>
	exists(path: string): Promise<boolean>
	mkdir(path: string): Promise<void>
	delete(path: string): Promise<void>
	/**
	 * Glob for files matching `pattern` under `options.cwd`, returning absolute
	 * paths (maps to `vscode.workspace.findFiles`). A host without a file index
	 * may return `[]`.
	 */
	findFiles(pattern: string, options: FindFilesOptions): Promise<string[]>
}

/**
 * Opaque handle to a host-created terminal (maps to a `vscode.Terminal`). The
 * core never inspects it — it only holds it and compares it by identity to
 * correlate shell-execution events back to the terminal they came from.
 */
export type HostTerminalHandle = object

/**
 * A single shell command execution on a host terminal (maps to
 * `vscode.TerminalShellExecution`). Only the fields the core actually reads are
 * modelled.
 */
export interface HostShellExecution {
	/** Stream the command's output as it arrives (maps to `TerminalShellExecution.read()`). */
	read(): AsyncIterable<string>
	/** The command line being executed, if known (maps to `TerminalShellExecution.commandLine.value`). */
	readonly commandLine?: string
}

/** A shell command has started (maps to `vscode.TerminalShellExecutionStartEvent`). */
export interface HostShellExecutionStartEvent {
	readonly execution: HostShellExecution
	readonly terminal: HostTerminalHandle
}

/** A shell command has ended (maps to `vscode.TerminalShellExecutionEndEvent`). */
export interface HostShellExecutionEndEvent {
	/** The execution, when reported (used only for best-effort logging). */
	readonly execution?: HostShellExecution
	readonly terminal: HostTerminalHandle
	/** Exit code of the command, or `undefined` when not reported. */
	readonly exitCode: number | undefined
}

/**
 * Terminal shell-integration events the core's terminal registry needs (maps to
 * the `vscode.window.onDid*Terminal*` event family). Each `on*` registers a
 * handler and returns its own disposable. A headless host with no interactive
 * terminals returns no-op disposables (the events simply never fire).
 */
export interface HostTerminals {
	/** Register `handler` for terminal-close events (maps to `vscode.window.onDidCloseTerminal`). */
	onDidCloseTerminal(handler: (terminal: HostTerminalHandle) => void): HostDisposable
	/**
	 * Register `handler` for shell-execution start events (maps to
	 * `vscode.window.onDidStartTerminalShellExecution`).
	 */
	onDidStartShellExecution(handler: (event: HostShellExecutionStartEvent) => void): HostDisposable
	/**
	 * Register `handler` for shell-execution end events (maps to
	 * `vscode.window.onDidEndTerminalShellExecution`).
	 */
	onDidEndShellExecution(handler: (event: HostShellExecutionEndEvent) => void): HostDisposable
	/**
	 * Create the front-end's terminal backend for `id`/`cwd` (maps to `new Terminal(...)`
	 * in the VS Code adapter). The portable `execa` provider is created by the core registry
	 * itself; this factory supplies the platform-backed terminal. A headless host that has no
	 * interactive terminals may throw — the core only calls it for the `"vscode"` provider.
	 */
	createTerminal(id: number, cwd: string): ShoferTerminal
	/** Clean up shell-integration temp state: one terminal (id given) or all of it (id omitted). */
	cleanupShellIntegration(terminalId?: number): void
}

/** Aggregate host boundary handed to the core. */
export interface HostBridge {
	readonly notifier: Notifier
	readonly fs: HostFileSystem
	readonly config: HostConfig
	readonly env: HostEnv
	readonly lsp: HostLsp
	readonly workspace: HostWorkspace
	readonly watcher: HostWatcher
	readonly terminals: HostTerminals
	/**
	 * Build a fresh, per-edit {@link DiffView} bound to `cwd` and its owning `task`
	 * (maps to `new DiffViewProvider(cwd, task)` in the VS Code adapter). The
	 * returned object is stateful and single-flight; the core creates one per Task.
	 * A headless host may return a no-op diff view.
	 */
	createDiffView(cwd: string, task: DiffViewTaskHandle): DiffView
}
