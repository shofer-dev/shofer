import type { DiffView, DiffViewSaveResult } from "./diff-view.js"
import type {
	HostBridge,
	HostConfig,
	HostEnv,
	HostFileSystem,
	HostDisposable,
	HostLsp,
	HostReferencesResult,
	HostTerminals,
	HostWatcher,
	HostWorkspace,
	Notifier,
	NotifyChoiceOptions,
} from "./host.js"

/**
 * In-memory / no-op host implementations (§9) for the CLI, tests, and as a
 * reference for what a host adapter must provide. No `vscode`, no real disk.
 */

/** A `Notifier` that records messages instead of showing UI. */
export class RecordingNotifier implements Notifier {
	readonly messages: Array<{ level: "info" | "warn" | "error"; message: string }> = []
	/** Choice returned by `showChoice` (default: dismissed). Set in tests to simulate a click. */
	choiceResponse: string | undefined = undefined
	info(message: string): void {
		this.messages.push({ level: "info", message })
	}
	warn(message: string): void {
		this.messages.push({ level: "warn", message })
	}
	error(message: string): void {
		this.messages.push({ level: "error", message })
	}
	async showChoice(message: string, _options: string[], opts?: NotifyChoiceOptions): Promise<string | undefined> {
		this.messages.push({
			level: opts?.severity === "error" ? "error" : opts?.severity === "warn" ? "warn" : "info",
			message,
		})
		return this.choiceResponse
	}
}

/** An in-memory `HostFileSystem` backed by a Map (paths are used verbatim as keys). */
export class InMemoryFileSystem implements HostFileSystem {
	private readonly files = new Map<string, string>()
	private readonly dirs = new Set<string>()

	async readFile(path: string): Promise<string> {
		const content = this.files.get(path)
		if (content === undefined) throw new Error(`ENOENT: ${path}`)
		return content
	}
	async writeFile(path: string, content: string): Promise<void> {
		this.files.set(path, content)
	}
	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path)
	}
	async mkdir(path: string): Promise<void> {
		this.dirs.add(path)
	}
	async delete(path: string): Promise<void> {
		this.files.delete(path)
		this.dirs.delete(path)
	}
	/** No file index in the reference impl; a real headless host overrides this. */
	async findFiles(): Promise<string[]> {
		return []
	}
}

/** An in-memory `HostConfig` (returns the provided default unless a value was `set`). */
export class InMemoryConfig implements HostConfig {
	private readonly values = new Map<string, unknown>()
	set(section: string, key: string, value: unknown): void {
		this.values.set(`${section}.${key}`, value)
	}
	get<T>(section: string, key: string, defaultValue: T): T {
		const v = this.values.get(`${section}.${key}`)
		return v === undefined ? defaultValue : (v as T)
	}
}

/** A default in-memory `HostEnv` (English, no app root). */
export const inMemoryEnv: HostEnv = { language: "en", appRoot: "" }

/** A no-op `HostWatcher` (no file events). */
const noopDisposable: HostDisposable = { dispose() {} }
export const noopWatcher: HostWatcher = {
	watch: () => ({
		onCreate: () => noopDisposable,
		onChange: () => noopDisposable,
		onDelete: () => noopDisposable,
		dispose() {},
	}),
}

/** A no-op `HostWorkspace` (no IDE window). */
export const noopWorkspace: HostWorkspace = {
	openFolder: async () => {},
	executeCommand: async (command: string) => {
		throw new Error(`Command "${command}" is not available in this host`)
	},
	workspaceRoots: () => [],
	activeEditorFile: () => undefined,
	workspaceFolderFor: () => undefined,
	onDidChangeWorkspaceFolders: () => noopDisposable,
}

/** A no-op `HostTerminals` (no interactive terminals): events never fire. */
export const noopTerminals: HostTerminals = {
	onDidCloseTerminal: () => noopDisposable,
	onDidStartShellExecution: () => noopDisposable,
	onDidEndShellExecution: () => noopDisposable,
	createTerminal: () => {
		// The headless/CLI host has no interactive terminals; the core only reaches for
		// this on the "vscode" provider, so a headless front-end selects "execa" instead.
		throw new Error("No platform terminal backend on the in-memory host (use the execa provider).")
	},
	cleanupShellIntegration: () => {},
}

/** A no-op `HostLsp` (no language service): empty diagnostics/references. */
export const noopLsp: HostLsp = {
	getDiagnostics: async () => [],
	findReferences: async (): Promise<HostReferencesResult> => ({ total: 0, references: [] }),
	workspaceSymbols: async () => [],
	computeRename: async () => null,
	applyWorkspaceEdit: async () => false,
}

/**
 * A no-op `DiffView` (no IDE, no disk): the lifecycle resolves without presenting
 * a diff or reporting problems. The Task constructs one eagerly, so this must not
 * throw; a real headless host that wants working edits supplies its own.
 */
export class NoopDiffView implements DiffView {
	editType?: "create" | "modify"
	originalContent: string | undefined
	isEditing = false
	userEdits?: string
	newProblemsMessage?: string

	async open(): Promise<void> {
		this.isEditing = true
	}
	async update(): Promise<void> {}
	async saveChanges(): Promise<DiffViewSaveResult> {
		return { newProblemsMessage: undefined, userEdits: undefined, finalContent: undefined }
	}
	async saveDirectly(): Promise<DiffViewSaveResult> {
		return { newProblemsMessage: undefined, userEdits: undefined, finalContent: undefined }
	}
	async pushToolWriteResult(): Promise<string> {
		return "{}"
	}
	async revertChanges(): Promise<void> {}
	scrollToFirstDiff(): void {}
	async reset(): Promise<void> {
		this.isEditing = false
		this.editType = undefined
		this.originalContent = undefined
	}
}

/** Build an entirely in-memory `HostBridge` (CLI/test default). */
export function createInMemoryHost(): HostBridge {
	return {
		notifier: new RecordingNotifier(),
		fs: new InMemoryFileSystem(),
		config: new InMemoryConfig(),
		env: inMemoryEnv,
		lsp: noopLsp,
		workspace: noopWorkspace,
		watcher: noopWatcher,
		terminals: noopTerminals,
		createDiffView: () => new NoopDiffView(),
	}
}
