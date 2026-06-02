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

import * as vscode from "vscode"
import * as path from "path"

import { parseSlang, validateSlangAST } from "../workflow/slang-parser"
import type { Program, FlowDecl } from "../workflow/slang-ast"

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
		if (!flow) {
			this._panel.webview.html = this._buildEmptyHtml()
			return
		}
		const title = this._sourceUri ? path.basename(this._sourceUri.fsPath) : flow.name
		this._panel.title = "Slang: " + title
		const payload = { type: "render" as const, fileName: title, flow: stripSpans(flow), diags }
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
			"\n  render(__payload);\n})();\n</script>\n</body>\n</html>"
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

// ─── CSS ─────────────────────────────────────────────────────────────────

const CSS =
	"\\n" +
	"  :root {\\n" +
	"    --z-flow: var(--vscode-charts-blue, #3b82f6);\\n" +
	"    --z-agent: var(--vscode-charts-green, #22c55e);\\n" +
	"    --z-stake: var(--vscode-charts-orange, #f59e0b);\\n" +
	"    --z-await: var(--vscode-charts-purple, #a855f7);\\n" +
	"    --z-escalate: var(--vscode-charts-yellow, #eab308);\\n" +
	"    --z-control: var(--vscode-charts-blue, #3b82f6);\\n" +
	"    --z-meta: var(--vscode-descriptionForeground, #888);\\n" +
	"    --z-err: var(--vscode-errorForeground, #f87171);\\n" +
	"    --z-warn: var(--vscode-charts-yellow, #eab308);\\n" +
	"    --z-bg: var(--vscode-editor-background, #1e1e1e);\\n" +
	"    --z-fg: var(--vscode-foreground, #d4d4d4);\\n" +
	"    --z-card-bg: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));\\n" +
	"    --z-card-border: var(--vscode-widget-border, #3c3c3c);\\n" +
	"    --z-code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));\\n" +
	"    --z-bq-bg: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.05));\\n" +
	"  }\\n" +
	"  * { box-sizing: border-box; }\\n" +
	"  body {\\n" +
	"    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);\\n" +
	"    color: var(--z-fg); background: var(--z-bg);\\n" +
	"    margin: 0; padding: 20px 24px; line-height: 1.45;\\n" +
	"  }\\n" +
	"  .flow-header {\\n" +
	"    border-left: 4px solid var(--z-flow); background: var(--z-card-bg);\\n" +
	"    border-radius: 6px; padding: 14px 18px; margin-bottom: 24px;\\n" +
	"  }\\n" +
	"  .flow-header h2 { margin: 0 0 8px; font-size: 1.2em; display: flex; align-items: center; gap: 8px; }\\n" +
	"  .flow-header .params { font-size: 0.85em; color: var(--z-meta); margin-bottom: 8px; }\\n" +
	"  .flow-header .params code {\\n" +
	"    color: var(--z-fg); font-size: 0.95em;\\n" +
	"    background: var(--z-code-bg); padding: 1px 6px; border-radius: 3px; margin: 0 2px;\\n" +
	"  }\\n" +
	"  .flow-header .constraints { font-size: 0.85em; color: var(--z-meta); display: flex; gap: 20px; flex-wrap: wrap; }\\n" +
	"  .flow-header .constraints .badge {\\n" +
	"    background: var(--z-code-bg); padding: 1px 8px; border-radius: 3px;\\n" +
	"    font-family: var(--vscode-editor-font-family); font-size: 0.92em; color: var(--z-fg);\\n" +
	"  }\\n" +
	"  .agents-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 20px; }\\n" +
	"  .agent-card {\\n" +
	"    border: 1px solid var(--z-card-border); border-radius: 8px; overflow: hidden;\\n" +
	"    background: var(--z-card-bg); transition: border-color 0.2s;\\n" +
	"  }\\n" +
	"  .agent-card:hover { border-color: var(--z-agent); }\\n" +
	"  .agent-card-header {\\n" +
	"    padding: 10px 14px; background: var(--z-code-bg);\\n" +
	"    border-bottom: 1px solid var(--z-card-border);\\n" +
	"    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;\\n" +
	"  }\\n" +
	"  .agent-card-header .agent-name { font-weight: 700; font-size: 1.05em; color: var(--z-agent); }\\n" +
	"  .agent-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-left: auto; }\\n" +
	"  .agent-tag {\\n" +
	"    font-size: 0.72em; padding: 1px 7px; border-radius: 3px;\\n" +
	"    background: var(--z-code-bg); color: var(--z-meta); white-space: nowrap;\\n" +
	"  }\\n" +
	"  .agent-tag.z-mode { border: 1px solid var(--z-agent); color: var(--z-agent); }\\n" +
	"  .agent-tag.z-model { border: 1px solid var(--z-flow); color: var(--z-flow); }\\n" +
	"  .agent-tag.z-tools { border: 1px solid var(--z-stake); color: var(--z-stake); }\\n" +
	"  .agent-tag.z-retry { border: 1px solid var(--z-warn); color: var(--z-warn); }\\n" +
	"  .agent-card-role {\\n" +
	"    padding: 6px 14px; font-size: 0.82em; color: var(--z-meta);\\n" +
	"    font-style: italic; border-bottom: 1px solid var(--z-card-border);\\n" +
	"  }\\n" +
	"  .agent-card-ops { padding: 4px 0; }\\n" +
	"  .op-row {\\n" +
	"    display: flex; align-items: flex-start; gap: 6px;\\n" +
	"    padding: 5px 14px; border-left: 3px solid transparent;\\n" +
	"    font-size: 0.88em; transition: background 0.15s;\\n" +
	"  }\\n" +
	"  .op-row:hover { background: var(--z-bq-bg); }\\n" +
	"  .op-row.z-stake  { border-left-color: var(--z-stake); }\\n" +
	"  .op-row.z-await  { border-left-color: var(--z-await); }\\n" +
	"  .op-row.z-commit { border-left-color: var(--z-agent); }\\n" +
	"  .op-row.z-escalate { border-left-color: var(--z-escalate); }\\n" +
	"  .op-row.z-let, .op-row.z-set { border-left-color: var(--z-meta); }\\n" +
	"  .op-row.z-when, .op-row.z-repeat { border-left-color: var(--z-control); font-weight: 600; }\\n" +
	"  .op-icon { width: 18px; text-align: center; flex-shrink: 0; font-weight: bold; font-size: 0.85em; }\\n" +
	"  .op-row.z-stake .op-icon  { color: var(--z-stake); }\\n" +
	"  .op-row.z-await .op-icon  { color: var(--z-await); }\\n" +
	"  .op-row.z-commit .op-icon { color: var(--z-agent); }\\n" +
	"  .op-row.z-escalate .op-icon { color: var(--z-escalate); }\\n" +
	"  .op-row.z-when .op-icon, .op-row.z-repeat .op-icon { color: var(--z-control); }\\n" +
	"  .op-row.z-let .op-icon, .op-row.z-set .op-icon { color: var(--z-meta); }\\n" +
	"  .op-detail { flex: 1; min-width: 0; }\\n" +
	"  .op-detail .kw { font-weight: 600; }\\n" +
	"  .op-detail .fn { color: var(--vscode-textLink-foreground, #4daafc); font-family: var(--vscode-editor-font-family); }\\n" +
	"  .op-detail .ex { opacity: 0.85; font-family: var(--vscode-editor-font-family); font-size: 0.93em; word-break: break-word; }\\n" +
	"  .op-detail .out-schema { font-size: 0.82em; color: var(--z-meta); margin-top: 2px; font-family: var(--vscode-editor-font-family); }\\n" +
	"  .op-detail .out-schema .sk { color: var(--z-await); }\\n" +
	"  .op-detail .out-schema .st { opacity: 0.7; }\\n" +
	"  .route-badges { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }\\n" +
	"  .rb { font-size: 0.75em; padding: 1px 7px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-weight: 600; white-space: nowrap; }\\n" +
	"  .rb-out { background: rgba(240,173,78,0.25); color: var(--z-stake); }\\n" +
	"  .rb-out-special { background: rgba(240,173,78,0.4); color: var(--z-stake); }\\n" +
	"  .rb-in  { background: rgba(168,85,247,0.25); color: var(--z-await); }\\n" +
	"  .rb-in-special { background: rgba(168,85,247,0.4); color: var(--z-await); }\\n" +
	"  .rb-human { background: rgba(234,179,8,0.3); color: var(--z-escalate); }\\n" +
	"  .op-detail .cond { font-size: 0.82em; color: var(--z-meta); font-style: italic; margin-top: 2px; }\\n" +
	"  .op-row.n1 { padding-left: 30px; }\\n" +
	"  .op-row.n2 { padding-left: 44px; }\\n" +
	"  .op-row.n3 { padding-left: 58px; }\\n" +
	"  .diag-section { margin-top: 24px; }\\n" +
	"  .diag-item {\\n" +
	"    padding: 6px 14px; border-left: 4px solid var(--z-err);\\n" +
	"    margin-bottom: 4px; font-size: 0.85em;\\n" +
	"    background: var(--z-card-bg); border-radius: 0 4px 4px 0;\\n" +
	"  }\\n" +
	"  .diag-item.z-warning { border-left-color: var(--z-warn); }\\n" +
	"  .diag-item .diag-tag { font-weight: 600; margin-right: 8px; }\\n" +
	"  .diag-item.z-error .diag-tag { color: var(--z-err); }\\n" +
	"  .diag-item.z-warning .diag-tag { color: var(--z-warn); }\\n" +
	"  .flow-arrows { margin: 16px 0; padding: 10px 14px; background: var(--z-code-bg); border-radius: 6px; }\\n" +
	"  .flow-arrows > span { font-weight: 600; font-size: 0.85em; color: var(--z-meta); cursor: pointer; }\\n" +
	"  .flow-arrows .arrow-list { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }\\n" +
	"  .arrow-item {\\n" +
	"    font-size: 0.82em; padding: 3px 10px; border-radius: 4px;\\n" +
	"    background: var(--z-card-bg); border: 1px solid var(--z-card-border);\\n" +
	"    font-family: var(--vscode-editor-font-family);\\n" +
	"  }\\n" +
	"  .arrow-item .from { color: var(--z-agent); font-weight: 600; }\\n" +
	"  .arrow-item .to { color: var(--z-stake); font-weight: 600; }\\n" +
	"  .arrow-item .sep { color: var(--z-meta); margin: 0 4px; }\\n" +
	"  @media (max-width: 440px) { .agents-grid { grid-template-columns: 1fr; } body { padding: 12px; } }\\n"

// ─── Render script ──────────────────────────────────────────────────────

const RENDER_SCRIPT = [
	"// escape",
	"function esc(s){",
	"  return String(s).replace(/&/g,'\x26amp;').replace(/</g,'\x26lt;').replace(/>/g,'\x26gt;').replace(/\"/g,'\x26quot;');",
	"}",
	"// expr",
	"function exprStr(e){",
	"  if(!e)return'?';",
	"  switch(e.type){",
	"    case'NumberLit':return String(e.value);",
	"    case'StringLit':return'\"'+e.value.replace(/\"/g,'\\\\\"')+'\"';",
	"    case'BoolLit':return String(e.value);",
	"    case'Ident':return e.name;",
	"    case'AgentRef':return'@'+e.name;",
	"    case'ListLit':return'['+(e.elements||[]).map(exprStr).join(', ')+']';",
	"    case'DotAccess':return exprStr(e.object)+'.'+e.property;",
	"    case'BinaryExpr':return exprStr(e.left)+' '+e.op+' '+exprStr(e.right);",
	"    default:return String(e.type);",
	"  }",
	"}",
	"function exprShort(e,m){",
	"  m=m||40;var s=exprStr(e);",
	"  if(s.length>m)return s.slice(0,m)+'\\u2026';",
	"  return s;",
	"}",
	"// routes",
	"function renderRoutes(rec,kind){",
	"  var h=' <span class=\"route-badges\">';",
	"  for(var i=0;i<rec.length;i++){",
	"    var r=rec[i],ref=r.ref||r,c='rb';",
	"    if(kind==='out')c+=ref==='out'||ref==='all'?' rb-out-special':' rb-out';",
	"    else c+=ref==='any'||ref==='*'?' rb-in-special':' rb-in';",
	"    if(ref==='Human')c+=' rb-human';",
	"    h+='<span class=\"'+c+'\">'+(kind==='out'?'→':'←')+' @'+esc(ref)+'</span>';",
	"  }",
	"  return h+'</span>';",
	"}",
	"function renderSources(srcs){",
	"  var h='<span class=\"route-badges\">';",
	"  for(var i=0;i<srcs.length;i++){",
	"    var s=srcs[i],ref=s.ref||s,c='rb';",
	"    c+=ref==='any'||ref==='*'?' rb-in-special':' rb-in';",
	"    if(ref==='Human')c+=' rb-human';",
	"    h+='<span class=\"'+c+'\">← @'+esc(ref)+'</span>';",
	"  }",
	"  return h+'</span>';",
	"}",
	"// helpers",
	"function H(kw,fn,extra){",
	"  return '<span class=\"kw\">'+esc(kw)+'</span>'+(fn?' <span class=\"fn\">'+esc(fn)+'</span>':'')+(extra||'');",
	"}",
	"function HE(kw,ex){",
	"  return '<span class=\"kw\">'+esc(kw)+'</span> <span class=\"ex\">'+exprShort(ex,40)+'</span>';",
	"}",
	"// renderOp",
	"function renderOp(op,depth){",
	"  depth=depth||0;",
	"  var cls='',icon='',html='';",
	"  switch(op.type){",
	"    case'StakeOp':",
	"      cls='z-stake';icon='→';",
	"      html=H('stake',op.call.name);",
	"      if(op.call.args&&op.call.args.length>0){",
	"        html+='('+op.call.args.map(function(a){",
	"          var p=a.name?a.name+': ':'';",
	"          return p+exprShort(a.value,30);",
	"        }).join(', ')+')';",
	"      }else html+='()';",
	"      if(op.recipients&&op.recipients.length>0)html+=renderRoutes(op.recipients,'out');",
	"      if(op.condition){html+=' <span class=\"cond\">if '+exprShort(op.condition,30)+'</span>';}",
	"      if(op.output&&op.output.fields){",
	"        html+=' <span class=\"out-schema\">output: {'+",
	"          op.output.fields.map(function(f){",
	"            return'<span class=\"sk\">'+esc(f.name)+'</span>: <span class=\"st\">'+esc(f.fieldType)+'</span>';",
	"          }).join(', ')+'}</span>';",
	"      }",
	"      break;",
	"    case'AwaitOp':",
	"      cls='z-await';icon='←';",
	"      html=H('await',op.binding);",
	"      if(op.sources&&op.sources.length>0)html+=' '+renderSources(op.sources);",
	"      break;",
	"    case'CommitOp':",
	"      cls='z-commit';icon='✓';",
	"      html=H('commit',null);",
	"      if(op.value)html+=' <span class=\"ex\">'+exprShort(op.value,40)+'</span>';",
	"      if(op.condition)html+=' <span class=\"cond\">if '+exprShort(op.condition,30)+'</span>';",
	"      break;",
	"    case'EscalateOp':",
	"      cls='z-escalate';icon='⚑';",
	"      html=H('escalate','@'+op.target);",
	"      if(op.reason)html+=' reason: <span class=\"ex\">\"'+esc(op.reason.slice(0,60))+'\"</span>';",
	"      if(op.condition)html+=' <span class=\"cond\">if '+exprShort(op.condition,30)+'</span>';",
	"      break;",
	"    case'WhenBlock':",
	"      cls='z-when n'+depth;icon='';",
	"      html=HE('when',op.condition)+' {';",
	"      if(op.body){",
	"        for(var wi=0;wi<op.body.length;wi++){",
	"          html+='</div></div><div class=\"op-row '+cls+'\">'+renderOp(op.body[wi],depth+1);",
	"        }",
	"      }",
	"      if(op.elseBlock&&op.elseBlock.body){",
	'        html+=\'</div></div><div class="op-row \'+cls+\'"><div class="op-icon"></div><div class="op-detail"><span class="kw">otherwise</span> {\';',
	"        for(var ej=0;ej<op.elseBlock.body.length;ej++){",
	"          html+='</div></div><div class=\"op-row '+cls+'\">'+renderOp(op.elseBlock.body[ej],depth+1);",
	"        }",
	"      }",
	'      html+=\'</div></div><div class="op-row \'+cls+\'"><div class="op-icon"></div><div class="op-detail">}\';',
	"      return'<div class=\"op-icon\">'+icon+'</div><div class=\"op-detail\">'+html;",
	"    case'RepeatBlock':",
	"      cls='z-repeat n'+depth;icon='';",
	"      html=HE('repeat until',op.condition)+' {';",
	"      if(op.body){",
	"        for(var rk=0;rk<op.body.length;rk++){",
	"          html+='</div></div><div class=\"op-row '+cls+'\">'+renderOp(op.body[rk],depth+1);",
	"        }",
	"      }",
	'      html+=\'</div></div><div class="op-row \'+cls+\'"><div class="op-icon"></div><div class="op-detail">}\';',
	"      return'<div class=\"op-icon\">'+icon+'</div><div class=\"op-detail\">'+html;",
	"    case'LetOp':",
	"      cls='z-let';icon='=';",
	"      html='<span class=\"kw\">let</span> <span class=\"fn\">'+esc(op.name)+'</span> = <span class=\"ex\">'+exprShort(op.value,30)+'</span>';",
	"      break;",
	"    case'SetOp':",
	"      cls='z-set';icon='≔';",
	"      html='<span class=\"kw\">set</span> <span class=\"fn\">'+esc(op.name)+'</span> = <span class=\"ex\">'+exprShort(op.value,30)+'</span>';",
	"      break;",
	"    default:",
	"      cls='';icon='?';",
	"      html='<span class=\"kw\">'+esc(op.type)+'</span>';",
	"  }",
	"  return'<div class=\"op-icon\">'+icon+'</div><div class=\"op-detail\">'+html;",
	"}",
	"// arrows",
	"function buildFlowArrows(flow){",
	"  var arrows=[];",
	"  for(var ai=0;ai<(flow.body||[]).length;ai++){",
	"    var item=flow.body[ai];",
	"    if(item.type!=='AgentDecl')continue;",
	"    var from=item.name;",
	"    function walkOps(ops){",
	"      if(!ops)return;",
	"      for(var i=0;i<ops.length;i++){",
	"        var op=ops[i];",
	"        if(op.type==='StakeOp'&&op.recipients){",
	"          for(var j=0;j<op.recipients.length;j++){",
	"            var r=op.recipients[j],to=r.ref||r;",
	"            if(to==='out'||to==='all')continue;",
	"            arrows.push({from:from,to:to,label:op.call?op.call.name:'stake'});",
	"          }",
	"        }",
	"        if(op.type==='WhenBlock'){walkOps(op.body);if(op.elseBlock)walkOps(op.elseBlock.body);}",
	"        if(op.type==='RepeatBlock')walkOps(op.body);",
	"      }",
	"    }",
	"    walkOps(item.operations);",
	"  }",
	"  return arrows;",
	"}",
	"// render",
	"function render(payload){",
	"  var flow=payload.flow,diags=payload.diags||[];",
	"  var app=document.getElementById('app');",
	"  var diagsEl=document.getElementById('diags');",
	"  if(!flow){app.innerHTML='<div class=\"empty\"><h2>No flow found</h2></div>';return;}",
	"  // header",
	"  var h='<div class=\"flow-header\"><h2><span>⚡</span> flow \"'+esc(flow.name)+'\"</h2>';",
	"  if(flow.params&&flow.params.length>0){",
	"    h+='<div class=\"params\">Params: ';",
	"    for(var i=0;i<flow.params.length;i++){",
	"      var p=flow.params[i];",
	"      h+='<code>'+esc(p.name)+': \"'+esc(p.paramType)+'\"</code>';",
	"      if(i<flow.params.length-1)h+=', ';",
	"    }",
	"    h+='</div>';",
	"  }",
	"  h+='<div class=\"constraints\">';",
	"  var hasCon=false,hasBud=false;",
	"  for(var bi=0;bi<(flow.body||[]).length;bi++){",
	"    var bItem=flow.body[bi];",
	"    if(bItem.type==='ConvergeStmt'){",
	"      hasCon=true;",
	"      h+='<span>🎯 Converge when: <span class=\"badge\">'+esc(exprStr(bItem.condition))+'</span></span>';",
	"    }",
	"    if(bItem.type==='BudgetStmt'&&bItem.items){",
	"      hasBud=true;",
	"      for(var bj=0;bj<bItem.items.length;bj++){",
	"        var bi2=bItem.items[bj];",
	"        h+='<span>💰 '+esc(bi2.kind)+': <span class=\"badge\">'+esc(exprStr(bi2.value))+'</span></span>';",
	"      }",
	"    }",
	"  }",
	"  if(!hasCon)h+='<span style=\"opacity:0.5\">No converge statement</span>';",
	"  if(!hasBud)h+='<span style=\"opacity:0.5\">Default budget (30 rounds, 300k tokens)</span>';",
	"  h+='</div></div>';",
	"  app.innerHTML=h;",
	"  // arrows",
	"  var arrows=buildFlowArrows(flow);",
	"  if(arrows.length>0){",
	"    var ah='<div class=\"flow-arrows\"><span>🔄 Message Flow ('+arrows.length+' edges)</span><div class=\"arrow-list\">';",
	"    for(var ai=0;ai<arrows.length;ai++){",
	"      var a=arrows[ai];",
	'      ah+=\'<div class="arrow-item"><span class="from">@\'+esc(a.from)+\'</span><span class="sep"> → </span><span class="to">@\'+esc(a.to)+\'</span> <span style="opacity:0.6">(\'+esc(a.label)+\')</span></div>\';',
	"    }",
	"    ah+='</div></div>';",
	"    app.innerHTML+=ah;",
	"  }",
	"  // agents",
	"  var grid='<div class=\"agents-grid\">';",
	"  for(var agi=0;agi<(flow.body||[]).length;agi++){",
	"    var agentItem=flow.body[agi];",
	"    if(agentItem.type!=='AgentDecl')continue;",
	"    var agent=agentItem;",
	'    grid+=\'<div class="agent-card"><div class="agent-card-header">\';',
	"    grid+='<span class=\"agent-name\">@'+esc(agent.name)+'</span><span class=\"agent-tags\">';",
	"    if(agent.meta){",
	"      if(agent.meta.mode)grid+='<span class=\"agent-tag z-mode\">mode: '+esc(agent.meta.mode)+'</span>';",
	"      if(agent.meta.model)grid+='<span class=\"agent-tag z-model\">model: '+esc(agent.meta.model)+'</span>';",
	"      if(agent.meta.tools&&agent.meta.tools.length>0)grid+='<span class=\"agent-tag z-tools\">tools: '+esc(agent.meta.tools.join(', '))+'</span>';",
	"      if(agent.meta.retry!=null)grid+='<span class=\"agent-tag z-retry\">retry: '+esc(String(agent.meta.retry))+'</span>';",
	"    }",
	"    grid+='</span></div>';",
	"    if(agent.meta&&agent.meta.role){",
	"      grid+='<div class=\"agent-card-role\" title=\"'+esc(agent.meta.role)+'\">'+esc(agent.meta.role.slice(0,120))+'</div>';",
	"    }",
	"    grid+='<div class=\"agent-card-ops\">';",
	"    var ops=agent.operations||[];",
	"    for(var opi=0;opi<ops.length;opi++){grid+='<div class=\"op-row\">'+renderOp(ops[opi],0)+'</div>';}",
	"    grid+='</div></div>';",
	"  }",
	"  grid+='</div>';",
	"  app.innerHTML+=grid;",
	"  // diags",
	"  if(diags.length>0){",
	"    var dHtml='';",
	"    for(var di=0;di<diags.length;di++){",
	"      var d=diags[di],isErr=d.indexOf('[error]')!==-1;",
	"      dHtml+='<div class=\"diag-item'+(isErr?' z-error':' z-warning')+'\"><span class=\"diag-tag\">'+(isErr?'ERROR':'WARN')+'</span>'+esc(d)+'</div>';",
	"    }",
	"    diagsEl.innerHTML=dHtml;",
	"  }else{diagsEl.innerHTML='';}",
	"}",
].join("\n")
