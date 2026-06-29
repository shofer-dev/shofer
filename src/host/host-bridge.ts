import * as fs from "node:fs/promises"

import * as vscode from "vscode"
import type {
	HostBridge,
	HostConfig,
	HostDiagnostic,
	HostDiagnosticSeverity,
	HostEnv,
	HostFileSystem,
	HostLsp,
	HostReferencesResult,
	Notifier,
	NotifyChoiceOptions,
} from "@shofer/types"
import { createInMemoryHost } from "@shofer/types"

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
}

/** The VS Code host bridge (extension runtime). */
export function createVsCodeHost(): HostBridge {
	return {
		notifier: new VsCodeNotifier(),
		fs: new NodeFileSystem(),
		config: new VsCodeConfig(),
		env: vsCodeEnv,
		lsp: new VsCodeLsp(),
	}
}

// Module-level host accessor. Defaults to an in-memory host so call sites work in
// tests / before activation; the extension installs the VS Code host on activate.
let host: HostBridge = createInMemoryHost()

/** Install the active host bridge (call once at activation). */
export function setHost(bridge: HostBridge): void {
	host = bridge
}

/** The active host bridge. */
export function getHost(): HostBridge {
	return host
}
