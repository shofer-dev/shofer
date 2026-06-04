/**
 * SlangEditorProvider — CustomTextEditorProvider for `.slang` files.
 *
 * Replaces the side-panel webview approach with a proper VS Code custom editor.
 * When a `.slang` file is opened (double-click in Explorer, click in tab),
 * VS Code calls resolveCustomTextEditor() which renders the Slang visualization
 * directly in the editor area — matching the pattern used by datathos-visualizations
 * for `.dtvis` files.
 *
 * Design: self-contained inline HTML/CSS/JS (no webview-ui build step).
 * Dagre is loaded as an external script via webview URI for graph layout.
 */

import * as fs from "fs"
import * as vscode from "vscode"
import * as path from "path"

import { parseSlang, validateSlangAST } from "../workflow/slang-parser"
import { webviewLog } from "../../utils/logging/subsystems"
import type { FlowDecl } from "../workflow/slang-ast"

// ─── Render script + stylesheet (loaded once at module scope) ───────────

const RENDER_SCRIPT = fs.readFileSync(path.join(__dirname, "slang-render.js"), "utf-8")

const CSS = fs.readFileSync(path.join(__dirname, "slang-render.css"), "utf-8")

// ─── View type identifier (must match package.json customEditors) ───────

const VIEW_TYPE = "shofer.slangEditor"

// ─── Provider class ──────────────────────────────────────────────────────

export class SlangEditorProvider implements vscode.CustomTextEditorProvider {
	static register(context: vscode.ExtensionContext): SlangEditorProvider {
		const provider = new SlangEditorProvider(context)
		const registration = vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
		context.subscriptions.push(registration)
		return provider
	}

	constructor(private readonly _context: vscode.ExtensionContext) {}

	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._context.extensionUri],
		}

		// Resolve dagre as webview URI so the sandboxed webview can load it.
		const dagreUri = webviewPanel.webview.asWebviewUri(
			vscode.Uri.joinPath(this._context.extensionUri, "dist", "dagre.min.js"),
		)

		// Initial render
		this._render(webviewPanel, document.getText(), path.basename(document.fileName), dagreUri)

		// Watch for document changes (both from source editor and external saves)
		const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() === document.uri.toString()) {
				this._render(webviewPanel, e.document.getText(), path.basename(document.fileName), dagreUri)
			}
		})

		webviewPanel.onDidDispose(() => {
			changeSubscription.dispose()
		})
	}

	// ─── Render helpers ─────────────────────────────────────────────────

	private _render(panel: vscode.WebviewPanel, source: string, fileName: string, dagreUri: vscode.Uri): void {
		const result = parseSlang(source)
		const warnings = result.errors.length > 0 ? [] : validateSlangAST(result.ast)
		const diags = [...result.errors, ...warnings]
		const flow = result.ast.flows[0]

		webviewLog.info(`[Slang] Rendering ${fileName}...`)
		webviewLog.info(`[Slang] Source length: ${source.length} chars`)
		webviewLog.info(`[Slang] Parse errors: ${result.errors.length}`)
		webviewLog.info(`[Slang] Validation warnings: ${warnings.length}`)
		webviewLog.info(`[Slang] Flows found: ${result.ast.flows.length}`)
		if (flow) {
			const agents = flow.body.filter((b) => b.type === "AgentDecl")
			webviewLog.info(`[Slang] Agents found: ${agents.length}`)
			for (const a of agents) {
				const agent = a as any
				webviewLog.info(`[Slang]   - @${agent.name}: ${agent.operations?.length ?? 0} operations`)
			}
		}

		if (result.errors.length > 0) {
			webviewLog.error(`[Slang] Parse errors in ${fileName}:`)
			for (const e of result.errors) webviewLog.error(`  ${e}`)
		}
		if (warnings.length > 0) {
			webviewLog.info(`[Slang] Validation warnings in ${fileName}:`)
			for (const w of warnings) webviewLog.info(`  ${w}`)
		}
		if (result.errors.length === 0 && warnings.length === 0) {
			webviewLog.info(
				`[Slang] Parsed ${fileName} successfully (${flow?.body.filter((b) => b.type === "AgentDecl").length ?? 0} agents, ${diags.length} diagnostics).`,
			)
		}

		const nonce = makeNonce()
		const csp = buildCsp(panel.webview.cspSource, nonce, dagreUri)

		if (!flow) {
			panel.title = "Slang: Parse Error"
			panel.webview.html = this._buildErrorHtml(fileName, diags, csp)
			return
		}

		panel.title = ""
		const payload = { type: "render" as const, fileName: fileName, flow: stripSpans(flow), diags }

		const jsonPayload = JSON.stringify(payload)
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e")
			.replace(/&/g, "\\u0026")

		panel.webview.html =
			'<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="' +
			csp +
			'">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Slang — ' +
			escapeHtml(fileName) +
			"</title>\n<style>" +
			CSS +
			'</style>\n</head>\n<body>\n<div id="app"></div>\n<div id="diags" class="diag-section"></div>\n<script src="' +
			escapeHtml(dagreUri.toString()) +
			'" nonce="' +
			nonce +
			'"></script>\n<script nonce="' +
			nonce +
			'">\n(function () {\n  "use strict";\n  var __payload = ' +
			jsonPayload +
			";\n  " +
			RENDER_SCRIPT +
			"\n  safeRender(__payload);\n})();\n</script>\n</body>\n</html>"
	}

	private _buildErrorHtml(fileName: string, diags: string[], csp: string): string {
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
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeNonce(): string {
	let text = ""
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length))
	return text
}

function buildCsp(cspSource: string, nonce: string, dagreUri: vscode.Uri): string {
	return (
		"default-src 'none'; style-src " +
		cspSource +
		" 'unsafe-inline'; script-src " +
		dagreUri.toString() +
		" 'nonce-" +
		nonce +
		"'; img-src " +
		cspSource +
		" data:; font-src " +
		cspSource
	)
}

function escapeHtml(s: string): string {
	return String(s)
		.replace(/&/g, String.fromCharCode(38) + "amp;")
		.replace(/</g, String.fromCharCode(38) + "lt;")
		.replace(/>/g, String.fromCharCode(38) + "gt;")
		.replace(/"/g, String.fromCharCode(38) + "quot;")
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
