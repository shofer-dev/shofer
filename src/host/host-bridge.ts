import * as fs from "node:fs/promises"

import * as vscode from "vscode"
import type {
	HostBridge,
	DiffView,
	DiffViewTaskHandle,
	FindFilesOptions,
	HostConfig,
	HostDisposable,
	HostDiagnostic,
	HostDiagnosticSeverity,
	HostDiffChange,
	HostEditor,
	HostEnv,
	HostExternal,
	AppInfo,
	HostFileEdit,
	HostFileSystem,
	HostLsp,
	HostFileWatcher,
	HostPanel,
	HostReferencesResult,
	HostShellExecution,
	HostState,
	HostSymbol,
	HostTerminals,
	ShoferTerminal,
	HostWatcher,
	HostWorkspace,
	HostWorkspaceEdit,
	ModeConfig,
	CustomModePrompts,
	ModeOverrides,
	Notifier,
	NotifyChoiceOptions,
} from "@shofer/types"
import { DIFF_VIEW_URI_SCHEME } from "@shofer/types"
import { effectiveModes } from "@shofer/core"

import { ensureSettingsDirectoryExists } from "../utils/globalContext"
import { ContextProxy } from "../core/config/ContextProxy"
import type { ShoferSettings } from "@shofer/types"

import { DiffViewProvider } from "../integrations/editor/DiffViewProvider"
import { Terminal } from "../integrations/terminal/Terminal"
import { ShellIntegrationManager } from "../integrations/terminal/ShellIntegrationManager"
import { openFile } from "../integrations/misc/open-file"
import { diagnosticsToProblemsString } from "../integrations/diagnostics"
import { publisher as pkgPublisher, name as pkgName, version as pkgVersion } from "../package.json"

/**
 * VS Code-backed implementation of the host boundary (§9). This is the extension
 * adapter for `HostBridge` — the only place the core's host-service needs touch
 * `vscode.*` / Node `fs`. As call sites migrate from direct `vscode.*` usage onto
 * `getHost()`, this adapter (and the CLI's in-memory one) become the sole host
 * couplings, leaving the core `vscode`-free.
 */

class VsCodeNotifier implements Notifier {
	info(message: string): void {
		void vscode.window.showInformationMessage(message)
	}
	warn(message: string): void {
		void vscode.window.showWarningMessage(message)
	}
	error(message: string): void {
		void vscode.window.showErrorMessage(message)
	}
	showChoice(message: string, options: string[], opts?: NotifyChoiceOptions): Promise<string | undefined> {
		const messageOptions: vscode.MessageOptions = { modal: opts?.modal, detail: opts?.detail }
		const show =
			opts?.severity === "error"
				? vscode.window.showErrorMessage
				: opts?.severity === "warn"
					? vscode.window.showWarningMessage
					: vscode.window.showInformationMessage
		return Promise.resolve(show(message, messageOptions, ...options))
	}
}

class NodeFileSystem implements HostFileSystem {
	readFile(path: string): Promise<string> {
		return fs.readFile(path, "utf8")
	}
	writeFile(path: string, content: string): Promise<void> {
		return fs.writeFile(path, content, "utf8")
	}
	async exists(path: string): Promise<boolean> {
		try {
			await fs.access(path)
			return true
		} catch {
			return false
		}
	}
	async mkdir(path: string): Promise<void> {
		await fs.mkdir(path, { recursive: true })
	}
	delete(path: string): Promise<void> {
		return fs.rm(path, { recursive: true, force: true })
	}
	async findFiles(pattern: string, options: FindFilesOptions): Promise<string[]> {
		const excludeGlob = options.exclude && options.exclude.length ? `{${options.exclude.join(",")}}` : undefined
		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(options.cwd, pattern),
			excludeGlob,
			options.maxResults,
		)
		return uris.map((u) => u.fsPath)
	}
}

// Settings migrated from `shofer.*` VS Code config into ContextProxy/globalState —
// the single source of truth (todos/config-cleanup.md Part A). This seam is how
// @shofer/core reads config, so rerouting HERE migrates every core consumer at once
// without core importing ContextProxy (Core Self-Sufficiency Rule). Maps the VS Code
// config key → globalSettings key (identical except the dotted `debugProxy.*`, which
// flatten). The package.json `contributes.configuration` rows are removed per key.
const MIGRATED_SHOFER_CONFIG_KEYS: Record<string, keyof ShoferSettings> = {
	apiRequestTimeout: "apiRequestTimeout",
	maximumIndexedFilesForFileSearch: "maximumIndexedFilesForFileSearch",
	newTaskRequireTodos: "newTaskRequireTodos",
	enableCodeActions: "enableCodeActions",
	enableLlmProviderIntegration: "enableLlmProviderIntegration",
	debug: "debug",
	vsCodeLmModelSelector: "vsCodeLmModelSelector",
	"debugProxy.enabled": "debugProxyEnabled",
	"debugProxy.serverUrl": "debugProxyServerUrl",
	"debugProxy.tlsInsecure": "debugProxyTlsInsecure",
}

class VsCodeConfig implements HostConfig {
	get<T>(section: string, key: string, defaultValue: T): T {
		// Migrated shofer settings resolve from ContextProxy/globalState. Fall back to
		// VS Code config when ContextProxy is not yet initialized (early activation,
		// bare-host tests) or the key is unset there.
		if (section === "shofer") {
			const gKey = MIGRATED_SHOFER_CONFIG_KEYS[key]
			if (gKey) {
				try {
					const value = ContextProxy.instance.getValue(gKey)
					if (value !== undefined) {
						return value as T
					}
				} catch {
					// ContextProxy not initialized — fall through to VS Code config.
				}
			}
		}
		return vscode.workspace.getConfiguration(section).get<T>(key, defaultValue)
	}
}

// Reads the user's mode customizations from the extension's `globalState`. The
// context is captured at activation; without it (e.g. unit tests that build a
// bare host) there are no overrides.
class VsCodeState implements HostState {
	constructor(private readonly context?: vscode.ExtensionContext) {}

	async readModeOverrides(): Promise<ModeOverrides> {
		if (!this.context) {
			return {}
		}
		// Preserve the original side effect: make sure the settings dir exists.
		await ensureSettingsDirectoryExists(this.context)
		// The persisted list is what `CustomModesManager` last merged; re-derive the
		// plugin half here so the prompt's MODES section is right even on the first read
		// of a session, before anything asked the manager for modes. Without this the
		// built-in modes — plugin-contributed now — could be missing from the prompt.
		const persisted = this.context.globalState.get<ModeConfig[]>("customModes")
		const customModes = effectiveModes(persisted)
		const customModePrompts = this.context.globalState.get<CustomModePrompts>("customModePrompts") ?? undefined
		return { customModes, customModePrompts }
	}
}

// App/build identity — was `shared/package`'s `Package`. `PKG_*` env vars let ESBuild
// override the package.json values to build differently-branded extension variants.
const vsCodeAppInfo: AppInfo = {
	publisher: pkgPublisher,
	name: process.env.PKG_NAME || pkgName,
	version: process.env.PKG_VERSION || pkgVersion,
	outputChannel: process.env.PKG_OUTPUT_CHANNEL || "Shofer",
	sha: process.env.PKG_SHA,
	changelog: process.env.PKG_CHANGELOG,
}

const vsCodeEnv: HostEnv = {
	get language() {
		return vscode.env.language
	},
	get appRoot() {
		return vscode.env.appRoot
	},
	get machineId() {
		return vscode.env.machineId
	},
	appInfo: vsCodeAppInfo,
}

function mapSeverity(severity: vscode.DiagnosticSeverity): HostDiagnosticSeverity {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return "error"
		case vscode.DiagnosticSeverity.Warning:
			return "warning"
		case vscode.DiagnosticSeverity.Information:
			return "info"
		case vscode.DiagnosticSeverity.Hint:
			return "hint"
		default:
			return "info"
	}
}

class VsCodeLsp implements HostLsp {
	async getDiagnostics(): Promise<HostDiagnostic[]> {
		const out: HostDiagnostic[] = []
		for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
			for (const d of diagnostics) {
				out.push({
					filePath: uri.fsPath,
					line: d.range.start.line + 1,
					column: d.range.start.character + 1,
					severity: mapSeverity(d.severity),
					message: d.message,
					source: d.source,
				})
			}
		}
		return out
	}

	async findReferences(
		filePath: string,
		line: number,
		column: number,
		maxResults: number,
	): Promise<HostReferencesResult> {
		const uri = vscode.Uri.file(filePath)
		// LSP needs the document open to provide references; give it a moment to analyze.
		const doc = await vscode.workspace.openTextDocument(uri)
		await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })
		await new Promise<void>((resolve) => setTimeout(resolve, 500))

		const position = new vscode.Position(line - 1, column - 1)
		const locations =
			(await vscode.commands.executeCommand<vscode.Location[]>(
				"vscode.executeReferenceProvider",
				uri,
				position,
			)) ?? []

		const references = []
		for (const loc of locations.slice(0, maxResults)) {
			let preview = ""
			try {
				const locDoc = await vscode.workspace.openTextDocument(loc.uri)
				preview = locDoc.lineAt(loc.range.start.line).text.trim().slice(0, 150)
			} catch {
				preview = "(unable to read)"
			}
			references.push({
				filePath: loc.uri.fsPath,
				line: loc.range.start.line + 1,
				column: loc.range.start.character + 1,
				preview,
			})
		}
		return { total: locations.length, references }
	}

	async workspaceSymbols(query: string): Promise<HostSymbol[]> {
		const symbols =
			(await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
				"vscode.executeWorkspaceSymbolProvider",
				query,
			)) ?? []
		return symbols.map((s) => ({
			name: s.name,
			kind: vscode.SymbolKind[s.kind] || "Unknown",
			filePath: s.location.uri.fsPath,
			line: s.location.range.start.line + 1,
		}))
	}

	async computeRename(
		filePath: string,
		line: number,
		column: number,
		newName: string,
	): Promise<HostWorkspaceEdit | null> {
		const uri = vscode.Uri.file(filePath)
		// LSP needs the document open to provide a rename; give it a moment to analyze.
		const doc = await vscode.workspace.openTextDocument(uri)
		await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })
		await new Promise<void>((resolve) => setTimeout(resolve, 500))

		const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
			"vscode.executeDocumentRenameProvider",
			uri,
			new vscode.Position(line - 1, column - 1),
			newName,
		)
		if (!edit) {
			return null
		}
		const changes: HostFileEdit[] = []
		for (const [fileUri, edits] of edit.entries()) {
			changes.push({
				filePath: fileUri.fsPath,
				edits: edits.map((e) => ({
					startLine: e.range.start.line,
					startColumn: e.range.start.character,
					endLine: e.range.end.line,
					endColumn: e.range.end.character,
					newText: e.newText,
				})),
			})
		}
		return { changes }
	}

	async applyWorkspaceEdit(edit: HostWorkspaceEdit): Promise<boolean> {
		const wsEdit = new vscode.WorkspaceEdit()
		for (const fileEdit of edit.changes) {
			const uri = vscode.Uri.file(fileEdit.filePath)
			for (const e of fileEdit.edits) {
				wsEdit.replace(uri, new vscode.Range(e.startLine, e.startColumn, e.endLine, e.endColumn), e.newText)
			}
		}
		return vscode.workspace.applyEdit(wsEdit)
	}
}

class VsCodeWorkspace implements HostWorkspace {
	async openFolder(path: string, options?: { newWindow?: boolean }): Promise<void> {
		await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path), {
			forceNewWindow: options?.newWindow ?? false,
		})
	}
	executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T> {
		return Promise.resolve(vscode.commands.executeCommand<T>(command, ...args))
	}
	workspaceRoots(): string[] {
		return vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []
	}
	activeEditorFile(): string | undefined {
		return vscode.window.activeTextEditor?.document.uri.fsPath
	}
	visibleFiles(): string[] {
		return (vscode.window.visibleTextEditors ?? [])
			.map((editor) => editor.document?.uri?.fsPath)
			.filter((p): p is string => Boolean(p))
	}
	openTabs(): string[] {
		return vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.filter((tab) => tab.input instanceof vscode.TabInputText)
			.map((tab) => (tab.input as vscode.TabInputText).uri.fsPath)
			.filter((p): p is string => Boolean(p))
	}
	workspaceFolderFor(filePath: string): string | undefined {
		return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath
	}
	onDidChangeWorkspaceFolders(handler: () => void): HostDisposable {
		return vscode.workspace.onDidChangeWorkspaceFolders(() => handler())
	}
}

class VsCodeWatcher implements HostWatcher {
	watch(baseDir: string, pattern: string): HostFileWatcher {
		const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(baseDir, pattern))
		// Thread the vscode.Uri's absolute fsPath to the handler (P7 — path-carrying watch).
		return {
			onCreate: (handler) => w.onDidCreate((uri) => handler(uri.fsPath)),
			onChange: (handler) => w.onDidChange((uri) => handler(uri.fsPath)),
			onDelete: (handler) => w.onDidDelete((uri) => handler(uri.fsPath)),
			dispose: () => w.dispose(),
		}
	}
}

/** Adapt a `vscode.TerminalShellExecution` to the vscode-free `HostShellExecution`. */
function wrapShellExecution(execution: vscode.TerminalShellExecution): HostShellExecution {
	return {
		read: () => execution.read(),
		get commandLine() {
			return execution.commandLine?.value
		},
	}
}

class VsCodeTerminals implements HostTerminals {
	onDidCloseTerminal(handler: (terminal: vscode.Terminal) => void): vscode.Disposable {
		return vscode.window.onDidCloseTerminal((terminal) => handler(terminal))
	}
	onDidStartShellExecution(
		handler: (event: { execution: HostShellExecution; terminal: vscode.Terminal }) => void,
	): vscode.Disposable {
		// The shell-integration API is unavailable on older VS Code builds; fall
		// back to a no-op disposable so the core sees a uniform, always-present API.
		return (
			vscode.window.onDidStartTerminalShellExecution?.((e) =>
				handler({ execution: wrapShellExecution(e.execution), terminal: e.terminal }),
			) ?? { dispose() {} }
		)
	}
	onDidEndShellExecution(
		handler: (event: {
			execution?: HostShellExecution
			terminal: vscode.Terminal
			exitCode: number | undefined
		}) => void,
	): vscode.Disposable {
		return (
			vscode.window.onDidEndTerminalShellExecution?.((e) =>
				handler({
					execution: e.execution ? wrapShellExecution(e.execution) : undefined,
					terminal: e.terminal,
					exitCode: e.exitCode,
				}),
			) ?? { dispose() {} }
		)
	}
	createTerminal(id: number, cwd: string): ShoferTerminal {
		return new Terminal(id, undefined, cwd)
	}
	cleanupShellIntegration(terminalId?: number): void {
		if (terminalId === undefined) {
			ShellIntegrationManager.clear()
		} else {
			ShellIntegrationManager.zshCleanupTmpDir(terminalId)
		}
	}
}

class VsCodeExternal implements HostExternal {
	async openExternal(url: string): Promise<void> {
		await vscode.env.openExternal(vscode.Uri.parse(url))
	}
}

class VsCodeEditor implements HostEditor {
	async revealInExplorer(path: string): Promise<void> {
		await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(path))
	}
	async openFile(path: string): Promise<void> {
		await openFile(path)
	}
	async focusPanel(which: HostPanel): Promise<void> {
		await vscode.commands.executeCommand(
			which === "problems" ? "workbench.actions.view.problems" : "workbench.action.terminal.focus",
		)
	}
	async showMultiFileDiff(title: string, changes: HostDiffChange[]): Promise<void> {
		await vscode.commands.executeCommand(
			"vscode.changes",
			title,
			changes.map((change) => [
				vscode.Uri.file(change.paths.absolute),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.before ?? "").toString("base64"),
				}),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.after ?? "").toString("base64"),
				}),
			]),
		)
	}
	async readTerminalContents(): Promise<string> {
		// Store original clipboard content to restore later.
		const originalClipboard = await vscode.env.clipboard.readText()

		try {
			// Select terminal content, copy it, then clear the selection.
			await vscode.commands.executeCommand("workbench.action.terminal.selectAll")
			await vscode.commands.executeCommand("workbench.action.terminal.copySelection")
			await vscode.commands.executeCommand("workbench.action.terminal.clearSelection")

			// Get terminal contents from clipboard.
			let terminalContents = (await vscode.env.clipboard.readText()).trim()

			// Check if there's actually a terminal open.
			if (terminalContents === originalClipboard) {
				return ""
			}

			// Clean up command separation.
			const lines = terminalContents.split("\n")
			const lastLine = lines.pop()?.trim()

			if (lastLine) {
				let i = lines.length - 1
				while (i >= 0 && !lines[i].trim().startsWith(lastLine)) {
					i--
				}
				terminalContents = lines.slice(Math.max(i, 0)).join("\n")
			}

			return terminalContents
		} finally {
			// Restore original clipboard content.
			await vscode.env.clipboard.writeText(originalClipboard)
		}
	}
	async getWorkspaceProblems(cwd: string, includeMessages: boolean, maxMessages: number): Promise<string> {
		const diagnostics = vscode.languages.getDiagnostics()
		const result = await diagnosticsToProblemsString(
			diagnostics,
			[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
			cwd,
			includeMessages,
			maxMessages,
		)
		return result || "No errors or warnings detected."
	}
}

/** The VS Code host bridge (extension runtime). */
export function createVsCodeHost(context?: vscode.ExtensionContext): HostBridge {
	return {
		notifier: new VsCodeNotifier(),
		fs: new NodeFileSystem(),
		config: new VsCodeConfig(),
		env: vsCodeEnv,
		lsp: new VsCodeLsp(),
		workspace: new VsCodeWorkspace(),
		watcher: new VsCodeWatcher(),
		terminals: new VsCodeTerminals(),
		external: new VsCodeExternal(),
		editor: new VsCodeEditor(),
		state: new VsCodeState(context),
		createDiffView: (cwd: string, task: DiffViewTaskHandle): DiffView => new DiffViewProvider(cwd, task),
	}
}

// The host registry lives in `@shofer/types` (a vscode-free package) so the
// portable core can import `getHost()` without pulling in this VS Code adapter.
// Re-exported here for adapter-side callers (extension activation, tests).
export { getHost, setHost } from "@shofer/types"
