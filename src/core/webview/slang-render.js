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
		render(_lastPayload)
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
	return s
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
	// Fallback bezier (used during drag when sections are stale).
	var x1 = fnX + NODE_W,
		y1 = fnY + NODE_H / 2,
		x2 = tnX,
		y2 = tnY + NODE_H / 2
	// Back-edge / same-layer edge: arc above nodes instead of through them.
	if (fromLayer != null && toLayer != null && fromLayer >= toLayer) {
		var arcH = Math.max(60, Math.abs(fromLayer - toLayer) * 50 + 20)
		return "M" + x1 + "," + y1 + " C" + x1 + "," + (y1 - arcH) + " " + x2 + "," + (y2 - arcH) + " " + x2 + "," + y2
	}
	var dx = Math.abs(x2 - x1)
	var curve = Math.min(dx * 0.45, 140)
	return "M" + x1 + "," + y1 + " C" + (x1 + curve) + "," + y1 + " " + (x2 - curve) + "," + y2 + " " + x2 + "," + y2
}

function renderEdge(e, layout, layers) {
	var fn = layout[e.from],
		tn = layout[e.to]
	if (!fn || !tn) return ""
	var d = edgePathData(fn.x, fn.y, tn.x, tn.y, e.sections, layers[e.from], layers[e.to])
	var color = e.kind === "stake" ? COLORS.stake : COLORS.await
	var marker = e.kind === "stake" ? "url(#ah-stake)" : "url(#ah-await)"
	var key = esc(e.from) + "__" + esc(e.to) + "__" + e.kind + "__" + e.idx
	var s =
		'<g class="edge-group" data-edge="' +
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
		'" />'
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
	var rawEdges = buildGraphEdges(flow)
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

	// Extract all inter-agent events with source-agent context.
	// Each event carries the layer of its source agent (from dagre topology).
	var rawEdges = buildGraphEdges(flow)
	var dagreResult = applyDagreLayout(agentNames, rawEdges)
	var layers = dagreResult.layers

	var timelineEvents = []
	var _globalSeq = 0

	for (var ai = 0; ai < (flow.body || []).length; ai++) {
		var agent = flow.body[ai]
		if (agent.type !== "AgentDecl") continue
		var from = agent.name

		function extractTimeline(ops, layerFrom, depth) {
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
								seq: _globalSeq++,
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
								seq: _globalSeq++,
							})
						if (src === "Human")
							timelineEvents.push({
								from: "@Human",
								to: from,
								label: "user reply",
								type: "await",
								layer: 0,
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
		}
		extractTimeline(agent.operations, layers[from] || 0)
	}

	// ── Merge matched stake/await pairs ────────────────────────────────
	// A stake S->@T (sender→target) and an await B<-@S (same sender/receiver)
	// are two sides of the same logical message. Collapse them into one event,
	// preferring the stake's label (action name) over the await's (binding name).
	// Escalate-to-Human is handled symmetrically: stake A→@Human + await @Human→A.
	var merged = []
	var consumed = {} // index → true for events already pushed to merged
	for (var si = 0; si < timelineEvents.length; si++) {
		if (timelineEvents[si].type !== "stake") continue
		consumed[si] = true // mark this stake as handled
		var stakeEv = timelineEvents[si]
		// Look for a matching await: same from/to pair, or escalate symmetry
		var pairIdx = -1
		for (var ai = 0; ai < timelineEvents.length; ai++) {
			if (ai === si || consumed[ai]) continue
			var awaitEv = timelineEvents[ai]
			if (awaitEv.type !== "await") continue
			// Agent-to-agent: stake.from === await.from && stake.to === await.to
			if (stakeEv.from === awaitEv.from && stakeEv.to === awaitEv.to) {
				pairIdx = ai
				break
			}
			// Human escalation: stake.from === await.to && stake.to === "@Human" && await.from === "@Human"
			if (stakeEv.to === "@Human" && awaitEv.from === "@Human" && stakeEv.from === awaitEv.to) {
				pairIdx = ai
				break
			}
		}
		if (pairIdx !== -1) {
			consumed[pairIdx] = true
		}
		merged.push({
			from: stakeEv.from,
			to: stakeEv.to,
			label: stakeEv.label || (pairIdx !== -1 ? timelineEvents[pairIdx].label : "") || "",
			type: stakeEv.type,
			layer: stakeEv.layer,
			seq: stakeEv.seq,
		})
	}
	// Push uncovered events (those with no matching pair) — e.g. standalone
	// await @any, awaits gated behind a when-block where the stake is unreachable.
	for (var ui = 0; ui < timelineEvents.length; ui++) {
		if (consumed[ui]) continue
		merged.push(timelineEvents[ui])
	}

	// Sort events by their intra-agent sequential position (seq). This groups
	// agent interactions by dependency order while preserving the line-by-line
	// ordering of operations within each agent.
	merged.sort(function (a, b) {
		if (a.seq !== b.seq) return a.seq - b.seq
		return 0
	})

	timelineEvents = merged

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
			var bodyStartY = _cy
			str += renderOpList(op.body, spineX, depth + 1)
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
				var elseStartY = _cy
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
			_cy += SPACING_Y
			var repeatStartY = _cy
			str += renderOpList(op.body, spineX, depth + 1)
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

// ── Zoom & pan state (topology view only) ──
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
		// Sections from dagre layout are stale after drag — use bezier fallback with layer info.
		var d = edgePathData(fn.x, fn.y, tn.x, tn.y, null, _layers[e.from], _layers[e.to])
		var eg = _svgEl.querySelector(
			'.edge-group[data-edge="' + esc(e.from) + "__" + esc(e.to) + "__" + e.kind + "__" + e.idx + '"]',
		)
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
	// CSP debugging: warn in console so devs know where to look if interactivity breaks
	console.log("[Slang] Render starting \u2014 if tab buttons don\u2019t work, check CSP blocks inline handlers")

	var flow = payload.flow,
		diags = payload.diags || []
	var app = document.getElementById("app"),
		diagsEl = document.getElementById("diags")
	if (!flow) {
		app.innerHTML = '<div class="empty"><h2>No flow found</h2></div>'
		return
	}

	// Build a param-description lookup from ParamMetaDecl nodes.
	var paramDescriptions = {}
	for (var pi = 0; pi < (flow.body || []).length; pi++) {
		var pItem = flow.body[pi]
		if (pItem.type === "ParamMetaDecl" && pItem.description) {
			paramDescriptions[pItem.name] = pItem.description
		}
	}

	var displayTitle = flow.title || flow.name
	var iconEmoji = flow.icon ? iconToEmoji(flow.icon) : "\u26A1" // ⚡ default
	var h = '<div class="flow-header"><h2><span>' + esc(iconEmoji) + "</span> " + esc(displayTitle) + "</h2>"
	if (flow.title && flow.title !== flow.name) {
		h += '<div class="flow-id">flow "' + esc(flow.name) + '"</div>'
	}
	if (flow.description) {
		h += '<div class="flow-desc">' + renderMarkdown(flow.description) + "</div>"
	}
	if (flow.params && flow.params.length > 0) {
		h += '<div class="params">Params: '
		for (var i = 0; i < flow.params.length; i++) {
			var pDesc = paramDescriptions[flow.params[i].name]
			h +=
				'<span class="param-tip"><code>' +
				esc(flow.params[i].name) +
				': "' +
				esc(flow.params[i].paramType) +
				'"</code>' +
				(pDesc ? '<span class="param-tooltip">' + renderMarkdown(pDesc) + "</span>" : "") +
				"</span>" +
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
			'<div class="graph-hint">\uD83D\uDD90\uFE0F Drag nodes to rearrange &nbsp;|&nbsp; \uD83D\uDD04 Auto-layout from topology layers' +
			" &nbsp;|&nbsp; \uD83D\uDD0D Scroll to zoom, drag background to pan</div>"
	} else if (_currentView === "sequence") {
		h +=
			'<div class="graph-hint">\u23F1\uFE0F Message-passing chronology mapped top-to-bottom across processing tracks</div>'
	} else {
		h +=
			'<div class="graph-hint">\uD83E\uDDEC Sequential operation blocks and branching statements broken down per agent lane</div>'
	}

	// ── Zoom controls (topology only) ──
	if (_currentView === "topology") {
		h +=
			'<div class="zoom-controls">' +
			'<button class="zoom-btn" data-zoom="in" title="Zoom in">+</button>' +
			'<button class="zoom-btn" data-zoom="out" title="Zoom out">\u2212</button>' +
			'<button class="zoom-btn" data-zoom="fit" title="Fit to view">\u26F6</button>' +
			"</div>"
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

		// Initialize zoom state from SVG dimensions
		if (_svgEl) {
			var initW = parseFloat(_svgEl.getAttribute("width")) || 500
			var initH = parseFloat(_svgEl.getAttribute("height")) || 300
			_zoomViewBox = { x: 0, y: 0, w: initW, h: initH }
		}

		// ── Node drag ──
		var groups = _svgEl ? Array.prototype.slice.call(_svgEl.querySelectorAll(".node-group")) : []
		for (var gi = 0; gi < groups.length; gi++) groups[gi].addEventListener("mousedown", beginDrag)
		document.removeEventListener("mousemove", moveDrag)
		document.addEventListener("mousemove", moveDrag)
		document.removeEventListener("mouseup", endDrag)
		document.addEventListener("mouseup", endDrag)

		// ── Edge hover highlights ──
		var edgeGroups = _svgEl ? Array.prototype.slice.call(_svgEl.querySelectorAll(".edge-group")) : []
		for (var ei = 0; ei < edgeGroups.length; ei++) {
			edgeGroups[ei].addEventListener("mouseenter", edgeHoverIn)
			edgeGroups[ei].addEventListener("mouseleave", edgeHoverOut)
		}

		// ── Zoom buttons ──
		var zoomBtns = document.querySelectorAll(".zoom-btn[data-zoom]")
		for (var zi = 0; zi < zoomBtns.length; zi++) {
			zoomBtns[zi].addEventListener("click", function () {
				var action = this.getAttribute("data-zoom")
				if (action === "in") zoomIn()
				else if (action === "out") zoomOut()
				else if (action === "fit") zoomFit()
			})
		}

		// ── Mousewheel zoom on SVG ──
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
			// ── Background drag-to-pan on SVG ──
			_svgEl.addEventListener("mousedown", beginSvgPan)
			document.removeEventListener("mousemove", moveSvgPan)
			document.addEventListener("mousemove", moveSvgPan)
			document.removeEventListener("mouseup", endSvgPan)
			document.addEventListener("mouseup", endSvgPan)
		}
	}
}
