/* eslint-env browser */
/* eslint-disable no-redeclare, no-prototype-builtins, no-undef */

// ── view engine state router ──
var _currentView = "topology" // 'topology' | 'sequence' | 'swimlane'
var _lastPayload = null

function esc(s) {
	return String(s)
		.replace(/&/g, String.fromCharCode(38) + "amp;")
		.replace(/</g, String.fromCharCode(38) + "lt;")
		.replace(/>/g, String.fromCharCode(38) + "gt;")
		.replace(/"/g, String.fromCharCode(38) + "quot;")
}

function safeRender(payload) {
	try {
		if (payload) _lastPayload = payload
		render(_lastPayload)
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

// Global binding deployment to make layout selectors clickable anywhere
window.switchView = function (viewName) {
	_currentView = viewName
	safeRender(null)
}

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

function scanForLoops(ops) {
	if (!ops) return false
	for (var i = 0; i < ops.length; i++) {
		var o = ops[i]
		if (o.type === "RepeatBlock") return true
		if (o.type === "WhenBlock") {
			if (scanForLoops(o.body)) return true
			if (o.elseBlock && scanForLoops(o.elseBlock.body)) return true
		}
	}
	return false
}

var COLORS = {
	stake: "var(--z-stake,#f59e0b)",
	await: "var(--z-await,#a855f7)",
	agent: "var(--z-agent,#22c55e)",
	flow: "var(--z-flow,#3b82f6)",
	meta: "var(--z-meta,#888)",
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
						if (isAgentRef(to)) {
							edges.push({ from: from, to: to, label: op.call ? op.call.name : "stake", kind: "stake" })
						}
					}
				}
				if (op.type === "AwaitOp" && op.sources) {
					for (var k = 0; k < op.sources.length; k++) {
						var src = op.sources[k],
							srcRef = src.ref || src
						if (isAgentRef(srcRef)) {
							edges.push({ from: srcRef, to: from, label: op.binding || "await", kind: "await" })
						}
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
	var maxLayer = 0,
		keys = Object.keys(layer)
	for (var i = 0; i < keys.length; i++) {
		if (layer[keys[i]] > maxLayer) maxLayer = layer[keys[i]]
	}
	var cols = []
	for (var i = 0; i <= maxLayer; i++) cols.push([])
	for (var i = 0; i < keys.length; i++) cols[layer[keys[i]]].push(keys[i])
	return cols
}

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
		'<marker id="ah-seq-stake" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">' +
		'<polygon points="0 0, 8 3, 0 6" fill="' +
		COLORS.stake +
		'"/></marker>' +
		'<marker id="ah-seq-await" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">' +
		'<polygon points="0 0, 8 3, 0 6" fill="' +
		COLORS.await +
		'"/></marker>' +
		"</defs>"
	)
}

function renderNode(nm, meta) {
	var color = COLORS.agent
	var mode = meta.mode,
		role = meta.role
	var s =
		'<rect class="node-header" x="1" y="1" width="' +
		(NODE_W - 2) +
		'" height="26" rx="7" fill="' +
		color +
		'" opacity="0.15" />'
	s +=
		'<text x="14" y="20" font-size="13" font-weight="700" fill="' +
		color +
		'" style="pointer-events:none">@' +
		esc(nm) +
		"</text>"
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
	return s
}

function edgePathData(fromX, fromY, toX, toY, idx, total, fromLayer, toLayer) {
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
	var curve = Math.min(dx * 0.45, 140)
	if (fromLayer != null && toLayer != null && fromLayer >= toLayer) {
		var arcH = Math.max(60, Math.abs(fromLayer - toLayer) * 50 + 20)
		return "M" + x1 + "," + y1 + " C" + x1 + "," + (y1 - arcH) + " " + x2 + "," + (y2 - arcH) + " " + x2 + "," + y2
	}
	return "M" + x1 + "," + y1 + " C" + (x1 + curve) + "," + y1 + " " + (x2 - curve) + "," + y2 + " " + x2 + "," + y2
}

function renderEdge(e, idx, total, layout, layers) {
	var fn = layout[e.from],
		tn = layout[e.to]
	if (!fn || !tn) return ""
	var fromLayer = layers[e.from],
		toLayer = layers[e.to]
	var d = edgePathData(fn.x, fn.y, tn.x, tn.y, idx, total, fromLayer, toLayer)
	var color = e.kind === "stake" ? COLORS.stake : COLORS.await
	var marker = e.kind === "stake" ? "url(#ah-stake)" : "url(#ah-await)"
	var key = esc(e.from) + "__" + esc(e.to) + "__" + e.kind + "__" + idx
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
	if (e.label) {
		var cx,
			cy,
			x1 = fn.x + NODE_W,
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

// ── view compiler 1: network topology graphics ──
function compileTopologySVG(flow, agentNames, agentMeta) {
	var rawEdges = buildGraphEdges(flow)
	_layers = assignLayers(agentNames, rawEdges)
	var cols = buildColumns(_layers, agentNames)
	var maxColHeight = 0
	for (var ci = 0; ci < cols.length; ci++) {
		var ch = cols[ci].length * NODE_GAP_Y
		if (ch > maxColHeight) maxColHeight = ch
	}
	if (maxColHeight === 0) maxColHeight = NODE_GAP_Y
	_layout = {}
	for (var ci = 0; ci < cols.length; ci++) {
		var col = cols[ci],
			x = MARGIN + ci * NODE_GAP_X,
			colH = col.length * NODE_GAP_Y,
			y0 = MARGIN + (maxColHeight - colH) / 2
		for (var ri = 0; ri < col.length; ri++) _layout[col[ri]] = { x: x, y: y0 + ri * NODE_GAP_Y }
	}
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
		var g = mergeMap[mergeKeys[pi]],
			lbl = g.labels.length === 1 ? g.labels[0] : g.labels[0] + " (+" + (g.labels.length - 1) + " more)"
		_edges.push({ from: g.from, to: g.to, label: lbl, kind: g.kind, idx: 0, total: 1 })
	}
	var svgW = Math.max(500, cols.length * NODE_GAP_X + NODE_W + 2 * MARGIN)
	var svgH = Math.max(300, maxColHeight + NODE_H + MARGIN * 2)

	var svg =
		'<svg id="slang-svg" width="' +
		svgW +
		'" height="' +
		svgH +
		'" xmlns="http://www.w3.org/2000/svg">' +
		defs() +
		'<g id="edge-layer">'
	for (var ei = 0; ei < _edges.length; ei++)
		svg += renderEdge(_edges[ei], _edges[ei].idx, _edges[ei].total, _layout, _layers)
	svg += '</g><g id="node-layer">'
	var names = Object.keys(_layout)
	for (var ni = 0; ni < names.length; ni++) {
		var nm = names[ni],
			pos = _layout[nm],
			meta = agentMeta[nm] || {},
			nc = "node-rect"
		svg += '<g class="node-group" data-agent="' + esc(nm) + '" transform="translate(' + pos.x + "," + pos.y + ')">'
		svg += '<rect class="' + nc + '" x="0" y="0" width="' + NODE_W + '" height="' + NODE_H + '" rx="9" />'
		svg += renderNode(nm, meta) + "</g>"
	}
	return svg + "</g></svg>"
}

// ── view compiler 2: sequence diagram chronology ──
function compileSequenceSVG(flow, agentNames) {
	var agentKeys = Object.keys(agentNames)
	for (var ak = 0; ak < agentKeys.length; ak++) agentKeys[ak] = "@" + agentKeys[ak]
	var columns = ["@Human"].concat(agentKeys)
	var COL_W = 220,
		STEP_H = 50,
		TOP_PAD = 60
	var timelineEvents = []

	for (var ai = 0; ai < (flow.body || []).length; ai++) {
		var agent = flow.body[ai]
		if (agent.type !== "AgentDecl") continue
		var from = agent.name

		function extractTimeline(ops, depth) {
			if (!ops) return
			depth = depth || 0
			// Only recurse into conditionals/loops one level deep to avoid
			// exploding the timeline with duplicate inner-body events.
			var maxDepth = 1
			for (var i = 0; i < ops.length; i++) {
				var op = ops[i]
				if (op.type === "StakeOp" && op.recipients) {
					for (var j = 0; j < op.recipients.length; j++) {
						var to = op.recipients[j].ref || op.recipients[j]
						if (agentNames[to])
							timelineEvents.push({
								from: from,
								to: to,
								label: "stake " + (op.call ? op.call.name : ""),
								type: "stake",
							})
					}
				}
				if (op.type === "AwaitOp" && op.sources) {
					for (var k = 0; k < op.sources.length; k++) {
						var src = op.sources[k].ref || op.sources[k]
						if (agentNames[src])
							timelineEvents.push({
								from: src,
								to: from,
								label: "await " + (op.binding || ""),
								type: "await",
							})
						if (src === "Human")
							timelineEvents.push({ from: "@Human", to: from, label: "user reply", type: "await" })
					}
				}
				if (op.type === "EscalateOp") {
					timelineEvents.push({
						from: from,
						to: "@Human",
						label: "escalate (" + (op.reason || "approval") + ")",
						type: "stake",
					})
				}
				if (depth < maxDepth) {
					if (op.type === "WhenBlock") {
						extractTimeline(op.body, depth + 1)
						if (op.elseBlock) extractTimeline(op.elseBlock.body, depth + 1)
					}
					if (op.type === "RepeatBlock") extractTimeline(op.body, depth + 1)
				}
			}
		}
		extractTimeline(agent.operations)
	}

	var svgW = Math.max(600, columns.length * COL_W + MARGIN * 2)
	var svgH = Math.max(400, timelineEvents.length * STEP_H + TOP_PAD + 100)
	var s = '<svg width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg">' + defs()

	for (var i = 0; i < columns.length; i++) {
		var cx = MARGIN + i * COL_W + COL_W / 2
		s +=
			'<line class="lifeline-track" x1="' +
			cx +
			'" y1="' +
			TOP_PAD +
			'" x2="' +
			cx +
			'" y2="' +
			(svgH - 40) +
			'" />'
		s +=
			'<rect x="' +
			(cx - 70) +
			'" y="' +
			(TOP_PAD - 40) +
			'" width="140" height="30" rx="4" fill="var(--z-card-bg)" stroke="var(--z-card-border)" />'
		var color = columns[i] === "@Human" ? COLORS.flow : COLORS.agent
		s +=
			'<text x="' +
			cx +
			'" y="' +
			(TOP_PAD - 20) +
			'" text-anchor="middle" font-weight="700" fill="' +
			color +
			'">' +
			esc(columns[i]) +
			"</text>"
	}

	for (var e = 0; e < timelineEvents.length; e++) {
		var ev = timelineEvents[e]
		var fIdx = columns.indexOf(ev.from.startsWith("@") ? ev.from : "@" + ev.from)
		var tIdx = columns.indexOf(ev.to.startsWith("@") ? ev.to : "@" + ev.to)
		if (fIdx === -1 || tIdx === -1) continue

		var x1 = MARGIN + fIdx * COL_W + COL_W / 2
		var x2 = MARGIN + tIdx * COL_W + COL_W / 2
		var y = TOP_PAD + 30 + e * STEP_H
		var color = ev.type === "stake" ? COLORS.stake : COLORS.await
		var marker = ev.type === "stake" ? "url(#ah-seq-stake)" : "url(#ah-seq-await)"

		s += '<g class="sequence-group">'
		s +=
			'<line class="sequence-line" x1="' +
			x1 +
			'" y1="' +
			y +
			'" x2="' +
			x2 +
			'" y2="' +
			y +
			'" stroke="' +
			color +
			'" marker-end="' +
			marker +
			'" />'
		s +=
			'<text class="sequence-text" x="' +
			(x1 + x2) / 2 +
			'" y="' +
			(y - 6) +
			'" text-anchor="middle" fill="' +
			color +
			'">' +
			esc(ev.label) +
			"</text>"
		s += "</g>"
	}
	if (timelineEvents.length === 0) {
		s +=
			'<text x="' +
			svgW / 2 +
			'" y="' +
			(TOP_PAD + 60) +
			'" text-anchor="middle" fill="var(--z-meta)">No active message transmissions parsed inside this block.</text>'
	}
	return s + "</svg>"
}

// ── view compiler 3: procedural swimlane logic flowchart ──
function compileSwimlaneSVG(flow, agentNames) {
	var agents = []
	for (var ai = 0; ai < (flow.body || []).length; ai++) {
		if (flow.body[ai].type === "AgentDecl") agents.push(flow.body[ai])
	}

	// Recursive operation counter for lane sizing
	function countOps(ops) {
		if (!ops) return 0
		var n = 0
		for (var i = 0; i < ops.length; i++) {
			var o = ops[i]
			n++
			if (o.type === "WhenBlock") {
				n += countOps(o.body)
				if (o.elseBlock) n += countOps(o.elseBlock.body)
			}
			if (o.type === "RepeatBlock") n += countOps(o.body)
		}
		return n
	}

	var LANE_W = 260,
		BLOCK_W = 180,
		BLOCK_H = 32,
		SPACING_Y = 48
	var svgW = Math.max(500, agents.length * LANE_W + MARGIN * 2)
	var maxLaneHeight = 200
	for (var i = 0; i < agents.length; i++) {
		var est = countOps(agents[i].operations) * SPACING_Y + 140
		if (est > maxLaneHeight) maxLaneHeight = est
	}

	var s = '<svg width="' + svgW + '" height="' + maxLaneHeight + '" xmlns="http://www.w3.org/2000/svg">' + defs()

	// Mutable Y cursor shared across recursive calls
	var _cy = 0

	// Render a single operation; mutates _cy and returns SVG fragment
	function renderOp(op, spineX, depth) {
		var str = ""
		var opacity = depth > 0 ? "0.7" : "1"

		if (op.type === "StakeOp") {
			var lbl = "STAKE: " + esc(op.call ? op.call.name : "func") + "()"
			str +=
				'<rect class="flow-box" x="' +
				(spineX - BLOCK_W / 2) +
				'" y="' +
				_cy +
				'" width="' +
				BLOCK_W +
				'" height="' +
				BLOCK_H +
				'" stroke="' +
				COLORS.stake +
				'" opacity="' +
				opacity +
				'" />'
			str +=
				'<text class="flow-text" x="' +
				spineX +
				'" y="' +
				(_cy + 19) +
				'" text-anchor="middle" fill="var(--z-fg)" opacity="' +
				opacity +
				'">' +
				lbl +
				"</text>"
			str +=
				'<line class="flow-spine" x1="' +
				spineX +
				'" y1="' +
				(_cy + BLOCK_H) +
				'" x2="' +
				spineX +
				'" y2="' +
				(_cy + SPACING_Y) +
				'" opacity="' +
				opacity +
				'" />'
			_cy += SPACING_Y
		} else if (op.type === "AwaitOp") {
			var albl = "AWAIT <- " + esc(op.binding || "msg")
			str +=
				'<rect class="flow-box" x="' +
				(spineX - BLOCK_W / 2) +
				'" y="' +
				_cy +
				'" width="' +
				BLOCK_W +
				'" height="' +
				BLOCK_H +
				'" stroke="' +
				COLORS.await +
				'" opacity="' +
				opacity +
				'" />'
			str +=
				'<text class="flow-text" x="' +
				spineX +
				'" y="' +
				(_cy + 19) +
				'" text-anchor="middle" fill="var(--z-fg)" opacity="' +
				opacity +
				'">' +
				albl +
				"</text>"
			str +=
				'<line class="flow-spine" x1="' +
				spineX +
				'" y1="' +
				(_cy + BLOCK_H) +
				'" x2="' +
				spineX +
				'" y2="' +
				(_cy + SPACING_Y) +
				'" opacity="' +
				opacity +
				'" />'
			_cy += SPACING_Y
		} else if (op.type === "EscalateOp") {
			var ereason = op.reason ? esc(op.reason) : "approval"
			str +=
				'<rect class="flow-box" x="' +
				(spineX - BLOCK_W / 2) +
				'" y="' +
				_cy +
				'" width="' +
				BLOCK_W +
				'" height="' +
				BLOCK_H +
				'" stroke="' +
				COLORS.flow +
				'" rx="10" opacity="' +
				opacity +
				'" />'
			str +=
				'<text class="flow-text" x="' +
				spineX +
				'" y="' +
				(_cy + 19) +
				'" text-anchor="middle" fill="' +
				COLORS.flow +
				'" font-weight="700" opacity="' +
				opacity +
				'">ESCALATE @Human: ' +
				ereason +
				"</text>"
			str +=
				'<line class="flow-spine" x1="' +
				spineX +
				'" y1="' +
				(_cy + BLOCK_H) +
				'" x2="' +
				spineX +
				'" y2="' +
				(_cy + SPACING_Y) +
				'" opacity="' +
				opacity +
				'" />'
			_cy += SPACING_Y
		} else if (op.type === "LetOp" || op.type === "SetOp") {
			var tagOp = op.type === "LetOp" ? "LET " : "SET "
			var vname = esc(op.name || "?")
			var vval = op.value ? exprShort(op.value, 22) : "?"
			str +=
				'<rect class="flow-box" x="' +
				(spineX - BLOCK_W / 2) +
				'" y="' +
				_cy +
				'" width="' +
				BLOCK_W +
				'" height="' +
				BLOCK_H +
				'" stroke="var(--z-card-border)" opacity="' +
				opacity +
				'" />'
			str +=
				'<text class="flow-text" x="' +
				spineX +
				'" y="' +
				(_cy + 19) +
				'" text-anchor="middle" fill="var(--z-meta)" opacity="' +
				opacity +
				'">' +
				esc(tagOp + vname + " = " + vval) +
				"</text>"
			str +=
				'<line class="flow-spine" x1="' +
				spineX +
				'" y1="' +
				(_cy + BLOCK_H) +
				'" x2="' +
				spineX +
				'" y2="' +
				(_cy + SPACING_Y) +
				'" opacity="' +
				opacity +
				'" />'
			_cy += SPACING_Y
		} else if (op.type === "WhenBlock") {
			var wcond = op.condition ? exprShort(op.condition, 16) : "?"
			var pts =
				spineX +
				"," +
				_cy +
				" " +
				(spineX + BLOCK_W / 2) +
				"," +
				(_cy + BLOCK_H / 2) +
				" " +
				spineX +
				"," +
				(_cy + BLOCK_H) +
				" " +
				(spineX - BLOCK_W / 2) +
				"," +
				(_cy + BLOCK_H / 2)
			str +=
				'<polygon class="flow-diamond" points="' +
				pts +
				'" stroke="' +
				COLORS.flow +
				'" opacity="' +
				opacity +
				'" />'
			str +=
				'<text class="flow-text" x="' +
				spineX +
				'" y="' +
				(_cy + 19) +
				'" text-anchor="middle" fill="' +
				COLORS.flow +
				'" font-weight="700" opacity="' +
				opacity +
				'">WHEN: ' +
				esc(wcond) +
				"</text>"
			_cy += SPACING_Y
			str += renderOpList(op.body, spineX, depth + 1)
			if (op.elseBlock && op.elseBlock.body && op.elseBlock.body.length > 0) {
				_cy += Math.floor(SPACING_Y / 2)
				var oPts =
					spineX +
					"," +
					_cy +
					" " +
					(spineX + BLOCK_W / 2) +
					"," +
					(_cy + BLOCK_H / 2) +
					" " +
					spineX +
					"," +
					(_cy + BLOCK_H) +
					" " +
					(spineX - BLOCK_W / 2) +
					"," +
					(_cy + BLOCK_H / 2)
				str +=
					'<polygon class="flow-diamond" points="' +
					oPts +
					'" stroke="var(--z-meta)" opacity="' +
					opacity +
					'" />'
				str +=
					'<text class="flow-text" x="' +
					spineX +
					'" y="' +
					(_cy + 19) +
					'" text-anchor="middle" fill="var(--z-meta)" font-weight="600" opacity="' +
					opacity +
					'">OTHERWISE</text>'
				_cy += SPACING_Y
				str += renderOpList(op.elseBlock.body, spineX, depth + 1)
			}
		} else if (op.type === "RepeatBlock") {
			var rcond = op.condition ? exprShort(op.condition, 16) : "?"
			var rPts =
				spineX +
				"," +
				_cy +
				" " +
				(spineX + BLOCK_W / 2) +
				"," +
				(_cy + BLOCK_H / 2) +
				" " +
				spineX +
				"," +
				(_cy + BLOCK_H) +
				" " +
				(spineX - BLOCK_W / 2) +
				"," +
				(_cy + BLOCK_H / 2)
			str +=
				'<polygon class="flow-diamond" points="' +
				rPts +
				'" stroke="' +
				COLORS.flow +
				'" opacity="' +
				opacity +
				'" />'
			str +=
				'<text class="flow-text" x="' +
				spineX +
				'" y="' +
				(_cy + 19) +
				'" text-anchor="middle" fill="' +
				COLORS.flow +
				'" font-weight="700" opacity="' +
				opacity +
				'">REPEAT UNTIL: ' +
				esc(rcond) +
				"</text>"
			_cy += SPACING_Y
			str += renderOpList(op.body, spineX, depth + 1)
		} else if (op.type === "CommitOp") {
			str +=
				'<rect class="flow-box" x="' +
				(spineX - BLOCK_W / 2) +
				'" y="' +
				_cy +
				'" width="' +
				BLOCK_W +
				'" height="' +
				BLOCK_H +
				'" stroke="' +
				COLORS.agent +
				'" rx="10" opacity="' +
				opacity +
				'" />'
			str +=
				'<text class="flow-text" x="' +
				spineX +
				'" y="' +
				(_cy + 19) +
				'" text-anchor="middle" fill="' +
				COLORS.agent +
				'" font-weight="700" opacity="' +
				opacity +
				'">COMMIT</text>'
			str +=
				'<line class="flow-spine" x1="' +
				spineX +
				'" y1="' +
				(_cy + BLOCK_H) +
				'" x2="' +
				spineX +
				'" y2="' +
				(_cy + SPACING_Y) +
				'" opacity="' +
				opacity +
				'" />'
			_cy += SPACING_Y
		} else {
			str +=
				'<rect class="flow-box" x="' +
				(spineX - BLOCK_W / 2) +
				'" y="' +
				_cy +
				'" width="' +
				BLOCK_W +
				'" height="' +
				BLOCK_H +
				'" stroke="var(--z-card-border)" opacity="' +
				opacity +
				'" />'
			str +=
				'<text class="flow-text" x="' +
				spineX +
				'" y="' +
				(_cy + 19) +
				'" text-anchor="middle" fill="var(--z-meta)" opacity="' +
				opacity +
				'">' +
				esc(op.type) +
				"</text>"
			str +=
				'<line class="flow-spine" x1="' +
				spineX +
				'" y1="' +
				(_cy + BLOCK_H) +
				'" x2="' +
				spineX +
				'" y2="' +
				(_cy + SPACING_Y) +
				'" opacity="' +
				opacity +
				'" />'
			_cy += SPACING_Y
		}
		return str
	}

	// Render a list of operations recursively
	function renderOpList(ops, spineX, depth) {
		if (!ops) return ""
		var str = ""
		for (var j = 0; j < ops.length; j++) {
			str += renderOp(ops[j], spineX, depth)
		}
		return str
	}

	// Render each agent lane
	for (var i = 0; i < agents.length; i++) {
		var ag = agents[i]
		var lx = MARGIN + i * LANE_W
		s +=
			'<rect class="swimlane-bg" x="' +
			lx +
			'" y="20" width="' +
			(LANE_W - 10) +
			'" height="' +
			(maxLaneHeight - 40) +
			'" rx="6" />'
		s +=
			'<text class="swimlane-label" x="' +
			(lx + 15) +
			'" y="42" fill="' +
			COLORS.agent +
			'">agent ' +
			esc(ag.name) +
			"</text>"

		_cy = 70
		var midX = lx + (LANE_W - 10) / 2
		s += '<line class="flow-spine" x1="' + midX + '" y1="' + _cy + '" x2="' + midX + '" y2="' + (_cy + 15) + '" />'
		_cy += 15

		s += renderOpList(ag.operations, midX, 0)
		s += '<circle cx="' + midX + '" cy="' + _cy + '" r="5" fill="var(--z-card-border)" />'
	}
	return s + "</svg>"
}

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
	var g = e.currentTarget,
		agent = g.getAttribute("data-agent")
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
	var nx = _dragOX + (e.clientX - _dragSX),
		ny = _dragOY + (e.clientY - _dragSY)
	nx = Math.max(-NODE_W * 0.5, nx)
	ny = Math.max(-NODE_H * 0.5, ny)
	_layout[_dragNode].x = nx
	_layout[_dragNode].y = ny
	var g = _svgn.querySelector('.node-group[data-agent="' + esc(_dragNode) + '"]')
	if (g) g.setAttribute("transform", "translate(" + nx + "," + ny + ")")
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
		var d = edgePathData(fn.x, fn.y, tn.x, tn.y, e.idx, e.total, _layers[e.from], _layers[e.to])
		var eg = _svgEl.querySelector('.edge-group[data-edge="' + esc(e.from) + "__" + esc(e.to) + "__" + e.idx + '"]')
		if (!eg) continue
		var hit = eg.querySelector(".edge-hit"),
			path = eg.querySelector(".edge-path")
		if (hit) hit.setAttribute("d", d)
		if (path) path.setAttribute("d", d)
		var lblRect = eg.querySelector(".edge-label-bg"),
			lblText = eg.querySelector(".edge-label")
		if (lblRect && lblText && e.label) {
			var ecx,
				ecy,
				x1 = fn.x + NODE_W,
				y1 = fn.y + NODE_H / 2,
				x2 = tn.x,
				y2 = tn.y + NODE_H / 2
			if (_layers[e.from] >= _layers[e.to]) {
				var arcH2 = Math.max(60, Math.abs(_layers[e.from] - _layers[e.to]) * 50 + 20)
				ecx = (x1 + x2) / 2
				ecy = (y1 + y2) / 2 - arcH2 * 0.7
			} else {
				ecx = (x1 + x2) / 2
				ecy = (y1 + y2) / 2
			}
			lblRect.setAttribute("x", ecx - (e.label.length * 6.5 + 10) / 2)
			lblRect.setAttribute("y", ecy - 9)
			lblText.setAttribute("x", ecx)
			lblText.setAttribute("y", ecy + 5)
		}
	}
}

// ── main orchestration layout router ──
function render(payload) {
	var flow = payload.flow,
		diags = payload.diags || []
	var app = document.getElementById("app"),
		diagsEl = document.getElementById("diags")
	if (!flow) {
		app.innerHTML = '<div class="empty"><h2>No flow found</h2></div>'
		return
	}

	var h = '<div class="flow-header"><h2><span>⚡</span> flow "' + esc(flow.name) + '"</h2>'
	if (flow.params && flow.params.length > 0) {
		h += '<div class="params">Params: '
		for (var i = 0; i < flow.params.length; i++) {
			h +=
				"<code>" +
				esc(flow.params[i].name) +
				': "' +
				esc(flow.params[i].paramType) +
				'"</code>' +
				(i < flow.params.length - 1 ? ", " : "")
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
			for (var bj = 0; bj < bItem.items.length; bj++)
				h +=
					"<span>💰 " +
					esc(bItem.items[bj].kind) +
					': <span class="badge">' +
					esc(exprStr(bItem.items[bj].value)) +
					"</span></span>"
		}
	}
	if (!hasCon) h += '<span style="opacity:0.5">No converge statement</span>'
	if (!hasBud) h += '<span style="opacity:0.5">Default budget (30 rounds, 300k tokens)</span>'
	h += "</div></div>"

	// Dynamic tab rendering interface block — data-view attributes (not onclick)
	// because the CSP script-src nonce blocks inline event handlers.
	h +=
		'<div class="view-selector-tabs">' +
		'<button class="tab-btn' +
		(_currentView === "topology" ? " active" : "") +
		'" data-view="topology">Topology Network</button>' +
		'<button class="tab-btn' +
		(_currentView === "sequence" ? " active" : "") +
		'" data-view="sequence">Sequence Timeline</button>' +
		'<button class="tab-btn' +
		(_currentView === "swimlane" ? " active" : "") +
		'" data-view="swimlane">Agent Logic Flow</button>' +
		"</div>"

	if (_currentView === "topology") {
		h +=
			'<div class="graph-hint">🖱️ Drag nodes to rearrange &nbsp;|&nbsp; 🔄 Auto-layout from topology layers</div>'
	} else if (_currentView === "sequence") {
		h += '<div class="graph-hint">⏱️ Message-passing chronology mapped top-to-bottom across processing tracks</div>'
	} else {
		h +=
			'<div class="graph-hint">🧬 Sequential operation blocks and branching statements broken down per agent lane</div>'
	}

	var agentNames = {},
		agentMeta = {}
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

	var renderingBox = ""
	if (_currentView === "topology") {
		renderingBox = compileTopologySVG(flow, agentNames, agentMeta)
	} else if (_currentView === "sequence") {
		renderingBox = compileSequenceSVG(flow, agentNames)
	} else if (_currentView === "swimlane") {
		renderingBox = compileSwimlaneSVG(flow, agentNames)
	}

	h += '<div class="graph-container">' + renderingBox + "</div>"
	app.innerHTML = h

	if (diags.length > 0) {
		var dHtml = ""
		for (var di = 0; di < diags.length; di++) {
			var isErr = diags[di].indexOf("[error]") !== -1
			dHtml +=
				'<div class="diag-item' +
				(isErr ? " z-error" : " z-warning") +
				'"><span class="diag-tag">' +
				(isErr ? "ERROR" : "WARN") +
				"</span>" +
				esc(diags[di]) +
				"</div>"
		}
		diagsEl.innerHTML = dHtml
	} else {
		diagsEl.innerHTML = ""
	}

	// Wire tab buttons via JS (CSP-safe, no inline onclick)
	var tabBtns = document.querySelectorAll(".tab-btn[data-view]")
	for (var ti = 0; ti < tabBtns.length; ti++) {
		tabBtns[ti].addEventListener("click", function () {
			var view = this.getAttribute("data-view")
			console.log("[slang-render] tab clicked: " + view)
			_currentView = view
			safeRender(null)
		})
	}

	if (_currentView === "topology") {
		_svgn = document
		_svgEl = document.getElementById("slang-svg")
		var groups = _svgEl ? Array.prototype.slice.call(_svgEl.querySelectorAll(".node-group")) : []
		for (var gi = 0; gi < groups.length; gi++) groups[gi].addEventListener("mousedown", beginDrag)
		document.removeEventListener("mousemove", moveDrag)
		document.addEventListener("mousemove", moveDrag)
		document.removeEventListener("mouseup", endDrag)
		document.addEventListener("mouseup", endDrag)
	}
}
