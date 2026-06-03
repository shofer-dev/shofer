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
import { outputError, outputLog } from "../../utils/outputChannelLogger"
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

// ─── CSS ─────────────────────────────────────────────────────────────────

const CSS = `
  :root {
    --z-flow: var(--vscode-charts-blue, #3b82f6);
    --z-agent: var(--vscode-charts-green, #22c55e);
    --z-stake: var(--vscode-charts-orange, #f59e0b);
    --z-await: var(--vscode-charts-purple, #a855f7);
    --z-meta: var(--vscode-descriptionForeground, #888);
    --z-err: var(--vscode-errorForeground, #f87171);
    --z-warn: var(--vscode-charts-yellow, #eab308);
    --z-bg: var(--vscode-editor-background, #1e1e1e);
    --z-fg: var(--vscode-foreground, #d4d4d4);
    --z-card-bg: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));
    --z-card-border: var(--vscode-widget-border, #3c3c3c);
    --z-code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    --node-shad: rgba(0,0,0,0.45);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--z-fg); background: var(--z-bg);
    margin: 0; padding: 20px 24px; line-height: 1.45;
  }
  .flow-header {
    border-left: 4px solid var(--z-flow); background: var(--z-card-bg);
    border-radius: 6px; padding: 10px 18px; margin-bottom: 10px;
  }
  .flow-header h2 { margin: 0 0 4px; font-size: 1.1em; display: flex; align-items: center; gap: 8px; }
  .flow-header .params { font-size: 0.85em; color: var(--z-meta); margin-bottom: 6px; }
  .flow-header .params code {
    color: var(--z-fg); font-size: 0.95em;
    background: var(--z-code-bg); padding: 1px 6px; border-radius: 3px; margin: 0 2px;
  }
  .flow-header .constraints { font-size: 0.82em; color: var(--z-meta); display: flex; gap: 16px; flex-wrap: wrap; }
  .flow-header .constraints .badge {
    background: var(--z-code-bg); padding: 1px 8px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family); font-size: 0.92em; color: var(--z-fg);
  }
  .diag-section { margin-top: 16px; }
  .diag-item {
    padding: 6px 14px; border-left: 4px solid var(--z-err);
    margin-bottom: 4px; font-size: 0.85em;
    background: var(--z-card-bg); border-radius: 0 4px 4px 0;
  }
  .diag-item.z-warning { border-left-color: var(--z-warn); }
  .diag-item .diag-tag { font-weight: 600; margin-right: 8px; }
  .diag-item.z-error .diag-tag { color: var(--z-err); }
  .diag-item.z-warning .diag-tag { color: var(--z-warn); }
  /* Graph hint bar */
  .graph-hint {
    font-size: 11px; color: var(--z-meta); margin-bottom: 10px;
    display: flex; align-items: center; gap: 6px; user-select: none;
    background: var(--z-card-bg); border-radius: 4px;
    padding: 5px 12px; border: 1px solid var(--z-card-border);
  }
  /* SVG container */
  .graph-container {
    position: relative; overflow: auto;
    border: 1px solid var(--z-card-border); border-radius: 8px;
    background: var(--z-bg);
  }
  .graph-container svg { display: block; overflow: visible; min-height: 200px; }
  /* Nodes */
  .node-group { cursor: grab; transition: filter 0.15s ease; }
  .node-group:active, .node-group.dragging { cursor: grabbing; }
  .node-group.dragging { filter: url(#node-shadow); z-index: 10; }
  .node-rect {
    fill: var(--z-card-bg);
    stroke: var(--z-agent);
    stroke-width: 1.8;
    transition: stroke-width 0.15s ease, filter 0.15s ease;
  }
  .node-group:hover .node-rect {
    stroke-width: 2.4;
    filter: drop-shadow(2px 3px 6px var(--node-shad));
  }
  .node-header {
    pointer-events: none;
  }
  /* Edges — the visible path */
  .edge-path {
    fill: none; stroke-width: 2.2; stroke-linecap: round;
    opacity: 0.65; transition: opacity 0.15s ease, stroke-width 0.15s ease;
  }
  .edge-group:hover .edge-path {
    opacity: 1; stroke-width: 3.5;
  }
  .edge-hit {
    fill: none; stroke: transparent; stroke-width: 14;
  }
  .edge-label {
    font-size: 11px; font-family: var(--vscode-editor-font-family);
    font-weight: 500; pointer-events: none;
  }
  .edge-label-bg {
    fill: var(--z-bg); stroke: var(--z-card-border);
    stroke-width: 0.5; opacity: 0.92;
  }
  /* Empty / error states */
  .empty { text-align: center; opacity: 0.5; padding: 60px 20px; }
  .empty h2 { margin: 0 0 8px; }
  .empty p { margin: 0; }
`

// ─── Render script ──────────────────────────────────────────────────────
// Self-contained JS that builds an interactive SVG diagram from the flow AST.
//
// Layout:
//   - Topological column layout (left → right) using stake-edge BFS.
//   - Nodes are vertically centered within each column for visual balance.
//   - Forward edges route as smooth cubic bezier curves with parallel-edge offsetting.
//   - Back-edges (target on same or earlier layer) route above/below to avoid crossing.
//
// Interactivity:
//   - Nodes are draggable via mouse. Edge paths update live during drag.
//   - Hover effects on nodes (scale + glow) and edges (highlight).
//   - Drop-shadow filter makes nodes feel elevated above the edge layer.
//   - All event listeners are attached in JS (no inline handlers) to comply with CSP.

const RENDER_SCRIPT = [
	"// ── escape ──",
	"function esc(s){",
	"  return String(s).replace(/&/g,'\x26amp;').replace(/</g,'\x26lt;').replace(/>/g,'\x26gt;').replace(/\"/g,'\x26quot;');",
	"}",
	"// ── safe wrapper to catch render errors ──",
	"function safeRender(payload){",
	"  try{",
	"    render(payload);",
	"  }catch(e){",
	"    var app=document.getElementById('app');",
	"    if(app){",
	"      app.innerHTML='<div class=\"empty\"><h2>⚠️ Render Error</h2><p style=\"color:#f87171\">'+esc(String(e))+'</p><pre style=\"font-size:11px;text-align:left;opacity:0.7\">'+esc(e.stack)+'</pre></div>';",
	"    }",
	"    console.error('[Slang Render Error]', e);",
	"  }",
	"}",
	"// ── expr to string ──",
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
	"// ── graph extraction ──",
	"var COLORS={stake:'var(--z-stake,#f59e0b)',await:'var(--z-await,#a855f7)',agent:'var(--z-agent,#22c55e)',flow:'var(--z-flow,#3b82f6)'};",
	"var NODE_W=200, NODE_H=80, NODE_GAP_X=280, NODE_GAP_Y=120, MARGIN=48;",
	"function buildGraphEdges(flow){",
	"  var agentNames={};",
	"  for(var i=0;i<(flow.body||[]).length;i++){",
	"    var item=flow.body[i];",
	"    if(item.type==='AgentDecl')agentNames[item.name]=true;",
	"  }",
	"  var edges=[];",
	"  function isAgentRef(ref){ return agentNames.hasOwnProperty(ref); }",
	"  for(var ai=0;ai<(flow.body||[]).length;ai++){",
	"    var agent=flow.body[ai];",
	"    if(agent.type!=='AgentDecl')continue;",
	"    var from=agent.name;",
	"    function scan(ops){",
	"      if(!ops)return;",
	"      for(var i=0;i<ops.length;i++){",
	"        var op=ops[i];",
	"        if(op.type==='StakeOp'&&op.recipients){",
	"          for(var j=0;j<op.recipients.length;j++){",
	"            var r=op.recipients[j],to=r.ref||r;",
	"            if(!isAgentRef(to))continue;",
	"            edges.push({from:from,to:to,label:op.call?op.call.name:'stake',kind:'stake'});",
	"          }",
	"        }",
	"        if(op.type==='AwaitOp'&&op.sources){",
	"          for(var k=0;k<op.sources.length;k++){",
	"            var src=op.sources[k],srcRef=src.ref||src;",
	"            if(!isAgentRef(srcRef))continue;",
	"            edges.push({from:srcRef,to:from,label:op.binding||'await',kind:'await'});",
	"          }",
	"        }",
	"        if(op.type==='WhenBlock'){scan(op.body);if(op.elseBlock)scan(op.elseBlock.body);}",
	"        if(op.type==='RepeatBlock')scan(op.body);",
	"      }",
	"    }",
	"    scan(agent.operations);",
	"  }",
	"  return edges;",
	"}",
	"// ── topological layering (BFS from sources) ──",
	"function assignLayers(agentNames,edges){",
	"  var names=Object.keys(agentNames);",
	"  var layer={},inDegree={};",
	"  for(var i=0;i<names.length;i++){layer[names[i]]=-1;inDegree[names[i]]=0;}",
	"  var adj={};",
	"  for(var i=0;i<names.length;i++)adj[names[i]]=[];",
	"  for(var i=0;i<edges.length;i++){",
	"    var e=edges[i];",
	"    adj[e.from]=adj[e.from]||[];",
	"    adj[e.from].push(e.to);",
	"    if(inDegree.hasOwnProperty(e.to))inDegree[e.to]++;",
	"  }",
	"  var queue=[];",
	"  for(var i=0;i<names.length;i++){",
	"    if(inDegree[names[i]]===0){queue.push(names[i]);layer[names[i]]=0;}",
	"  }",
	"  if(queue.length===0&&names.length>0){queue.push(names[0]);layer[names[0]]=0;}",
	"  var head=0;",
	"  while(head<queue.length){",
	"    var cur=queue[head++];",
	"    var nbrs=adj[cur]||[];",
	"    for(var i=0;i<nbrs.length;i++){",
	"      var nb=nbrs[i];",
	"      if(layer[nb]===-1){",
	"        layer[nb]=layer[cur]+1;",
	"        queue.push(nb);",
	"      }",
	"    }",
	"  }",
	"  for(var i=0;i<names.length;i++){if(layer[names[i]]===-1)layer[names[i]]=0;}",
	"  return layer;",
	"}",
	"function buildColumns(layer,agentNames){",
	"  var maxLayer=0;",
	"  var keys=Object.keys(layer);",
	"  for(var i=0;i<keys.length;i++){if(layer[keys[i]]>maxLayer)maxLayer=layer[keys[i]];}",
	"  var cols=[];",
	"  for(var i=0;i<=maxLayer;i++)cols.push([]);",
	"  for(var i=0;i<keys.length;i++){cols[layer[keys[i]]].push(keys[i]);}",
	"  return cols;",
	"}",
	"// ── SVG defs (markers + drop-shadow filter) ──",
	"function defs(){",
	"  return'<defs>'",
	'    +\'<filter id="node-shadow" x="-10%" y="-5%" width="130%" height="125%">\'',
	'    +\'<feDropShadow dx="1.5" dy="2.5" stdDeviation="3" flood-color="#000" flood-opacity="0.35"/>\'',
	"    +'</filter>'",
	'    +\'<marker id="ah-stake" markerWidth="11" markerHeight="8" refX="10" refY="4" orient="auto">\'',
	"    +'<polygon points=\"0 0, 11 4, 0 8\" fill=\"'+COLORS.stake+'\"/></marker>'",
	'    +\'<marker id="ah-await" markerWidth="11" markerHeight="8" refX="0" refY="4" orient="auto">\'',
	"    +'<polygon points=\"11 0, 0 4, 11 8\" fill=\"'+COLORS.await+'\"/></marker>'",
	"    +'</defs>';",
	"}",
	"// ── render an individual node (inside a <g> group) ──",
	"function renderNode(nm,meta){",
	"  var color=COLORS.agent;",
	"  var mode=meta.mode,role=meta.role;",
	"  // Header strip",
	'  var s=\'<rect class="node-header" x="1" y="1" width="\'+(NODE_W-2)+\'" height="26" rx="7" fill="\'+color+\'" opacity="0.15" />\';',
	"  // Name",
	'  s+=\'<text x="14" y="20" font-size="13" font-weight="700" fill="\'+color+\'" style="pointer-events:none">@\'+esc(nm)+\'</text>\';',
	"  // Mode badge (top-right)",
	"  if(mode){",
	"    var mw=esc(mode).length*7.5+14;",
	'    s+=\'<rect x="\'+(NODE_W-mw-6)+\'" y="6" width="\'+mw+\'" height="16" rx="3" fill="\'+color+\'" opacity="0.2" />\';',
	'    s+=\'<text x="\'+(NODE_W-mw+1)+\'" y="18" font-size="10" font-weight="600" fill="\'+color+\'" style="pointer-events:none">\'+esc(mode)+\'</text>\';',
	"  }",
	"  // Role (truncated to fit)",
	"  if(role){",
	"    var maxChars=Math.floor((NODE_W-28)/6.3);",
	"    var r1=role.length>maxChars?role.slice(0,maxChars)+'\\u2026':role;",
	'    s+=\'<text x="14" y="48" font-size="11" fill="var(--z-meta,#888)" style="pointer-events:none">\'+esc(r1)+\'</text>\';',
	"    if(role.length>maxChars*1.5){",
	"      var r2=role.slice(maxChars,maxChars*2-3)+'\\u2026';",
	'      s+=\'<text x="14" y="64" font-size="11" fill="var(--z-meta,#888)" style="pointer-events:none">\'+esc(r2)+\'</text>\';',
	"    }",
	"  }",
	"  return s;",
	"}",
	"// ── edge path builder (called during render AND during drag updates) ──",
	"function edgePathData(fromX,fromY,toX,toY,idx,total,fromLayer,toLayer){",
	"  // Vertical offset: spread parallel edges between the same pair apart",
	"  var offset=0;",
	"  if(total>1){",
	"    var center=(total-1)/2;",
	"    offset=(idx-center)*14;",
	"  }",
	"  var x1=fromX+NODE_W, y1=fromY+NODE_H/2+offset;",
	"  var x2=toX, y2=toY+NODE_H/2+offset;",
	"  var dx=Math.abs(x2-x1);",
	"  var curve=Math.min(dx*0.45, 140); // softer curve for short distances",
	"  // For forward edges (fromLayer < toLayer): smooth bezier",
	"  // For back/same-layer edges: arc above",
	"  if(fromLayer!=null&&toLayer!=null&&fromLayer>=toLayer){",
	"    // Back-edge: route above the nodes",
	"    var arcH=Math.max(60, Math.abs(fromLayer-toLayer)*50 + 20);",
	"    return 'M'+x1+','+y1",
	"      +' C'+x1+','+(y1-arcH)+' '+x2+','+(y2-arcH)+' '+x2+','+y2;",
	"  }",
	"  return 'M'+x1+','+y1",
	"    +' C'+(x1+curve)+','+y1+' '+(x2-curve)+','+y2+' '+x2+','+y2;",
	"}",
	"// ── render a single edge as a <g> group ──",
	"function renderEdge(e,idx,total,layout,layers){",
	"  var fn=layout[e.from],tn=layout[e.to];",
	"  if(!fn||!tn)return'';",
	"  var fromLayer=layers[e.from],toLayer=layers[e.to];",
	"  var d=edgePathData(fn.x,fn.y,tn.x,tn.y,idx,total,fromLayer,toLayer);",
	"  var color=e.kind==='stake'?COLORS.stake:COLORS.await;",
	"  var marker=e.kind==='stake'?'url(#ah-stake)':'url(#ah-await)';",
	"  var key=esc(e.from)+'__'+esc(e.to)+'__'+idx;",
	"  var s='<g class=\"edge-group\" data-edge=\"'+key+'\" data-from=\"'+esc(e.from)+'\" data-to=\"'+esc(e.to)+'\" data-idx=\"'+idx+'\" data-kind=\"'+e.kind+'\">';",
	"  // Invisible wider hit area for easier hover",
	'  s+=\'<path class="edge-hit" d="\'+d+\'" stroke="transparent" stroke-width="14" fill="none" style="cursor:pointer" />\';',
	'  s+=\'<path class="edge-path" d="\'+d+\'" stroke="\'+color+\'" fill="none" stroke-width="2.2" marker-end="\'+marker+\'" />\';',
	"  // Label at the midpoint of the bezier",
	"  if(e.label){",
	"    var midT=0.5;",
	"    var cx,cy;",
	"    var x1=fn.x+NODE_W,y1=fn.y+NODE_H/2,x2=tn.x,y2=tn.y+NODE_H/2;",
	"    if(fromLayer!=null&&toLayer!=null&&fromLayer>=toLayer){",
	"      var arcH=Math.max(60,Math.abs(fromLayer-toLayer)*50+20);",
	"      cx=(x1+x2)/2; cy=(y1+y2)/2-arcH*0.7;",
	"    }else{",
	"      cx=(x1+x2)/2; cy=(y1+y2)/2;",
	"    }",
	"    var lw=esc(e.label).length*6.5+10;",
	'    s+=\'<rect class="edge-label-bg" x="\'+(cx-lw/2)+\'" y="\'+(cy-9)+\'" width="\'+lw+\'" height="18" rx="4" />\';',
	'    s+=\'<text class="edge-label" x="\'+cx+\'" y="\'+(cy+5)+\'" text-anchor="middle" fill="\'+color+\'" font-size="11" font-weight="500">\'+esc(e.label)+\'</text>\';',
	"  }",
	"  s+='</g>';",
	"  return s;",
	"}",
	"// ── drag state (module-level so event handlers can access it) ──",
	"var _dragNode=null, _dragSX=0, _dragSY=0, _dragOX=0, _dragOY=0;",
	"var _svgn=null, _layout=null, _edges=null, _layers=null, _svgEl=null;",
	"function beginDrag(e){",
	"  var g=e.currentTarget;",
	"  var agent=g.getAttribute('data-agent');",
	"  if(!agent||!_layout||!_layout[agent])return;",
	"  e.preventDefault();",
	"  _dragNode=agent;",
	"  _dragSX=e.clientX; _dragSY=e.clientY;",
	"  _dragOX=_layout[agent].x; _dragOY=_layout[agent].y;",
	"  g.classList.add('dragging');",
	"  g.setAttribute('filter','url(#node-shadow)');",
	"}",
	"function moveDrag(e){",
	"  if(!_dragNode)return;",
	"  e.preventDefault();",
	"  var dx=e.clientX-_dragSX, dy=e.clientY-_dragSY;",
	"  var nx=_dragOX+dx, ny=_dragOY+dy;",
	"  // Clamp to reasonable bounds",
	"  nx=Math.max(-NODE_W*0.5,nx);",
	"  ny=Math.max(-NODE_H*0.5,ny);",
	"  _layout[_dragNode].x=nx;",
	"  _layout[_dragNode].y=ny;",
	"  // Move the SVG group",
	"  var g=_svgn.querySelector('.node-group[data-agent=\"'+esc(_dragNode)+'\"]');",
	"  if(g)g.setAttribute('transform','translate('+nx+','+ny+')');",
	"  // Update all edges that connect to this agent",
	"  updateConnectedEdges(_dragNode);",
	"}",
	"function endDrag(e){",
	"  if(!_dragNode)return;",
	"  var g=_svgn.querySelector('.node-group[data-agent=\"'+esc(_dragNode)+'\"]');",
	"  if(g){g.classList.remove('dragging');g.removeAttribute('filter');}",
	"  _dragNode=null;",
	"}",
	"function updateConnectedEdges(agent){",
	"  if(!_edges||!_layout||!_layers||!_svgEl)return;",
	"  for(var ei=0;ei<_edges.length;ei++){",
	"    var e=_edges[ei];",
	"    if(e.from!==agent&&e.to!==agent)continue;",
	"    var fn=_layout[e.from],tn=_layout[e.to];",
	"    if(!fn||!tn)continue;",
	"    var fromLayer=_layers[e.from],toLayer=_layers[e.to];",
	"    var key=esc(e.from)+'__'+esc(e.to)+'__'+e.idx;",
	"    var eg=_svgEl.querySelector('.edge-group[data-edge=\"'+key+'\"]');",
	"    if(!eg)continue;",
	"    var d=edgePathData(fn.x,fn.y,tn.x,tn.y,e.idx,e.total,fromLayer,toLayer);",
	"    var hit=eg.querySelector('.edge-hit');",
	"    var path=eg.querySelector('.edge-path');",
	"    if(hit)hit.setAttribute('d',d);",
	"    if(path)path.setAttribute('d',d);",
	"    // Also update the edge label position so it follows the arrow",
	"    var lblRect=eg.querySelector('.edge-label-bg');",
	"    var lblText=eg.querySelector('.edge-label');",
	"    if(lblRect&&lblText&&e.label){",
	"      var x1=fn.x+NODE_W,y1=fn.y+NODE_H/2,x2=tn.x,y2=tn.y+NODE_H/2;",
	"      var ecx,ecy;",
	"      if(fromLayer!=null&&toLayer!=null&&fromLayer>=toLayer){",
	"        var arcH2=Math.max(60,Math.abs(fromLayer-toLayer)*50+20);",
	"        ecx=(x1+x2)/2; ecy=(y1+y2)/2-arcH2*0.7;",
	"      }else{",
	"        ecx=(x1+x2)/2; ecy=(y1+y2)/2;",
	"      }",
	"      var lw2=esc(e.label).length*6.5+10;",
	"      lblRect.setAttribute('x',ecx-lw2/2);",
	"      lblRect.setAttribute('y',ecy-9);",
	"      lblText.setAttribute('x',ecx);",
	"      lblText.setAttribute('y',ecy+5);",
	"    }",
	"  }",
	"}",
	"// ── main render ──",
	"function render(payload){",
	"  var flow=payload.flow,diags=payload.diags||[];",
	"  var app=document.getElementById('app');",
	"  var diagsEl=document.getElementById('diags');",
	"  if(!flow){app.innerHTML='<div class=\"empty\"><h2>No flow found</h2></div>';return;}",
	"  // ── header ──",
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
	"  h+='<div class=\"graph-hint\">🖱️ Drag nodes to rearrange &nbsp;|&nbsp; 🔄 Auto-layout from topology</div>';",
	"  // ── build graph data ──",
	"  var agentNames={};",
	"  var agentMeta={};",
	"  for(var ai=0;ai<(flow.body||[]).length;ai++){",
	"    var agent=flow.body[ai];",
	"    if(agent.type!=='AgentDecl')continue;",
	"    agentNames[agent.name]=true;",
	"    agentMeta[agent.name]={mode:agent.meta&&agent.meta.mode?agent.meta.mode:'',role:agent.meta&&agent.meta.role?agent.meta.role:''};",
	"  }",
	"  var rawEdges=buildGraphEdges(flow);",
	"  _layers=assignLayers(agentNames,rawEdges);",
	"  var cols=buildColumns(_layers,agentNames);",
	"  // Compute positions with vertical centering within each column.",
	"  var maxColHeight=0;",
	"  for(var ci=0;ci<cols.length;ci++){",
	"    var ch=cols[ci].length*NODE_GAP_Y;",
	"    if(ch>maxColHeight)maxColHeight=ch;",
	"  }",
	"  if(maxColHeight===0)maxColHeight=NODE_GAP_Y;",
	"  _layout={};",
	"  for(var ci=0;ci<cols.length;ci++){",
	"    var col=cols[ci];",
	"    var x=MARGIN+ci*NODE_GAP_X;",
	"    var colH=col.length*NODE_GAP_Y;",
	"    var y0=MARGIN+(maxColHeight-colH)/2; // vertical centering",
	"    for(var ri=0;ri<col.length;ri++){",
	"      _layout[col[ri]]={x:x,y:y0+ri*NODE_GAP_Y};",
	"    }",
	"  }",
	"  // Deduplicate edges: merge same (from→to×kind) into one edge with combined label",
	"  var mergeMap={};",
	"  for(var ei=0;ei<rawEdges.length;ei++){",
	"    var re=rawEdges[ei],mk=re.from+'|||'+re.to+'|||'+re.kind;",
	"    if(!mergeMap[mk])mergeMap[mk]={from:re.from,to:re.to,kind:re.kind,labels:[]};",
	"    if(mergeMap[mk].labels.indexOf(re.label)===-1)mergeMap[mk].labels.push(re.label);",
	"  }",
	"  _edges=[];",
	"  var mergeKeys=Object.keys(mergeMap);",
	"  for(var pi=0;pi<mergeKeys.length;pi++){",
	"    var g=mergeMap[mergeKeys[pi]];",
	"    var lbl=g.labels.length===1?g.labels[0]:g.labels[0]+' (+'+(g.labels.length-1)+' more)';",
	"    _edges.push({from:g.from,to:g.to,label:lbl,kind:g.kind,idx:0,total:1});",
	"  }",
	"  // ── SVG dimensions ──",
	"  var svgW=cols.length*NODE_GAP_X+NODE_W+2*MARGIN;",
	"  var svgH=maxColHeight+NODE_H+MARGIN*2;",
	"  if(cols.length===0){svgW=400;svgH=120;}",
	"  if(svgW<500)svgW=500;",
	"  if(svgH<300)svgH=300;",
	"  // ── assemble SVG ──",
	'  var svg=\'<svg id="slang-svg" width="\'+svgW+\'" height="\'+svgH+\'" xmlns="http://www.w3.org/2000/svg">\';',
	"  svg+=defs();",
	"  // Edge layer (below nodes)",
	"  svg+='<g id=\"edge-layer\">';",
	"  for(var ei=0;ei<_edges.length;ei++){",
	"    svg+=renderEdge(_edges[ei],_edges[ei].idx,_edges[ei].total,_layout,_layers);",
	"  }",
	"  svg+='</g>';",
	"  // Node layer",
	"  svg+='<g id=\"node-layer\">';",
	"  var names=Object.keys(_layout);",
	"  for(var ni=0;ni<names.length;ni++){",
	"    var nm=names[ni],pos=_layout[nm],meta=agentMeta[nm]||{};",
	"    svg+='<g class=\"node-group\" data-agent=\"'+esc(nm)+'\" transform=\"translate('+pos.x+','+pos.y+')\">';",
	'    svg+=\'<rect class="node-rect" x="0" y="0" width="\'+NODE_W+\'" height="\'+NODE_H+\'" rx="9" />\';',
	"    svg+=renderNode(nm,meta);",
	"    svg+='</g>';",
	"  }",
	"  svg+='</g>';",
	"  svg+='</svg>';",
	"  h+='<div class=\"graph-container\">'+svg+'</div>';",
	"  app.innerHTML=h;",
	"  // ── diags ──",
	"  if(diags.length>0){",
	"    var dHtml='';",
	"    for(var di=0;di<diags.length;di++){",
	"      var d=diags[di],isErr=d.indexOf('[error]')!==-1;",
	"      dHtml+='<div class=\"diag-item'+(isErr?' z-error':' z-warning')+'\"><span class=\"diag-tag\">'+(isErr?'ERROR':'WARN')+'</span>'+esc(d)+'</div>';",
	"    }",
	"    diagsEl.innerHTML=dHtml;",
	"  }else{diagsEl.innerHTML='';}",
	"  // ── wire up drag handlers ──",
	"  _svgn=document;",
	"  _svgEl=document.getElementById('slang-svg');",
	"  var groups=_svgEl?Array.prototype.slice.call(_svgEl.querySelectorAll('.node-group')):[];",
	"  for(var gi=0;gi<groups.length;gi++){",
	"    var g=groups[gi];",
	"    g.addEventListener('mousedown',beginDrag);",
	"  }",
	"  document.addEventListener('mousemove',moveDrag);",
	"  document.addEventListener('mouseup',endDrag);",
	"}",
].join("\n")
