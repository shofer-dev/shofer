/**
 * SlangEditorProvider — CustomTextEditorProvider for `.slang` files.
 *
 * When a `.slang` file is opened (double-click in Explorer, click in tab),
 * VS Code calls resolveCustomTextEditor() which renders the Slang visualization
 * as self-contained inline HTML.
 *
 * Design: self-contained inline HTML/CSS/JS (no webview-ui build step).
 * Dagre and the render script are loaded as external scripts via webview URIs.
 * On document changes the provider sends a postMessage payload rather than
 * rebuilding the entire webview, preserving the user's active view, zoom, and
 * drag state.
 */

import * as crypto from "crypto"
import * as fs from "fs"
import * as vscode from "vscode"
import * as path from "path"

import { parseSlang, validateSlangAST } from "../workflow/slang-parser"
import { webviewLog } from "../../utils/logging/subsystems"
import type { FlowDecl } from "../workflow/slang-ast"

// ─── Stylesheet (loaded once at module scope) ────────────────────────────

const CSS = fs.readFileSync(path.join(__dirname, "slang-render.css"), "utf-8")

// ─── View type identifier (must match package.json customEditors) ───────

const VIEW_TYPE = "shofer.slangEditor"

// ─── Debounce interval for document-change re-renders ────────────────────

const RENDER_DEBOUNCE_MS = 250

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

		// Resolve external scripts as webview URIs so the sandboxed webview can load them.
		const dagreUri = webviewPanel.webview.asWebviewUri(
			vscode.Uri.joinPath(this._context.extensionUri, "dist", "dagre.min.js"),
		)
		const renderScriptUri = webviewPanel.webview.asWebviewUri(
			vscode.Uri.joinPath(this._context.extensionUri, "dist", "slang-render.js"),
		)

		// Build the HTML shell once — the render script stays loaded for the
		// lifetime of the webview. Subsequent document edits deliver payloads
		// via postMessage so the user's view/zoom/drag state is preserved.
		const source = document.getText()
		const fileName = path.basename(document.fileName)
		const result = parseSlang(source)
		const warnings = result.errors.length > 0 ? [] : validateSlangAST(result.ast)
		const diags = [...result.errors, ...warnings]
		const flow = result.ast.flows[0]

		if (!flow) {
			webviewPanel.title = "Slang: Parse Error"
			webviewPanel.webview.html = this._buildErrorHtml(
				fileName,
				diags,
				buildCsp(webviewPanel.webview.cspSource, makeNonce(), dagreUri, renderScriptUri),
			)
		} else {
			webviewPanel.title = ""
			const payload: RenderPayload = { type: "render", fileName, flow: stripSpans(flow), diags }
			webviewPanel.webview.html = this._buildHtml(
				fileName,
				payload,
				webviewPanel.webview,
				dagreUri,
				renderScriptUri,
			)
		}

		// Debounced document-change handler: on each keystroke we postMessage
		// the new payload so the in-page script patches the SVG in-place. When
		// the file has parse errors we fall back to a full HTML rebuild.
		let debounceTimer: ReturnType<typeof setTimeout> | undefined
		const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() !== document.uri.toString()) return
			if (debounceTimer) clearTimeout(debounceTimer)
			debounceTimer = setTimeout(() => {
				this._handleDocumentChange(
					webviewPanel,
					e.document.getText(),
					path.basename(document.fileName),
					dagreUri,
					renderScriptUri,
				)
			}, RENDER_DEBOUNCE_MS)
		})

		webviewPanel.onDidDispose(() => {
			if (debounceTimer) clearTimeout(debounceTimer)
			changeSubscription.dispose()
		})
	}

	// ─── Render helpers ─────────────────────────────────────────────────

	/**
	 * Called on every debounced document change.  For a well-formed file we
	 * postMessage the new payload to the live webview; for a file with parse
	 * errors we rebuild the full HTML so the error page is displayed.
	 */
	private _handleDocumentChange(
		panel: vscode.WebviewPanel,
		source: string,
		fileName: string,
		dagreUri: vscode.Uri,
		renderScriptUri: vscode.Uri,
	): void {
		const result = parseSlang(source)
		const warnings = result.errors.length > 0 ? [] : validateSlangAST(result.ast)
		const diags = [...result.errors, ...warnings]
		const flow = result.ast.flows[0]

		this._logDiagnostics(fileName, source, result, warnings, flow, diags)

		if (!flow) {
			// Parse errors → full rebuild so the error page renders correctly.
			panel.title = "Slang: Parse Error"
			panel.webview.html = this._buildErrorHtml(
				fileName,
				diags,
				buildCsp(panel.webview.cspSource, makeNonce(), dagreUri, renderScriptUri),
			)
			return
		}

		panel.title = ""
		const payload: RenderPayload = { type: "render", fileName, flow: stripSpans(flow), diags }
		panel.webview.postMessage(payload)
	}

	private _logDiagnostics(
		fileName: string,
		source: string,
		result: ReturnType<typeof parseSlang>,
		warnings: string[],
		flow: FlowDecl | undefined,
		diags: string[],
	): void {
		webviewLog.info(`[Slang] Rendering ${fileName}...`)
		webviewLog.info(`[Slang] Source length: ${source.length} chars`)
		webviewLog.info(`[Slang] Parse errors: ${result.errors.length}`)
		webviewLog.info(`[Slang] Validation warnings: ${warnings.length}`)
		webviewLog.info(`[Slang] Flows found: ${result.ast.flows.length}`)
		if (flow) {
			const agents = flow.body.filter((b: any) => b.type === "AgentDecl")
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
				`[Slang] Parsed ${fileName} successfully (${flow?.body.filter((b: any) => b.type === "AgentDecl").length ?? 0} agents, ${diags.length} diagnostics).`,
			)
		}
	}

	/**
	 * Build the full HTML page for the initial webview load.  The render
	 * script is loaded as an external `<script src="…">` (same pattern as
	 * dagre), and the initial payload is delivered via an inline script.
	 */
	private _buildHtml(
		fileName: string,
		payload: RenderPayload,
		webview: vscode.Webview,
		dagreUri: vscode.Uri,
		renderScriptUri: vscode.Uri,
	): string {
		const nonce = makeNonce()
		const csp = buildCsp(webview.cspSource, nonce, dagreUri, renderScriptUri)

		const jsonPayload = JSON.stringify(payload)
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e")
			.replace(/&/g, "\\u0026")

		return (
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
			'"></script>\n<script src="' +
			escapeHtml(renderScriptUri.toString()) +
			'" nonce="' +
			nonce +
			'"></script>\n<script nonce="' +
			nonce +
			'">\n(function () {\n  "use strict";\n  var __payload = ' +
			jsonPayload +
			";\n  safeRender(__payload);\n})();\n</script>\n</body>\n</html>"
		)
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

// ─── Types ───────────────────────────────────────────────────────────────

interface RenderPayload {
	type: "render"
	fileName: string
	flow: ReturnType<typeof stripSpans>
	diags: string[]
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Generate a CSP nonce using a cryptographically secure PRNG. */
function makeNonce(): string {
	return crypto.randomBytes(16).toString("base64")
}

function buildCsp(cspSource: string, nonce: string, dagreUri: vscode.Uri, renderScriptUri: vscode.Uri): string {
	return (
		"default-src 'none'; style-src " +
		cspSource +
		" 'unsafe-inline'; script-src " +
		dagreUri.toString() +
		" " +
		renderScriptUri.toString() +
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
