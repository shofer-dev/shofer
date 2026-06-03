/**
 * SlangVisualizationProvider — renders a .slang file as an interactive
 * diagram in a VS Code webview panel (middle-column editor area).
 *
 * The panel parses the currently open .slang file using the existing
 * parseSlang + validateSlangAST pipeline and renders a visual
 * representation with:
 *  - Flow header (name, params, converge, budget)
 *  - Agent cards showing mode, role, operations
 *  - Message-flow arrows between stake → recipients and await ← sources
 *  - Real-time refresh when the editor document changes
 *
 * Design: self-contained inline HTML/CSS/JS (no webview-ui build step),
 * matching the pattern established by AssistantAgentChatProvider.
 */

import * as fs from "fs"
import * as vscode from "vscode"
import * as path from "path"

import { parseSlang, validateSlangAST } from "../workflow/slang-parser"
import { outputError, outputLog } from "../../utils/outputChannelLogger"
import type { Program, FlowDecl } from "../workflow/slang-ast"

// ─── Render script + stylesheet (loaded from external files) ───────────

const RENDER_SCRIPT = fs.readFileSync(path.join(__dirname, "slang-render.js"), "utf-8")

const CSS = fs.readFileSync(path.join(__dirname, "slang-render.css"), "utf-8")

// ─── Public entry points ───────────────────────────────────────────────

export function showSlangVisualization(extensionUri: vscode.Uri): void {
	const existing = SlangVisualizationPanel.current
	if (existing) {
		existing.reveal()
		existing.refreshFromActiveEditor()
		return
	}
	SlangVisualizationPanel.createOrShow(extensionUri)
}

export async function showSlangVisualizationForFile(extensionUri: vscode.Uri, fileUri?: vscode.Uri): Promise<void> {
	const existing = SlangVisualizationPanel.current
	if (existing) {
		existing.reveal()
		if (fileUri) {
			await existing.setSourceUri(fileUri)
		}
		return
	}
	SlangVisualizationPanel.createOrShow(extensionUri, fileUri)
}

// ─── Panel class ────────────────────────────────────────────────────────

class SlangVisualizationPanel {
	static current: SlangVisualizationPanel | undefined

	private readonly _panel: vscode.WebviewPanel
	private readonly _disposables: vscode.Disposable[] = []
	private readonly _extensionUri: vscode.Uri
	private _sourceUri: vscode.Uri | undefined

	static createOrShow(extensionUri: vscode.Uri, sourceUri?: vscode.Uri): void {
		const panel = vscode.window.createWebviewPanel(
			"shofer.slangVisualization",
			"Slang Visualization",
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
		)
		SlangVisualizationPanel.current = new SlangVisualizationPanel(panel, extensionUri, sourceUri)
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, sourceUri?: vscode.Uri) {
		this._panel = panel
		this._extensionUri = extensionUri
		this._sourceUri = sourceUri
		this._disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this._onActiveEditorChanged()))
		this._disposables.push(
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (this._sourceUri && doc.uri.fsPath === this._sourceUri.fsPath) {
					this._renderFromContent(doc.getText())
				}
			}),
		)
		this._panel.onDidDispose(() => this._dispose(), null, this._disposables)
		this.refreshFromActiveEditor()
	}

	reveal(): void {
		this._panel.reveal()
	}

	async setSourceUri(uri: vscode.Uri): Promise<void> {
		this._sourceUri = uri
		const doc = await vscode.workspace.openTextDocument(uri)
		this._renderFromContent(doc.getText())
	}

	refreshFromActiveEditor(): void {
		const editor = vscode.window.activeTextEditor
		if (editor && editor.document.fileName.endsWith(".slang")) {
			this._sourceUri = editor.document.uri
			this._renderFromContent(editor.document.getText())
		} else if (this._sourceUri) {
			vscode.workspace.openTextDocument(this._sourceUri).then((doc) => {
				this._renderFromContent(doc.getText())
			})
		} else {
			this._panel.webview.html = this._buildEmptyHtml()
		}
	}

	private _onActiveEditorChanged(): void {
		const editor = vscode.window.activeTextEditor
		if (editor && editor.document.fileName.endsWith(".slang")) {
			this._sourceUri = editor.document.uri
			this._renderFromContent(editor.document.getText())
		}
	}

	private _renderFromContent(source: string): void {
		const result = parseSlang(source)
		const warnings = result.errors.length > 0 ? [] : validateSlangAST(result.ast)
		const diags = [...result.errors, ...warnings]
		const flow = result.ast.flows[0]
		const fileName = this._sourceUri ? path.basename(this._sourceUri.fsPath) : (flow?.name ?? "unknown")

		// Log to output channel for diagnostics.
		outputLog(`[Slang] Rendering ${fileName}...`)
		outputLog(`[Slang] Source length: ${source.length} chars`)
		outputLog(`[Slang] Parse errors: ${result.errors.length}`)
		outputLog(`[Slang] Validation warnings: ${warnings.length}`)
		outputLog(`[Slang] Flows found: ${result.ast.flows.length}`)
		if (flow) {
			const agents = flow.body.filter((b) => b.type === "AgentDecl")
			outputLog(`[Slang] Agents found: ${agents.length}`)
			for (const a of agents) {
				const agent = a as any
				outputLog(`[Slang]   - @${agent.name}: ${agent.operations?.length ?? 0} operations`)
			}
		}

		if (result.errors.length > 0) {
			outputError(`[Slang] Parse errors in ${fileName}:`)
			for (const e of result.errors) outputError(`  ${e}`)
		}
		if (warnings.length > 0) {
			outputLog(`[Slang] Validation warnings in ${fileName}:`)
			for (const w of warnings) outputLog(`  ${w}`)
		}
		if (result.errors.length === 0 && warnings.length === 0) {
			outputLog(
				`[Slang] Parsed ${fileName} successfully (${flow?.body.filter((b) => b.type === "AgentDecl").length ?? 0} agents, ${diags.length} diagnostics).`,
			)
		}

		if (!flow) {
			// Render an error page with diagnostics instead of the generic empty state.
			this._panel.title = "Slang: Parse Error"
			this._panel.webview.html = this._buildErrorHtml(fileName, diags)
			return
		}

		this._panel.title = "Slang: " + fileName
		const payload = { type: "render" as const, fileName: fileName, flow: stripSpans(flow), diags }
		this._panel.webview.html = this._buildHtml(payload)
	}

	private _buildEmptyHtml(): string {
		const nonce = makeNonce()
		const csp = buildCsp(this._panel.webview.cspSource, nonce)
		return (
			'<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="' +
			csp +
			'">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Slang Visualization</title>\n<style>\n  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }\n  .empty { text-align: center; opacity: 0.5; max-width: 400px; }\n  .empty h2 { margin: 0 0 8px; }\n  .empty p { margin: 0; }\n</style>\n</head>\n<body>\n<div class="empty">\n  <h2>No .slang file open</h2>\n  <p>Open a .slang file in the editor to see its visualization.</p>\n</div>\n</body>\n</html>'
		)
	}

	private _buildErrorHtml(fileName: string, diags: string[]): string {
		const nonce = makeNonce()
		const csp = buildCsp(this._panel.webview.cspSource, nonce)
		const safeName = escapeHtml(fileName)
		const diagItems = diags
			.map((d) => {
				const isErr = d.toLowerCase().includes("error")
				const cls = isErr ? "z-error" : "z-warning"
				const tag = isErr ? "ERROR" : "WARN"
				return `<div class="diag-item ${cls}"><span class="diag-tag">${tag}</span>${escapeHtml(d)}</div>`
			})
			.join("")
		return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Slang — Parse Error: ${safeName}</title>\n<style>\n  :root { --z-err: var(--vscode-errorForeground, #f87171); --z-warn: var(--vscode-charts-yellow, #eab308); --z-bg: var(--vscode-editor-background, #1e1e1e); --z-fg: var(--vscode-foreground, #d4d4d4); --z-card-bg: var(--vscode-editorWidget-background, rgba(255,255,255,0.04)); }\n  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--z-fg); background: var(--z-bg); margin: 0; padding: 24px; }\n  .error-header { border-left: 4px solid var(--z-err); background: var(--z-card-bg); border-radius: 6px; padding: 14px 18px; margin-bottom: 16px; }\n  .error-header h2 { margin: 0 0 4px; font-size: 1.1em; color: var(--z-err); }\n  .error-header p { margin: 0; font-size: 0.92em; opacity: 0.7; }\n  .diag-item { padding: 6px 14px; border-left: 4px solid var(--z-err); margin-bottom: 4px; font-size: 0.85em; background: var(--z-card-bg); border-radius: 0 4px 4px 0; }\n  .diag-item.z-warning { border-left-color: var(--z-warn); }\n  .diag-item .diag-tag { font-weight: 600; margin-right: 8px; }\n  .diag-item.z-error .diag-tag { color: var(--z-err); }\n  .diag-item.z-warning .diag-tag { color: var(--z-warn); }\n</style>\n</head>\n<body>\n<div class="error-header">\n  <h2>❌ Parse Error${safeName ? ": " + safeName : ""}</h2>\n  <p>The .slang file could not be parsed. Fix the errors below:</p>\n</div>\n<div class="diag-section">${diagItems || '<div class="diag-item z-warning"><span class="diag-tag">WARN</span>No diagnostics available.</div>'}</div>\n</body>\n</html>`
	}

	private _buildHtml(payload: any): string {
		const nonce = makeNonce()
		const csp = buildCsp(this._panel.webview.cspSource, nonce)
		const jsonPayload = JSON.stringify(payload)
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e")
			.replace(/&/g, "\\u0026")
		const safeTitle = escapeHtml(payload.fileName)

		return (
			'<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="' +
			csp +
			'">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Slang Visualization — ' +
			safeTitle +
			"</title>\n<style>" +
			CSS +
			'</style>\n</head>\n<body>\n<div id="app"></div>\n<div id="diags" class="diag-section"></div>\n<script nonce="' +
			nonce +
			'">\n(function () {\n  "use strict";\n  var __payload = ' +
			jsonPayload +
			";\n  " +
			RENDER_SCRIPT +
			"\n  safeRender(__payload);\n})();\n</script>\n</body>\n</html>"
		)
	}

	private _dispose(): void {
		SlangVisualizationPanel.current = undefined
		while (this._disposables.length) {
			try {
				this._disposables.pop()?.dispose()
			} catch {
				/* best-effort */
			}
		}
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeNonce(): string {
	let text = ""
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length))
	return text
}

function buildCsp(cspSource: string, nonce: string): string {
	return (
		"default-src 'none'; style-src " +
		cspSource +
		" 'unsafe-inline'; script-src 'nonce-" +
		nonce +
		"'; img-src " +
		cspSource +
		" data:; font-src " +
		cspSource
	)
}

function escapeHtml(s: string): string {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function stripSpans(obj: any): any {
	if (obj === null || obj === undefined) return obj
	if (Array.isArray(obj)) return obj.map(stripSpans)
	if (typeof obj === "object") {
		const out: Record<string, any> = {}
		for (const key of Object.keys(obj)) {
			if (key === "span") continue
			out[key] = stripSpans(obj[key])
		}
		return out
	}
	return obj
}
