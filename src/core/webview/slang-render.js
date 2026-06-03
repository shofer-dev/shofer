/* eslint-env browser */
/* eslint-disable no-redeclare, no-prototype-builtins, no-undef */
// ── escape ──
function esc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
// ── safe wrapper to catch render errors ──
function safeRender(payload) {
	try {
		render(payload)
	} catch (e) {
		var app = document.getElementById("app")
		if (app) {
			app.innerHTML =
				'<div class="empty"><h2>⚠️ Render Error</h2><p style="color:#f87171">' +
				esc(String(e)) +
				'</p><pre style="font-size:11px;text-align:left;opacity:0.7">' +
				esc(e.stack) +
				"</pre></div>"
		}
		console.error("[Slang Render Error]", e)
	}
}
// ── expr to string ──
function exprStr(e) {
	if (!e) return "?"
	switch (e.type) {
		case "NumberLit":
			return String(e.value)
		case "StringLit":
			return '"' + e.value.replace(/"/g, '\\"') + '"'
		case "BoolLit":
			return String(e.value)
		case "Ident":
			return e.name
		case "AgentRef":
			return "@" + e.name
		case "ListLit":
			return "[" + (e.elements || []).map(exprStr).join(", ") + "]"
		case "DotAccess":
			return exprStr(e.object) + "." + e.property
		case "BinaryExpr":
			return exprStr(e.left) + " " + e.op + " " + exprStr(e.right)
		default:
			return String(e.type)
	}
}
function exprShort(e, m) {
	m = m || 40
	var s = exprStr(e)
	if (s.length > m) return s.slice(0, m) + "\u2026"
	return s
}
// ── scan for loop blocks (RepeatBlock / WhenBlock) ──
function scanForLoops(ops) {
	if (!ops) return false
	for (var i = 0; i < ops.length; i++) {
		var o = ops[i]
		if (o.type === "RepeatBlock" || o.type === "WhenBlock") return true
		if (o.type === "WhenBlock") {
			if (scanForLoops(o.body)) return true
			if (o.elseBlock && scanForLoops(o.elseBlock.body)) return true
		}
		if (o.type === "RepeatBlock" && scanForLoops(o.body)) return true
	}
	return false
}
// ── graph extraction ──
var COLORS = {
	stake: "var(--z-stake,#f59e0b)",
	await: "var(--z-await,#a855f7)",
	agent: "var(--z-agent,#22c55e)",
	flow: "var(--z-flow,#3b82f6)",
}
var NODE_W = 200,
	NODE_H = 80,
	NODE_GAP_X = 280,
	NODE_GAP_Y = 120,
	MARGIN = 48
function buildGraphEdges(flow) {
	var agentNames = {}
	for (var i = 0; i < (flow.body || []).length; i++) {
		var item = flow.body[i]
		if (item.type === "AgentDecl") agentNames[item.name] = true
	}
	var edges = []
	function isAgentRef(ref) {
		return agentNames.hasOwnProperty(ref)
	}
	for (var ai = 0; ai < (flow.body || []).length; ai++) {
		var agent = flow.body[ai]
		if (agent.type !== "AgentDecl") continue
		var from = agent.name
		function scan(ops) {
			if (!ops) return
			for (var i = 0; i < ops.length; i++) {
				var op = ops[i]
				if (op.type === "StakeOp" && op.recipients) {
					for (var j = 0; j < op.recipients.length; j++) {
						var r = op.recipients[j],
							to = r.ref || r
						if (!isAgentRef(to)) continue
						edges.push({ from: from, to: to, label: op.call ? op.call.name : "stake", kind: "stake" })
					}
				}
				if (op.type === "AwaitOp" && op.sources) {
					for (var k = 0; k < op.sources.length; k++) {
						var src = op.sources[k],
							srcRef = src.ref || src
						if (!isAgentRef(srcRef)) continue
						edges.push({ from: srcRef, to: from, label: op.binding || "await", kind: "await" })
					}
				}
				if (op.type === "WhenBlock") {
					scan(op.body)
					if (op.elseBlock) scan(op.elseBlock.body)
				}
				if (op.type === "RepeatBlock") scan(op.body)
			}
		}
		scan(agent.operations)
	}
	return edges
}
// ── topological layering (BFS from sources) ──
function assignLayers(agentNames, edges) {
	var names = Object.keys(agentNames)
	var layer = {},
		inDegree = {}
	for (var i = 0; i < names.length; i++) {
		layer[names[i]] = -1
		inDegree[names[i]] = 0
	}
	var adj = {}
	for (var i = 0; i < names.length; i++) adj[names[i]] = []
	for (var i = 0; i < edges.length; i++) {
		var e = edges[i]
		adj[e.from] = adj[e.from] || []
		adj[e.from].push(e.to)
		if (inDegree.hasOwnProperty(e.to)) inDegree[e.to]++
	}
	var queue = []
	for (var i = 0; i < names.length; i++) {
		if (inDegree[names[i]] === 0) {
			queue.push(names[i])
			layer[names[i]] = 0
		}
	}
	if (queue.length === 0 && names.length > 0) {
		queue.push(names[0])
		layer[names[0]] = 0
	}
	var head = 0
	while (head < queue.length) {
		var cur = queue[head++]
		var nbrs = adj[cur] || []
		for (var i = 0; i < nbrs.length; i++) {
			var nb = nbrs[i]
			if (layer[nb] === -1) {
				layer[nb] = layer[cur] + 1
				queue.push(nb)
			}
		}
	}
	for (var i = 0; i < names.length; i++) {
		if (layer[names[i]] === -1) layer[names[i]] = 0
	}
	return layer
}
function buildColumns(layer, agentNames) {
	var maxLayer = 0
	var keys = Object.keys(layer)
	for (var i = 0; i < keys.length; i++) {
		if (layer[keys[i]] > maxLayer) maxLayer = layer[keys[i]]
	}
	var cols = []
	for (var i = 0; i <= maxLayer; i++) cols.push([])
	for (var i = 0; i < keys.length; i++) {
		cols[layer[keys[i]]].push(keys[i])
	}
	return cols
}
// ── SVG defs (markers + drop-shadow filter) ──
function defs() {
	return (
		"<defs>" +
		'<filter id="node-shadow" x="-10%" y="-5%" width="130%" height="125%">' +
		'<feDropShadow dx="1.5" dy="2.5" stdDeviation="3" flood-color="#000" flood-opacity="0.35"/>' +
		"</filter>" +
		'<marker id="ah-stake" markerWidth="11" markerHeight="8" refX="10" refY="4" orient="auto">' +
		'<polygon points="0 0, 11 4, 0 8" fill="' +
		COLORS.stake +
		'"/></marker>' +
		'<marker id="ah-await" markerWidth="11" markerHeight="8" refX="0" refY="4" orient="auto">' +
		'<polygon points="11 0, 0 4, 11 8" fill="' +
		COLORS.await +
		'"/></marker>' +
		"</defs>"
	)
}
// ── render an individual node (inside a <g> group) ──
function renderNode(nm, meta) {
	var color = meta.hasLoop ? COLORS.stake : COLORS.agent
	var mode = meta.mode,
		role = meta.role
	// Header strip
	var s =
		'<rect class="node-header" x="1" y="1" width="' +
		(NODE_W - 2) +
		'" height="26" rx="7" fill="' +
		color +
		'" opacity="0.15" />'
	// Name
	s +=
		'<text x="14" y="20" font-size="13" font-weight="700" fill="' +
		color +
		'" style="pointer-events:none">@' +
		esc(nm) +
		"</text>"
	// Mode badge (top-right)
	if (mode) {
		var mw = esc(mode).length * 7.5 + 14
		s +=
			'<rect x="' +
			(NODE_W - mw - 6) +
			'" y="6" width="' +
			mw +
			'" height="16" rx="3" fill="' +
			color +
			'" opacity="0.2" />'
		s +=
			'<text x="' +
			(NODE_W - mw + 1) +
			'" y="18" font-size="10" font-weight="600" fill="' +
			color +
			'" style="pointer-events:none">' +
			esc(mode) +
			"</text>"
	}
	// Role (truncated to fit)
	if (role) {
		var maxChars = Math.floor((NODE_W - 28) / 6.3)
		var r1 = role.length > maxChars ? role.slice(0, maxChars) + "\u2026" : role
		s +=
			'<text x="14" y="48" font-size="11" fill="var(--z-meta,#888)" style="pointer-events:none">' +
			esc(r1) +
			"</text>"
		if (role.length > maxChars * 1.5) {
			var r2 = role.slice(maxChars, maxChars * 2 - 3) + "\u2026"
			s +=
				'<text x="14" y="64" font-size="11" fill="var(--z-meta,#888)" style="pointer-events:none">' +
				esc(r2) +
				"</text>"
		}
	}
	// Loop badge (top-left, after mode badge area)
	if (meta.hasLoop) {
		s +=
			'<rect class="loop-badge" x="14" y="32" width="32" height="16" rx="3" fill="' +
			COLORS.stake +
			'" opacity="0.18" />'
		s += '<text class="loop-label" x="30" y="44" text-anchor="middle" fill="' + COLORS.stake + '">🔄</text>'
	}
	return s
}
// ── edge path builder (called during render AND during drag updates) ──
function edgePathData(fromX, fromY, toX, toY, idx, total, fromLayer, toLayer) {
	// Vertical offset: spread parallel edges between the same pair apart
	var offset = 0
	if (total > 1) {
		var center = (total - 1) / 2
		offset = (idx - center) * 14
	}
	var x1 = fromX + NODE_W,
		y1 = fromY + NODE_H / 2 + offset
	var x2 = toX,
		y2 = toY + NODE_H / 2 + offset
	var dx = Math.abs(x2 - x1)
	var curve = Math.min(dx * 0.45, 140) // softer curve for short distances
	// For forward edges (fromLayer < toLayer): smooth bezier
	// For back/same-layer edges: arc above
	if (fromLayer != null && toLayer != null && fromLayer >= toLayer) {
		// Back-edge: route above the nodes
		var arcH = Math.max(60, Math.abs(fromLayer - toLayer) * 50 + 20)
		return "M" + x1 + "," + y1 + " C" + x1 + "," + (y1 - arcH) + " " + x2 + "," + (y2 - arcH) + " " + x2 + "," + y2
	}
	return "M" + x1 + "," + y1 + " C" + (x1 + curve) + "," + y1 + " " + (x2 - curve) + "," + y2 + " " + x2 + "," + y2
}
// ── render a single edge as a <g> group ──
function renderEdge(e, idx, total, layout, layers) {
	var fn = layout[e.from],
		tn = layout[e.to]
	if (!fn || !tn) return ""
	var fromLayer = layers[e.from],
		toLayer = layers[e.to]
	var d = edgePathData(fn.x, fn.y, tn.x, tn.y, idx, total, fromLayer, toLayer)
	var color = e.kind === "stake" ? COLORS.stake : COLORS.await
	var marker = e.kind === "stake" ? "url(#ah-stake)" : "url(#ah-await)"
	var key = esc(e.from) + "__" + esc(e.to) + "__" + idx
	var s =
		'<g class="edge-group" data-edge="' +
		key +
		'" data-from="' +
		esc(e.from) +
		'" data-to="' +
		esc(e.to) +
		'" data-idx="' +
		idx +
		'" data-kind="' +
		e.kind +
		'">'
	// Invisible wider hit area for easier hover
	s +=
		'<path class="edge-hit" d="' +
		d +
		'" stroke="transparent" stroke-width="14" fill="none" style="cursor:pointer" />'
	s +=
		'<path class="edge-path" d="' +
		d +
		'" stroke="' +
		color +
		'" fill="none" stroke-width="2.2" marker-end="' +
		marker +
		'" />'
	// Label at the midpoint of the bezier
	if (e.label) {
		var midT = 0.5
		var cx, cy
		var x1 = fn.x + NODE_W,
			y1 = fn.y + NODE_H / 2,
			x2 = tn.x,
			y2 = tn.y + NODE_H / 2
		if (fromLayer != null && toLayer != null && fromLayer >= toLayer) {
			var arcH = Math.max(60, Math.abs(fromLayer - toLayer) * 50 + 20)
			cx = (x1 + x2) / 2
			cy = (y1 + y2) / 2 - arcH * 0.7
		} else {
			cx = (x1 + x2) / 2
			cy = (y1 + y2) / 2
		}
		var lw = esc(e.label).length * 6.5 + 10
		s +=
			'<rect class="edge-label-bg" x="' +
			(cx - lw / 2) +
			'" y="' +
			(cy - 9) +
			'" width="' +
			lw +
			'" height="18" rx="4" />'
		s +=
			'<text class="edge-label" x="' +
			cx +
			'" y="' +
			(cy + 5) +
			'" text-anchor="middle" fill="' +
			color +
			'" font-size="11" font-weight="500">' +
			esc(e.label) +
			"</text>"
	}
	s += "</g>"
	return s
}
// ── drag state (module-level so event handlers can access it) ──
var _dragNode = null,
	_dragSX = 0,
	_dragSY = 0,
	_dragOX = 0,
	_dragOY = 0
var _svgn = null,
	_layout = null,
	_edges = null,
	_layers = null,
	_svgEl = null
function beginDrag(e) {
	var g = e.currentTarget
	var agent = g.getAttribute("data-agent")
	if (!agent || !_layout || !_layout[agent]) return
	e.preventDefault()
	_dragNode = agent
	_dragSX = e.clientX
	_dragSY = e.clientY
	_dragOX = _layout[agent].x
	_dragOY = _layout[agent].y
	g.classList.add("dragging")
	g.setAttribute("filter", "url(#node-shadow)")
}
function moveDrag(e) {
	if (!_dragNode) return
	e.preventDefault()
	var dx = e.clientX - _dragSX,
		dy = e.clientY - _dragSY
	var nx = _dragOX + dx,
		ny = _dragOY + dy
	// Clamp to reasonable bounds
	nx = Math.max(-NODE_W * 0.5, nx)
	ny = Math.max(-NODE_H * 0.5, ny)
	_layout[_dragNode].x = nx
	_layout[_dragNode].y = ny
	// Move the SVG group
	var g = _svgn.querySelector('.node-group[data-agent="' + esc(_dragNode) + '"]')
	if (g) g.setAttribute("transform", "translate(" + nx + "," + ny + ")")
	// Update all edges that connect to this agent
	updateConnectedEdges(_dragNode)
}
function endDrag(e) {
	if (!_dragNode) return
	var g = _svgn.querySelector('.node-group[data-agent="' + esc(_dragNode) + '"]')
	if (g) {
		g.classList.remove("dragging")
		g.removeAttribute("filter")
	}
	_dragNode = null
}
function updateConnectedEdges(agent) {
	if (!_edges || !_layout || !_layers || !_svgEl) return
	for (var ei = 0; ei < _edges.length; ei++) {
		var e = _edges[ei]
		if (e.from !== agent && e.to !== agent) continue
		var fn = _layout[e.from],
			tn = _layout[e.to]
		if (!fn || !tn) continue
		var fromLayer = _layers[e.from],
			toLayer = _layers[e.to]
		var key = esc(e.from) + "__" + esc(e.to) + "__" + e.idx
		var eg = _svgEl.querySelector('.edge-group[data-edge="' + key + '"]')
		if (!eg) continue
		var d = edgePathData(fn.x, fn.y, tn.x, tn.y, e.idx, e.total, fromLayer, toLayer)
		var hit = eg.querySelector(".edge-hit")
		var path = eg.querySelector(".edge-path")
		if (hit) hit.setAttribute("d", d)
		if (path) path.setAttribute("d", d)
		// Also update the edge label position so it follows the arrow
		var lblRect = eg.querySelector(".edge-label-bg")
		var lblText = eg.querySelector(".edge-label")
		if (lblRect && lblText && e.label) {
			var x1 = fn.x + NODE_W,
				y1 = fn.y + NODE_H / 2,
				x2 = tn.x,
				y2 = tn.y + NODE_H / 2
			var ecx, ecy
			if (fromLayer != null && toLayer != null && fromLayer >= toLayer) {
				var arcH2 = Math.max(60, Math.abs(fromLayer - toLayer) * 50 + 20)
				ecx = (x1 + x2) / 2
				ecy = (y1 + y2) / 2 - arcH2 * 0.7
			} else {
				ecx = (x1 + x2) / 2
				ecy = (y1 + y2) / 2
			}
			var lw2 = esc(e.label).length * 6.5 + 10
			lblRect.setAttribute("x", ecx - lw2 / 2)
			lblRect.setAttribute("y", ecy - 9)
			lblText.setAttribute("x", ecx)
			lblText.setAttribute("y", ecy + 5)
		}
	}
}
// ── main render ──
function render(payload) {
	var flow = payload.flow,
		diags = payload.diags || []
	var app = document.getElementById("app")
	var diagsEl = document.getElementById("diags")
	if (!flow) {
		app.innerHTML = '<div class="empty"><h2>No flow found</h2></div>'
		return
	}
	// ── header ──
	var h = '<div class="flow-header"><h2><span>⚡</span> flow "' + esc(flow.name) + '"</h2>'
	if (flow.params && flow.params.length > 0) {
		h += '<div class="params">Params: '
		for (var i = 0; i < flow.params.length; i++) {
			var p = flow.params[i]
			h += "<code>" + esc(p.name) + ': "' + esc(p.paramType) + '"</code>'
			if (i < flow.params.length - 1) h += ", "
		}
		h += "</div>"
	}
	h += '<div class="constraints">'
	var hasCon = false,
		hasBud = false
	for (var bi = 0; bi < (flow.body || []).length; bi++) {
		var bItem = flow.body[bi]
		if (bItem.type === "ConvergeStmt") {
			hasCon = true
			h += '<span>🎯 Converge when: <span class="badge">' + esc(exprStr(bItem.condition)) + "</span></span>"
		}
		if (bItem.type === "BudgetStmt" && bItem.items) {
			hasBud = true
			for (var bj = 0; bj < bItem.items.length; bj++) {
				var bi2 = bItem.items[bj]
				h += "<span>💰 " + esc(bi2.kind) + ': <span class="badge">' + esc(exprStr(bi2.value)) + "</span></span>"
			}
		}
	}
	if (!hasCon) h += '<span style="opacity:0.5">No converge statement</span>'
	if (!hasBud) h += '<span style="opacity:0.5">Default budget (30 rounds, 300k tokens)</span>'
	h += "</div></div>"
	h += '<div class="graph-hint">🖱️ Drag nodes to rearrange &nbsp;|&nbsp; 🔄 Auto-layout from topology</div>'
	// ── build graph data ──
	var agentNames = {}
	var agentMeta = {}
	for (var ai = 0; ai < (flow.body || []).length; ai++) {
		var agent = flow.body[ai]
		if (agent.type !== "AgentDecl") continue
		agentNames[agent.name] = true
		agentMeta[agent.name] = {
			mode: agent.meta && agent.meta.mode ? agent.meta.mode : "",
			role: agent.meta && agent.meta.role ? agent.meta.role : "",
			hasLoop: scanForLoops(agent.operations),
		}
	}
	var rawEdges = buildGraphEdges(flow)
	_layers = assignLayers(agentNames, rawEdges)
	var cols = buildColumns(_layers, agentNames)
	// Compute positions with vertical centering within each column.
	var maxColHeight = 0
	for (var ci = 0; ci < cols.length; ci++) {
		var ch = cols[ci].length * NODE_GAP_Y
		if (ch > maxColHeight) maxColHeight = ch
	}
	if (maxColHeight === 0) maxColHeight = NODE_GAP_Y
	_layout = {}
	for (var ci = 0; ci < cols.length; ci++) {
		var col = cols[ci]
		var x = MARGIN + ci * NODE_GAP_X
		var colH = col.length * NODE_GAP_Y
		var y0 = MARGIN + (maxColHeight - colH) / 2 // vertical centering
		for (var ri = 0; ri < col.length; ri++) {
			_layout[col[ri]] = { x: x, y: y0 + ri * NODE_GAP_Y }
		}
	}
	// Deduplicate edges: merge same (from→to×kind) into one edge with combined label
	var mergeMap = {}
	for (var ei = 0; ei < rawEdges.length; ei++) {
		var re = rawEdges[ei],
			mk = re.from + "|||" + re.to + "|||" + re.kind
		if (!mergeMap[mk]) mergeMap[mk] = { from: re.from, to: re.to, kind: re.kind, labels: [] }
		if (mergeMap[mk].labels.indexOf(re.label) === -1) mergeMap[mk].labels.push(re.label)
	}
	_edges = []
	var mergeKeys = Object.keys(mergeMap)
	for (var pi = 0; pi < mergeKeys.length; pi++) {
		var g = mergeMap[mergeKeys[pi]]
		var lbl = g.labels.length === 1 ? g.labels[0] : g.labels[0] + " (+" + (g.labels.length - 1) + " more)"
		_edges.push({ from: g.from, to: g.to, label: lbl, kind: g.kind, idx: 0, total: 1 })
	}
	// ── SVG dimensions ──
	var svgW = cols.length * NODE_GAP_X + NODE_W + 2 * MARGIN
	var svgH = maxColHeight + NODE_H + MARGIN * 2
	if (cols.length === 0) {
		svgW = 400
		svgH = 120
	}
	if (svgW < 500) svgW = 500
	if (svgH < 300) svgH = 300
	// ── assemble SVG ──
	var svg = '<svg id="slang-svg" width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg">'
	svg += defs()
	// Edge layer (below nodes)
	svg += '<g id="edge-layer">'
	for (var ei = 0; ei < _edges.length; ei++) {
		svg += renderEdge(_edges[ei], _edges[ei].idx, _edges[ei].total, _layout, _layers)
	}
	svg += "</g>"
	// Node layer
	svg += '<g id="node-layer">'
	var names = Object.keys(_layout)
	for (var ni = 0; ni < names.length; ni++) {
		var nm = names[ni],
			pos = _layout[nm],
			meta = agentMeta[nm] || {}
		svg += '<g class="node-group" data-agent="' + esc(nm) + '" transform="translate(' + pos.x + "," + pos.y + ')">'
		var nc = meta.hasLoop ? "node-rect loop-rect" : "node-rect"
		svg += '<rect class="' + nc + '" x="0" y="0" width="' + NODE_W + '" height="' + NODE_H + '" rx="9" />'
		svg += renderNode(nm, meta)
		svg += "</g>"
	}
	svg += "</g>"
	svg += "</svg>"
	h += '<div class="graph-container">' + svg + "</div>"
	app.innerHTML = h
	// ── diags ──
	if (diags.length > 0) {
		var dHtml = ""
		for (var di = 0; di < diags.length; di++) {
			var d = diags[di],
				isErr = d.indexOf("[error]") !== -1
			dHtml +=
				'<div class="diag-item' +
				(isErr ? " z-error" : " z-warning") +
				'"><span class="diag-tag">' +
				(isErr ? "ERROR" : "WARN") +
				"</span>" +
				esc(d) +
				"</div>"
		}
		diagsEl.innerHTML = dHtml
	} else {
		diagsEl.innerHTML = ""
	}
	// ── wire up drag handlers ──
	_svgn = document
	_svgEl = document.getElementById("slang-svg")
	var groups = _svgEl ? Array.prototype.slice.call(_svgEl.querySelectorAll(".node-group")) : []
	for (var gi = 0; gi < groups.length; gi++) {
		var g = groups[gi]
		g.addEventListener("mousedown", beginDrag)
	}
	document.addEventListener("mousemove", moveDrag)
	document.addEventListener("mouseup", endDrag)
}
