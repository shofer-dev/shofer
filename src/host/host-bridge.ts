import * as fs from "node:fs/promises"

import * as vscode from "vscode"
import type {
	HostBridge,
	FindFilesOptions,
	HostConfig,
	HostDiagnostic,
	HostDiagnosticSeverity,
	HostEnv,
	HostFileEdit,
	HostFileSystem,
	HostLsp,
	HostFileWatcher,
	HostReferencesResult,
	HostSymbol,
	HostWatcher,
	HostWorkspace,
	HostWorkspaceEdit,
	Notifier,
	NotifyChoiceOptions,
} from "@shofer/types"

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

class VsCodeConfig implements HostConfig {
	get<T>(section: string, key: string, defaultValue: T): T {
		return vscode.workspace.getConfiguration(section).get<T>(key, defaultValue)
	}
}

const vsCodeEnv: HostEnv = {
	get language() {
		return vscode.env.language
	},
	get appRoot() {
		return vscode.env.appRoot
	},
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
	getDiagnostics(): HostDiagnostic[] {
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
}

class VsCodeWatcher implements HostWatcher {
	watch(baseDir: string, pattern: string): HostFileWatcher {
		const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(baseDir, pattern))
		return {
			onCreate: (handler) => w.onDidCreate(handler),
			onChange: (handler) => w.onDidChange(handler),
			onDelete: (handler) => w.onDidDelete(handler),
			dispose: () => w.dispose(),
		}
	}
}

/** The VS Code host bridge (extension runtime). */
export function createVsCodeHost(): HostBridge {
	return {
		notifier: new VsCodeNotifier(),
		fs: new NodeFileSystem(),
		config: new VsCodeConfig(),
		env: vsCodeEnv,
		lsp: new VsCodeLsp(),
		workspace: new VsCodeWorkspace(),
		watcher: new VsCodeWatcher(),
	}
}

// The host registry lives in `@shofer/types` (a vscode-free package) so the
// portable core can import `getHost()` without pulling in this VS Code adapter.
// Re-exported here for adapter-side callers (extension activation, tests).
export { getHost, setHost } from "@shofer/types"
