/**
 * Host boundary (todos/opencode_inspired_work.md §9).
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
	/** All current workspace diagnostics (maps to `vscode.languages.getDiagnostics`). */
	getDiagnostics(): HostDiagnostic[]
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

/** Host environment facts the core needs (maps to `vscode.env`). */
export interface HostEnv {
	/** UI display language / locale (maps to `vscode.env.language`, e.g. "en"). */
	readonly language: string
	/** Application install root, used to locate bundled binaries (maps to `vscode.env.appRoot`). */
	readonly appRoot: string
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

/** Aggregate host boundary handed to the core. */
export interface HostBridge {
	readonly notifier: Notifier
	readonly fs: HostFileSystem
	readonly config: HostConfig
	readonly env: HostEnv
	readonly lsp: HostLsp
}
