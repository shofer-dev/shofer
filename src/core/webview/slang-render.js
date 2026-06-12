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

/** Format milliseconds to a human-readable duration string (e.g. "2m 15s"). */
function formatMs(ms) {
	if (!ms || ms < 1000) return (ms || 0) + "ms"
	var s = Math.floor(ms / 1000)
	var m = Math.floor(s / 60)
	s = s % 60
	if (m > 0) return m + "m " + s + "s"
	return s + "s"
}

/** Map user-facing icon keys to emoji. Extend as needed. */
function iconToEmoji(key) {
	var map = {
		rocket: "\uD83D\uDE80", // 🚀
		gear: "\u2699\uFE0F", // ⚙️
		search: "\uD83D\uDD0D", // 🔍
		beaker: "\uD83E\uDDEA", // 🧪
		brain: "\uD83E\uDDE0", // 🧠
		lightbulb: "\uD83D\uDCA1", // 💡
		wrench: "\uD83D\uDD27", // 🔧
		shield: "\uD83D\uDEE1\uFE0F", // 🛡️
		bolt: "\u26A1", // ⚡
		star: "\u2B50", // ⭐
		heart: "\u2764\uFE0F", // ❤️
		fire: "\uD83D\uDD25", // 🔥
		check: "\u2705", // ✅
		database: "\uD83D\uDDC4\uFE0F", // 🗄️
		package: "\uD83D\uDCE6", // 📦
	}
	return map[key] || "\u26A1" // default ⚡
}

/**
 * Lightweight markdown-to-HTML renderer for flow descriptions and param docs.
 * HTML-escapes input, then applies a safe subset of markdown:
 *   `code` → <code>, **bold** → <b>, *italic* → <i>, [text](url) → <a>, \n → <br>
 */
function renderMarkdown(text) {
	if (!text) return ""
	var html = esc(text)
	// [text](url) — run first so other transforms don't interfere with URL chars
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
	// `inline code`
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>")
	// **bold**
	html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
	// *italic* (single asterisk, not already consumed by **)
	html = html.replace(/\*([^*]+)\*/g, "<i>$1</i>")
	// Literal backslash-n sequences (surviving JSON round-trip)
	html = html.replace(/\\n/g, "<br>")
	// Actual newline characters
	html = html.replace(/\n/g, "<br>")
	return html
}

function safeRender(payload) {
	try {
		if (payload) _lastPayload = payload
		handleRender(_lastPayload)
	} catch (e) {
		var app = document.getElementById("app")
		if (app) {
			app.innerHTML =
				'<div class="empty"><h2>\u26A0\uFE0F Render Error</h2><p style="color:#f87171">' +
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

// ─── postMessage listener for live-refresh payloads ──────────────────
// The provider sends new payloads via postMessage on every document change
// after the initial HTML load.  This preserves _currentView, zoom, and drag
// state instead of rebuilding the entire webview DOM on every keystroke.
// Runtime state updates (from WorkflowTask.slangLoop) arrive as
// { type: "runtimeState", runState } and are merged into _lastPayload.
//
// View switches originate from the React tab bar in WorkflowView and arrive
// as { type: "switchView", view } — this replaces the old inline <.tab-btn>
// approach since the tab bar lives outside the iframe now.
window.addEventListener("message", function (event) {
	var msg = event.data
	if (msg && msg.type === "render") {
		safeRender(msg)
	} else if (msg && msg.type === "runtimeState") {
		// Merge runtime state into the last static payload and re-render
		// in-place so per-agent progress overlays appear without a full
		// HTML rebuild.
		if (_lastPayload) {
			_lastPayload.runState = msg.runState
			safeRender(null)
		}
	} else if (msg && msg.type === "switchView" && msg.view) {
		_currentView = msg.view
		safeRender(null)
	}
})

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
	peer: "var(--z-peer,#06b6d4)",
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

/** Extract declared peers edges from agent.meta.peers — directional dashed lines
 *  representing the direct-message (send_message_to_task) permission grant. */
function buildPeerEdges(flow) {
	var agentNames = {}
	for (var i = 0; i < (flow.body || []).length; i++) {
		var item = flow.body[i]
		if (item.type === "AgentDecl") agentNames[item.name] = true
	}
	var edges = []
	for (var ai = 0; ai < (flow.body || []).length; ai++) {
		var agent = flow.body[ai]
		if (agent.type !== "AgentDecl") continue
		if (!agent.meta || !agent.meta.peers) continue
		var from = agent.name
		for (var pi = 0; pi < agent.meta.peers.length; pi++) {
			var peerName = agent.meta.peers[pi]
			if (agentNames[peerName]) {
				edges.push({ from: from, to: peerName, label: "peer", kind: "peer" })
			}
		}
	}
	return edges
}

// ── Dagre layout engine ─────────────────────────────────────────────
// Delegates directed-graph layout to ELK layered algorithm.
// In: agent names + edges from buildGraphEdges()
// Out: { layout: { agent -> {x,y} }, layers: { agent -> layer }, edges: [...] }
function applyDagreLayout(agentNames, rawEdges) {
	var g = new dagre.graphlib.Graph({ directed: true })

	g.setGraph({
		rankdir: "LR",
		nodesep: NODE_GAP_Y - NODE_H,
		ranksep: NODE_GAP_X - NODE_W,
		marginx: MARGIN,
		marginy: MARGIN,
	})

	var names = Object.keys(agentNames)
	for (var i = 0; i < names.length; i++) {
		g.setNode(names[i], { width: NODE_W, height: NODE_H })
	}

	// Merge duplicate edges between same (from, to, kind) pairs
	var mergeMap = {}
	for (var i = 0; i < rawEdges.length; i++) {
		var re = rawEdges[i],
			mk = re.from + "|||" + re.to + "|||" + re.kind
		if (!mergeMap[mk]) mergeMap[mk] = { from: re.from, to: re.to, kind: re.kind, labels: [] }
		if (mergeMap[mk].labels.indexOf(re.label) === -1) mergeMap[mk].labels.push(re.label)
	}

	var mergeKeys = Object.keys(mergeMap)
	for (var mkI = 0; mkI < mergeKeys.length; mkI++) {
		var mg = mergeMap[mergeKeys[mkI]]
		var lbl = mg.labels.length === 1 ? mg.labels[0] : mg.labels[0] + " (+" + (mg.labels.length - 1) + " more)"
		g.setEdge(mg.from, mg.to, { kind: mg.kind, label: lbl })
	}

	dagre.layout(g)

	// Extract layout from dagre output (dagre gives center coords; convert to top-left)
	var layout = {}
	var layers = {}
	// dagre's LR layout places nodes in distinct x-columns per layer.
	// Collect unique x positions (rounded) and assign layer numbers from left to right.
	var xPositions = []
	var xToLayer = {}
	for (var ni = 0; ni < names.length; ni++) {
		var n = g.node(names[ni])
		if (n) {
			var rx = Math.round(n.x)
			if (xPositions.indexOf(rx) === -1) xPositions.push(rx)
		}
	}
	xPositions.sort(function (a, b) {
		return a - b
	})
	for (var xi = 0; xi < xPositions.length; xi++) xToLayer[xPositions[xi]] = xi

	for (var ni = 0; ni < names.length; ni++) {
		var n = g.node(names[ni])
		if (n) {
			layout[names[ni]] = { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 }
			layers[names[ni]] = xToLayer[Math.round(n.x)] || 0
		}
	}

	// Build edge list with dagre routing points
	var edges = []
	var ei = 0
	g.edges().forEach(function (e) {
		var edgeInfo = g.edge(e)
		var dagrePoints = edgeInfo.points || []
		var sections = []
		if (dagrePoints.length > 0) {
			sections.push({
				startPoint: dagrePoints[0],
				endPoint: dagrePoints[dagrePoints.length - 1],
				bendPoints: dagrePoints.slice(1, -1),
			})
		}
		edges.push({
			from: e.v,
			to: e.w,
			label: edgeInfo.label || "",
			kind: edgeInfo.kind || "stake",
			idx: ei,
			total: mergeKeys.length,
			sections: sections,
		})
		ei++
	})

	return { layout: layout, layers: layers, edges: edges }
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
		'<marker id="ah-peer" markerWidth="11" markerHeight="8" refX="10" refY="4" orient="auto">' +
		'<polygon points="0 0, 11 4, 0 8" fill="' +
		COLORS.peer +
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
			'<text x="14" y="48" font-size="11" fill="var(--z-meta,#888)" style="pointer-events:none"><title>' +
			esc(role) +
			"</title>" +
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

	// Runtime badge: agent status + opIndex when runState is available
	if (_runState) {
		var ars = getAgentRunState(nm)
		if (ars) {
			var statusColor = agentStatusColor(ars.status)
			var badgeLabel = ars.status
			if (ars.opIndex !== undefined && ars.opIndex > 0) {
				badgeLabel += " (" + ars.opIndex + ")"
			}
			var blw = badgeLabel.length * 6.5 + 12
			s +=
				'<rect x="' +
				(NODE_W - blw - 6) +
				'" y="' +
				(NODE_H - 22) +
				'" width="' +
				blw +
				'" height="16" rx="3" fill="' +
				statusColor +
				'" opacity="0.25" />'
			s +=
				'<text x="' +
				(NODE_W - blw) +
				'" y="' +
				(NODE_H - 10) +
				'" font-size="10" font-weight="600" fill="' +
				statusColor +
				'" style="pointer-events:none">' +
				esc(badgeLabel) +
				"</text>"
		}
	}
	return s
}

// Point on a node's rectangular border along the ray from its center toward
// (towardX, towardY). Lets edges anchor to whichever side actually faces the
// other node, so they stay connected when boxes are dragged to any position.
function rectBorderPoint(cx, cy, halfW, halfH, towardX, towardY) {
	var dx = towardX - cx,
		dy = towardY - cy
	if (dx === 0 && dy === 0) return { x: cx + halfW, y: cy }
	var sx = dx !== 0 ? halfW / Math.abs(dx) : Infinity
	var sy = dy !== 0 ? halfH / Math.abs(dy) : Infinity
	var s = Math.min(sx, sy)
	return { x: cx + dx * s, y: cy + dy * s }
}

// Border-to-border edge geometry used when dagre's routed sections are stale
// (i.e. after a node drag). Anchors both endpoints on the node borders facing
// each other so the arrow stays attached regardless of relative position.
// Back-edges (source layer >= target layer) bow perpendicular to the line so an
// opposing forward edge between the same pair stays visually distinct.
// Returns { d, cx, cy } — path data plus the label anchor point.
function fallbackEdgeGeometry(fnX, fnY, tnX, tnY, fromLayer, toLayer) {
	var c1x = fnX + NODE_W / 2,
		c1y = fnY + NODE_H / 2,
		c2x = tnX + NODE_W / 2,
		c2y = tnY + NODE_H / 2
	var p1 = rectBorderPoint(c1x, c1y, NODE_W / 2, NODE_H / 2, c2x, c2y)
	var p2 = rectBorderPoint(c2x, c2y, NODE_W / 2, NODE_H / 2, c1x, c1y)
	var dx = p2.x - p1.x,
		dy = p2.y - p1.y
	var len = Math.sqrt(dx * dx + dy * dy) || 1
	var bend = fromLayer != null && toLayer != null && fromLayer >= toLayer ? Math.max(40, len * 0.25) : 0
	var nx = -dy / len,
		ny = dx / len
	var midX = (p1.x + p2.x) / 2,
		midY = (p1.y + p2.y) / 2
	var d =
		bend === 0
			? "M" + p1.x + "," + p1.y + " L" + p2.x + "," + p2.y
			: "M" + p1.x + "," + p1.y + " Q" + (midX + nx * bend) + "," + (midY + ny * bend) + " " + p2.x + "," + p2.y
	// Label sits on the curve midpoint (t=0.5 of the quadratic ≈ mid + 0.5·offset).
	return { d: d, cx: midX + nx * bend * 0.5, cy: midY + ny * bend * 0.5 }
}

function edgePathData(fnX, fnY, tnX, tnY, sections, fromLayer, toLayer) {
	// If dagre provided bend-point sections, use them directly.
	if (sections && sections.length > 0) {
		var d = ""
		for (var si = 0; si < sections.length; si++) {
			var sec = sections[si]
			var sp = sec.startPoint,
				ep = sec.endPoint
			if (si === 0) d += "M" + sp.x + "," + sp.y
			if (sec.bendPoints && sec.bendPoints.length > 0) {
				for (var bi = 0; bi < sec.bendPoints.length; bi++) {
					d += " L" + sec.bendPoints[bi].x + "," + sec.bendPoints[bi].y
				}
			}
			d += " L" + ep.x + "," + ep.y
		}
		return d
	}
	// Fallback (used during drag when sections are stale): border-to-border
	// geometry that stays connected regardless of the nodes' relative positions.
	return fallbackEdgeGeometry(fnX, fnY, tnX, tnY, fromLayer, toLayer).d
}

function renderEdge(e, layout, layers) {
	var fn = layout[e.from],
		tn = layout[e.to]
	if (!fn || !tn) return ""
	var d = edgePathData(fn.x, fn.y, tn.x, tn.y, e.sections, layers[e.from], layers[e.to])
	var color = e.kind === "stake" ? COLORS.stake : e.kind === "await" ? COLORS.await : COLORS.peer
	var marker = e.kind === "stake" ? "url(#ah-stake)" : e.kind === "await" ? "url(#ah-await)" : "url(#ah-peer)"
	var dashAttr = e.kind === "peer" ? ' stroke-dasharray="8 4"' : ""
	// Runtime highlight: thicken + pulse edges that are active (agent is
	// sendingTo or waitingFor that target).
	var rtClass = ""
	if (e.kind !== "peer" && _runState) {
		var fromAgent = getAgentRunState(e.from)
		var toAgent = getAgentRunState(e.to)
		if ((fromAgent && fromAgent.sendingTo === e.to) || (toAgent && toAgent.waitingFor === e.from)) {
			rtClass = " edge-runtime-active"
			dashAttr = e.kind === "stake" ? ' stroke-dasharray="6 2"' : dashAttr
		}
	}
	var key = esc(e.from) + "__" + esc(e.to) + "__" + e.kind + "__" + e.idx
	var s =
		'<g class="edge-group' +
		rtClass +
		'" data-edge="' +
		key +
		'" data-from="' +
		esc(e.from) +
		'" data-to="' +
		esc(e.to) +
		'" data-idx="' +
		e.idx +
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
		'"' +
		dashAttr +
		" />"
	if (e.label) {
		var cx,
			cy,
			x1 = fn.x + NODE_W,
			y1 = fn.y + NODE_H / 2,
			x2 = tn.x,
			y2 = tn.y + NODE_H / 2
		if (layers[e.from] != null && layers[e.to] != null && layers[e.from] >= layers[e.to]) {
			var arcH = Math.max(60, Math.abs(layers[e.from] - layers[e.to]) * 50 + 20)
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
	var rawEdges = buildGraphEdges(flow).concat(buildPeerEdges(flow))
	var dagreResult = applyDagreLayout(agentNames, rawEdges)
	_layout = dagreResult.layout
	_layers = dagreResult.layers
	_edges = dagreResult.edges

	// Compute SVG canvas size from node positions
	var maxX = 0,
		maxY = 0
	var names = Object.keys(_layout)
	for (var ni = 0; ni < names.length; ni++) {
		var pos = _layout[names[ni]]
		if (pos.x + NODE_W > maxX) maxX = pos.x + NODE_W
		if (pos.y + NODE_H > maxY) maxY = pos.y + NODE_H
	}
	var svgW = Math.max(500, maxX + MARGIN)
	var svgH = Math.max(300, maxY + MARGIN)

	var svg =
		'<svg id="slang-svg" width="' +
		svgW +
		'" height="' +
		svgH +
		'" viewBox="0 0 ' +
		svgW +
		" " +
		svgH +
		'" xmlns="http://www.w3.org/2000/svg">' +
		defs() +
		'<g id="edge-layer">'
	for (var ei = 0; ei < _edges.length; ei++) svg += renderEdge(_edges[ei], _layout, _layers)
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

	// Build timeline events from the runtime mailbox when _runState is
	// available (showing actual message-passing history). Fall back to
	// static AST extraction when viewing a file statically.
	var timelineEvents = []

	if (_runState && _runState.mailboxHistory && _runState.mailboxHistory.length > 0) {
		// Runtime: use historical mailbox entries (sorted by timestamp).
		for (var mi = 0; mi < _runState.mailboxHistory.length; mi++) {
			var entry = _runState.mailboxHistory[mi]
			timelineEvents.push({
				from: entry.from,
				to: entry.to === "@out" ? "@Human" : entry.to,
				label: entry.funcName || "",
				type: "stake",
				seq: mi,
				ts: entry.timestamp || 0,
			})
		}

		// Append pending sends from agents that have sendingTo set but
		// the message hasn't hit the mailbox yet.
		if (_runState.agents) {
			for (var ai = 0; ai < _runState.agents.length; ai++) {
				var ag = _runState.agents[ai]
				if (ag[1].sendingTo && ag[1].sendingTo !== "@out") {
					// Avoid duplicates with mailbox entries
					var alreadyInMailbox = false
					for (var mj = timelineEvents.length - 1; mj >= 0; mj--) {
						if (timelineEvents[mj].from === ag[0]) {
							alreadyInMailbox = true
							break
						}
					}
					if (!alreadyInMailbox) {
						timelineEvents.push({
							from: ag[0],
							to: ag[1].sendingTo,
							label: "sending…",
							type: "stake",
							seq: timelineEvents.length,
							pending: true,
						})
					}
				}
			}
		}
	} else {
		// Static fallback: extract interactions from the flow AST.
		var rawEdges = buildGraphEdges(flow)
		var dagreResult = applyDagreLayout(agentNames, rawEdges)
		var layers = dagreResult.layers

		for (var ai2 = 0; ai2 < (flow.body || []).length; ai2++) {
			var agent = flow.body[ai2]
			if (agent.type !== "AgentDecl") continue
			var from = agent.name

			;(function extractTimeline(ops, layerFrom, depth) {
				if (!ops) return
				depth = depth || 0
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
									label: op.call ? op.call.name : "",
									type: "stake",
									layer: layerFrom,
									seq: timelineEvents.length,
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
									label: op.binding || "",
									type: "await",
									layer: layers[src] || 0,
									seq: timelineEvents.length,
								})
						}
					}
					if (op.type === "EscalateOp") {
						timelineEvents.push({
							from: from,
							to: "@Human",
							label: op.reason || "approval",
							type: "stake",
							layer: layerFrom,
						})
					}
					if (depth < maxDepth) {
						if (op.type === "WhenBlock") {
							extractTimeline(op.body, layerFrom, depth + 1)
							if (op.elseBlock) extractTimeline(op.elseBlock.body, layerFrom, depth + 1)
						}
						if (op.type === "RepeatBlock") extractTimeline(op.body, layerFrom, depth + 1)
					}
				}
			})(agent.operations, layers[from] || 0)
		}
	}

	var svgW = Math.max(600, columns.length * COL_W + MARGIN * 2)
	var svgH = Math.max(400, timelineEvents.length * STEP_H + TOP_PAD + 100)
	var s =
		'<svg id="slang-svg" width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg">' + defs()

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
		var dashAttr = ev.pending ? ' stroke-dasharray="6 3" opacity="0.55"' : ""

		// Tooltip from mailbox metadata (tokens, cost, duration)
		var tt = ""
		if (ev.tokensUsed || ev.costUsd || ev.durationMs) {
			var tp = []
			if (ev.tokensUsed) tp.push("\uD83D\uDD22 " + esc(String(ev.tokensUsed)) + " tokens")
			if (ev.costUsd) tp.push("\uD83D\uDCB0 $" + esc(Number(ev.costUsd).toFixed(4)))
			if (ev.durationMs) tp.push("\u23F1 " + esc(formatMs(ev.durationMs)))
			tt = "<title>" + tp.join("  \u2022  ") + "</title>"
		}
		s += '<g class="sequence-group' + (ev.pending ? " sequence-pending" : "") + '">' + tt
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

		// ── Activation boxes on lifelines ──
		var actW = 8,
			actH = 30
		var cxFrom = MARGIN + fIdx * COL_W + COL_W / 2
		var cxTo = MARGIN + tIdx * COL_W + COL_W / 2
		s +=
			'<rect class="seq-activation" x="' +
			(cxFrom - actW / 2) +
			'" y="' +
			(y - actH / 2) +
			'" width="' +
			actW +
			'" height="' +
			actH +
			'" rx="2" />'
		s +=
			'<rect class="seq-activation" x="' +
			(cxTo - actW / 2) +
			'" y="' +
			(y - actH / 2) +
			'" width="' +
			actW +
			'" height="' +
			actH +
			'" rx="2" />'

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
				if (o.elseBlock && o.elseBlock.body && o.elseBlock.body.length > 0) {
					n += 0.5 // OTHERWISE adds _cy += SPACING_Y / 2
					n += countOps(o.elseBlock.body)
				}
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

	var s =
		'<svg id="slang-svg" width="' +
		svgW +
		'" height="' +
		maxLaneHeight +
		'" xmlns="http://www.w3.org/2000/svg">' +
		defs()

	// Mutable Y cursor shared across recursive calls
	var _cy = 0,
		_opCounter = 0

	// Render a single operation; mutates _cy and returns SVG fragment
	function renderOp(op, spineX, depth, agentName, opIdx) {
		var str = ""
		var opacity = depth > 0 ? "0.7" : "1"

		// Runtime: is this the currently executing operation?
		var isExecuting = false
		if (agentName) {
			var ars2 = getAgentRunState(agentName)
			if (ars2 && ars2.opIndex === opIdx) isExecuting = true
		}
		var execClass = isExecuting ? " flow-executing" : ""
		var execAttr = ""

		if (op.type === "StakeOp") {
			var lbl = "STAKE: " + esc(op.call ? op.call.name : "func") + "()"
			var toNames = []
			if (op.recipients) {
				for (var sj = 0; sj < op.recipients.length; sj++) {
					var rt = op.recipients[sj].ref || op.recipients[sj]
					toNames.push("@" + esc(rt))
				}
			}
			var arrowDir = toNames.length > 0 ? " \u2192 " + toNames.join(", ") : ""
			if (isExecuting) execAttr = ' data-optype="stake"'
			str +=
				'<rect class="flow-box' +
				execClass +
				'" x="' +
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
				'"' +
				execAttr +
				" />"
			str +=
				'<text class="flow-text" x="' +
				spineX +
				'" y="' +
				(_cy + 19) +
				'" text-anchor="middle" fill="var(--z-fg)" opacity="' +
				opacity +
				'">' +
				lbl +
				arrowDir +
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
			if (isExecuting) execAttr = ' data-optype="await"'
			str +=
				'<rect class="flow-box' +
				execClass +
				'" x="' +
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
				'"' +
				execAttr +
				" />"
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
			if (ereason.length > 28) ereason = ereason.slice(0, 25) + "\u2026"
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
			var bodyStartY = _cy - SPACING_Y
			_cy += SPACING_Y
			str += renderOpList(op.body, spineX, depth + 1, agentName)
			// Bounding box around the WHEN body
			if (_cy > bodyStartY) {
				str +=
					'<rect class="loop-bounding-box" x="' +
					(spineX - BLOCK_W / 2 - 12) +
					'" y="' +
					bodyStartY +
					'" width="' +
					(BLOCK_W + 24) +
					'" height="' +
					(_cy - bodyStartY) +
					'" rx="6" />'
			}
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
				var elseStartY = _cy - SPACING_Y
				str += renderOpList(op.elseBlock.body, spineX, depth + 1)
				// Bounding box around the OTHERWISE body
				if (_cy > elseStartY) {
					str +=
						'<rect class="loop-bounding-box" x="' +
						(spineX - BLOCK_W / 2 - 12) +
						'" y="' +
						elseStartY +
						'" width="' +
						(BLOCK_W + 24) +
						'" height="' +
						(_cy - elseStartY) +
						'" rx="6" />'
				}
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
			var repeatStartY = _cy - SPACING_Y
			_cy += SPACING_Y
			str += renderOpList(op.body, spineX, depth + 1, agentName)
			// Bounding box around the REPEAT body
			if (_cy > repeatStartY) {
				str +=
					'<rect class="loop-bounding-box" x="' +
					(spineX - BLOCK_W / 2 - 12) +
					'" y="' +
					repeatStartY +
					'" width="' +
					(BLOCK_W + 24) +
					'" height="' +
					(_cy - repeatStartY) +
					'" rx="6" />'
			}
		} else if (op.type === "CommitOp") {
			if (isExecuting) execAttr = ' data-optype="commit"'
			str +=
				'<rect class="flow-box' +
				execClass +
				'" x="' +
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
				'"' +
				execAttr +
				" />"
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

	// Render a list of operations recursively, tracking op-index for runtime highlight.
	function renderOpList(ops, spineX, depth, agentName) {
		if (!ops) return ""
		var str = ""
		for (var j = 0; j < ops.length; j++) {
			_opCounter++
			str += renderOp(ops[j], spineX, depth, agentName, _opCounter)
		}
		return str
	}

	// Render each agent lane
	for (var i = 0; i < agents.length; i++) {
		var ag = agents[i]
		_opCounter = 0
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

		// Runtime status badge per lane
		if (_runState) {
			var ars = getAgentRunState(ag.name)
			if (ars) {
				var sc = agentStatusColor(ars.status)
				var sl = ars.status + (ars.opIndex !== undefined && ars.opIndex > 0 ? " @" + ars.opIndex : "")
				s +=
					'<rect x="' +
					(lx + LANE_W - 80) +
					'" y="28" width="' +
					(sl.length * 6.5 + 10) +
					'" height="16" rx="3" fill="' +
					sc +
					'" opacity="0.25" />'
				s +=
					'<text x="' +
					(lx + LANE_W - 75) +
					'" y="40" font-size="10" font-weight="600" fill="' +
					sc +
					'" style="pointer-events:none">' +
					esc(sl) +
					"</text>"
			}
		}

		_cy = 70
		var midX = lx + (LANE_W - 10) / 2
		s += '<line class="flow-spine" x1="' + midX + '" y1="' + _cy + '" x2="' + midX + '" y2="' + (_cy + 15) + '" />'
		_cy += 15

		s += renderOpList(ag.operations, midX, 0, ag.name)
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

// ── Zoom & pan state (all views) ──
var _zoomViewBox = null,
	_zoomPanning = false,
	_zoomPanSX = 0,
	_zoomPanSY = 0,
	_zoomPanOX = 0,
	_zoomPanOY = 0

function applyZoom() {
	if (!_svgEl || !_zoomViewBox) return
	_svgEl.setAttribute("viewBox", _zoomViewBox.x + " " + _zoomViewBox.y + " " + _zoomViewBox.w + " " + _zoomViewBox.h)
}

function zoomIn() {
	if (!_zoomViewBox) return
	var cx = _zoomViewBox.x + _zoomViewBox.w / 2
	var cy = _zoomViewBox.y + _zoomViewBox.h / 2
	_zoomViewBox.w *= 0.8
	_zoomViewBox.h *= 0.8
	_zoomViewBox.x = cx - _zoomViewBox.w / 2
	_zoomViewBox.y = cy - _zoomViewBox.h / 2
	applyZoom()
}

function zoomOut() {
	if (!_zoomViewBox) return
	var cx = _zoomViewBox.x + _zoomViewBox.w / 2
	var cy = _zoomViewBox.y + _zoomViewBox.h / 2
	_zoomViewBox.w *= 1.25
	_zoomViewBox.h *= 1.25
	_zoomViewBox.x = cx - _zoomViewBox.w / 2
	_zoomViewBox.y = cy - _zoomViewBox.h / 2
	applyZoom()
}

function zoomFit() {
	if (!_svgEl) return
	var w = parseFloat(_svgEl.getAttribute("width")) || 500
	var h = parseFloat(_svgEl.getAttribute("height")) || 300
	_zoomViewBox = { x: 0, y: 0, w: w, h: h }
	applyZoom()
}

function beginSvgPan(e) {
	if (!_zoomViewBox) return
	// Only start panning if the mousedown target is not a node or edge element
	var el = e.target
	while (el && el !== _svgEl) {
		if (el.getAttribute) {
			var cls = el.getAttribute("class") || ""
			if (cls.indexOf("node-group") !== -1 || cls.indexOf("edge-group") !== -1) return
		}
		el = el.parentNode
	}
	e.preventDefault()
	_zoomPanning = true
	_zoomPanSX = e.clientX
	_zoomPanSY = e.clientY
	_zoomPanOX = _zoomViewBox.x
	_zoomPanOY = _zoomViewBox.y
	_svgEl.style.cursor = "grabbing"
}

function moveSvgPan(e) {
	if (!_zoomPanning || !_svgEl) return
	e.preventDefault()
	var rect = _svgEl.getBoundingClientRect()
	var dx = e.clientX - _zoomPanSX
	var dy = e.clientY - _zoomPanSY
	if (rect.width > 0 && rect.height > 0) {
		_zoomViewBox.x = _zoomPanOX - dx * (_zoomViewBox.w / rect.width)
		_zoomViewBox.y = _zoomPanOY - dy * (_zoomViewBox.h / rect.height)
	}
	applyZoom()
}

function endSvgPan(e) {
	if (!_zoomPanning) return
	_zoomPanning = false
	if (_svgEl) _svgEl.style.cursor = ""
}

// ── Edge-hover highlight ──
function edgeHoverIn(e) {
	var edge = e.currentTarget
	var from = edge.getAttribute("data-from")
	var to = edge.getAttribute("data-to")
	if (!_svgEl) return
	var nodes = _svgEl.querySelectorAll(".node-group")
	for (var i = 0; i < nodes.length; i++) {
		var agent = nodes[i].getAttribute("data-agent")
		if (agent !== from && agent !== to) {
			nodes[i].classList.add("z-dimmed")
		}
	}
}

function edgeHoverOut(e) {
	if (!_svgEl) return
	var nodes = _svgEl.querySelectorAll(".node-group")
	for (var i = 0; i < nodes.length; i++) {
		nodes[i].classList.remove("z-dimmed")
	}
}

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
		// Sections from dagre layout are stale after drag — use border-to-border
		// fallback geometry (path + label anchor) so the arrow follows the node.
		var geo = fallbackEdgeGeometry(fn.x, fn.y, tn.x, tn.y, _layers[e.from], _layers[e.to])
		var eg = _svgEl.querySelector(
			'.edge-group[data-edge="' + esc(e.from) + "__" + esc(e.to) + "__" + e.kind + "__" + e.idx + '"]',
		)
		if (!eg) continue
		var hit = eg.querySelector(".edge-hit"),
			path = eg.querySelector(".edge-path")
		if (hit) hit.setAttribute("d", geo.d)
		if (path) path.setAttribute("d", geo.d)
		var lblRect = eg.querySelector(".edge-label-bg"),
			lblText = eg.querySelector(".edge-label")
		if (lblRect && lblText && e.label) {
			lblRect.setAttribute("x", geo.cx - (e.label.length * 6.5 + 10) / 2)
			lblRect.setAttribute("y", geo.cy - 9)
			lblText.setAttribute("x", geo.cx)
			lblText.setAttribute("y", geo.cy + 5)
		}
	}
}

// ── main orchestration layout router ──
/** Runtime state from the WorkflowTask executor — null when viewing a static file. */
var _runState = null

/** Look up serialized AgentState from runState.agents (array of [name, state] pairs). */
function getAgentRunState(agentName) {
	if (!_runState || !_runState.agents) return null
	for (var ri = 0; ri < _runState.agents.length; ri++) {
		if (_runState.agents[ri][0] === agentName) return _runState.agents[ri][1]
	}
	return null
}

/** Return a CSS color for an AgentStatus value. */
function agentStatusColor(status) {
	switch (status) {
		case "running":
			return COLORS.agent // green
		case "blocked":
			return COLORS.await // purple
		case "committed":
			return COLORS.meta // gray
		case "idle":
			return COLORS.flow // blue
		case "error":
			return "var(--z-err,#f87171)" // red
		default:
			return COLORS.meta
	}
}

function handleRender(payload) {
	var flow = payload.flow,
		diags = payload.diags || []
	_runState = payload.runState || null
	var app = document.getElementById("app"),
		diagsEl = document.getElementById("diags")
	if (!flow) {
		app.innerHTML = '<div class="empty"><h2>No flow found</h2></div>'
		return
	}

	// ── Dual-mode rendering ──
	// context === "workflowView": header/tabs/banner are rendered natively
	//   in the WorkflowView React tree — this iframe is diagram-only.
	// context absent (undefined): standalone .slang editor — render the
	//   full header, tab bar, runtime banner, and graph hints.
	var isEmbedded = payload.context === "workflowView"
	var h = ""

	if (!isEmbedded) {
		// ── Standalone header (.slang editor) ──
		var paramDescriptions = {}
		for (var pi = 0; pi < (flow.body || []).length; pi++) {
			var pItem = flow.body[pi]
			if (pItem.type === "ParamMetaDecl" && pItem.description) {
				paramDescriptions[pItem.name] = pItem.description
			}
		}

		var displayTitle = flow.title || flow.name
		var iconEmoji = flow.icon ? iconToEmoji(flow.icon) : "\u26A1"
		h += '<div class="flow-header"><h2><span>' + esc(iconEmoji) + "</span> " + esc(displayTitle) + "</h2>"
		if (flow.title && flow.title !== flow.name) {
			h += '<div class="flow-id">flow "' + esc(flow.name) + '"</div>'
		}
		if (flow.description) {
			h += '<div class="flow-desc">' + renderMarkdown(flow.description) + "</div>"
		}
		if (flow.params && flow.params.length > 0) {
			h += '<div class="params">Params: '
			for (var pj = 0; pj < flow.params.length; pj++) {
				var pDesc = paramDescriptions[flow.params[pj].name]
				h +=
					'<span class="param-tip"><code>' +
					esc(flow.params[pj].name) +
					': "' +
					esc(flow.params[pj].paramType) +
					'"</code>' +
					(pDesc ? '<span class="param-tooltip">' + renderMarkdown(pDesc) + "</span>" : "") +
					"</span>" +
					(pj < flow.params.length - 1 ? ", " : "")
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
				h +=
					'<span>\uD83C\uDFAF Converge when: <span class="badge">' +
					esc(exprStr(bItem.condition)) +
					"</span></span>"
			}
			if (bItem.type === "BudgetStmt" && bItem.items) {
				hasBud = true
				for (var bj = 0; bj < bItem.items.length; bj++)
					h +=
						"<span>\uD83D\uDCB0 " +
						esc(bItem.items[bj].kind) +
						': <span class="badge">' +
						esc(exprStr(bItem.items[bj].value)) +
						"</span></span>"
			}
		}
		if (!hasCon) h += '<span style="opacity:0.5">No converge statement</span>'
		if (!hasBud) h += '<span style="opacity:0.5">No budget (unlimited)</span>'
		h += "</div></div>"

		// Tab bar (standalone only — WorkflowView has its own tab bar)
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

		var zoomLabel = " &nbsp;|&nbsp; \uD83D\uDD0D Scroll to zoom, drag background to pan"
		if (_currentView === "topology") {
			h +=
				'<div class="graph-hint">\uD83D\uDD90\uFE0F Drag nodes to rearrange &nbsp;|&nbsp; \uD83D\uDD04 Auto-layout from topology layers' +
				zoomLabel +
				"</div>"
		} else if (_currentView === "sequence") {
			h +=
				'<div class="graph-hint">\u23F1\uFE0F Message-passing chronology mapped top-to-bottom across processing tracks' +
				zoomLabel +
				"</div>"
		} else {
			h +=
				'<div class="graph-hint">\uD83E\uDDEC Sequential operation blocks and branching statements broken down per agent lane' +
				zoomLabel +
				"</div>"
		}

		// Runtime state banner
		if (_runState && _runState.round !== undefined) {
			var committed = 0
			if (_runState.agents) {
				for (var rsi = 0; rsi < _runState.agents.length; rsi++) {
					if (_runState.agents[rsi][1].status === "committed") committed++
				}
			}
			var totalAgents = _runState.agents ? _runState.agents.length : 0
			h +=
				'<div class="runtime-banner">' +
				"\uD83D\uDD04 Round " +
				esc(String(_runState.round)) +
				" &middot; " +
				esc(String(committed)) +
				"/" +
				esc(String(totalAgents)) +
				" committed" +
				' &middot; Status: <span style="color:' +
				agentStatusColor(_runState.status || "running") +
				';font-weight:600">' +
				esc(_runState.status || "running") +
				"</span></div>"
		}
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

	// ── Zoom controls (both modes) ──
	h +=
		'<div class="zoom-controls">' +
		'<button class="zoom-btn" data-zoom="in" title="Zoom in">+</button>' +
		'<button class="zoom-btn" data-zoom="out" title="Zoom out">\u2212</button>' +
		'<button class="zoom-btn" data-zoom="fit" title="Fit to view">\u26F6</button>' +
		"</div>"

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

	// Wire standalone tab buttons (only present when !isEmbedded).
	if (!isEmbedded) {
		var tabBtns = document.querySelectorAll(".tab-btn[data-view]")
		for (var ti = 0; ti < tabBtns.length; ti++) {
			tabBtns[ti].addEventListener("click", function () {
				var view = this.getAttribute("data-view")
				_currentView = view
				safeRender(null)
			})
		}
	}

	_svgn = document
	_svgEl = document.getElementById("slang-svg")

	// Initialize zoom state from SVG dimensions
	if (_svgEl) {
		var initW = parseFloat(_svgEl.getAttribute("width")) || 500
		var initH = parseFloat(_svgEl.getAttribute("height")) || 300
		_zoomViewBox = { x: 0, y: 0, w: initW, h: initH }
	}

	// ── Topology-specific: node drag + edge hover ──
	if (_currentView === "topology") {
		var groups = _svgEl ? Array.prototype.slice.call(_svgEl.querySelectorAll(".node-group")) : []
		for (var gi = 0; gi < groups.length; gi++) groups[gi].addEventListener("mousedown", beginDrag)
		document.removeEventListener("mousemove", moveDrag)
		document.addEventListener("mousemove", moveDrag)
		document.removeEventListener("mouseup", endDrag)
		document.addEventListener("mouseup", endDrag)

		var edgeGroups = _svgEl ? Array.prototype.slice.call(_svgEl.querySelectorAll(".edge-group")) : []
		for (var ei = 0; ei < edgeGroups.length; ei++) {
			edgeGroups[ei].addEventListener("mouseenter", edgeHoverIn)
			edgeGroups[ei].addEventListener("mouseleave", edgeHoverOut)
		}
	}

	// ── Zoom buttons (all views) ──
	var zoomBtns = document.querySelectorAll(".zoom-btn[data-zoom]")
	for (var zi = 0; zi < zoomBtns.length; zi++) {
		zoomBtns[zi].addEventListener("click", function () {
			var action = this.getAttribute("data-zoom")
			if (action === "in") zoomIn()
			else if (action === "out") zoomOut()
			else if (action === "fit") zoomFit()
		})
	}

	// ── Mousewheel zoom + background drag-to-pan on SVG (all views) ──
	if (_svgEl) {
		_svgEl.addEventListener("wheel", function (e) {
			if (!_zoomViewBox) return
			e.preventDefault()
			var rect = _svgEl.getBoundingClientRect()
			var mx = e.clientX - rect.left
			var my = e.clientY - rect.top
			var vbX = _zoomViewBox.x + (mx / rect.width) * _zoomViewBox.w
			var vbY = _zoomViewBox.y + (my / rect.height) * _zoomViewBox.h
			var factor = e.deltaY > 0 ? 1.15 : 0.87
			_zoomViewBox.w *= factor
			_zoomViewBox.h *= factor
			_zoomViewBox.x = vbX - (mx / rect.width) * _zoomViewBox.w
			_zoomViewBox.y = vbY - (my / rect.height) * _zoomViewBox.h
			applyZoom()
		})
		_svgEl.addEventListener("mousedown", beginSvgPan)
		document.removeEventListener("mousemove", moveSvgPan)
		document.addEventListener("mousemove", moveSvgPan)
		document.removeEventListener("mouseup", endSvgPan)
		document.addEventListener("mouseup", endSvgPan)
	}
}
