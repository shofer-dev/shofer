/**
 * projection — the observation contract as a pure, deterministic function.
 *
 * Lifecycle events in, projected observations out; no model, no I/O, no clock (callers
 * stamp `at`). The rules are the ported second-brain contract: keep INTENT (what the
 * agent reached for, where, and roughly why), elide PAYLOAD (file bodies, heredocs, long
 * literals), and NEVER elide a locator — paths and line references are the observer's
 * index into the repository. Every elision leaves a marker recording what was removed,
 * so the observer can judge size and read the file itself when the content decides the
 * question. Golden-tested byte-exactly (__tests__/projection.spec.ts).
 */

import { PROJ, type Observation } from "./types.js"

/** Fields whose value is a locator (or a locator list) — always kept whole. */
const LOCATOR_FIELDS = new Set([
	"path",
	"file_path",
	"filePath",
	"paths",
	"glob",
	"pattern",
	"regex",
	"file_pattern",
	"directory",
	"cwd",
	"symbol",
	"line",
	"start_line",
	"end_line",
	"offset",
	"limit",
])

/** Path-shaped token matcher used to harvest locators out of elided spans. */
const PATH_TOKEN = /(?:^|[\s"'`(=])((?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+(?::\d+(?:-\d+)?)?)/g

/** Cap `s` at `n` chars with an explicit marker — nothing is silently shortened. */
export function cap(s: string, n: number): string {
	if (s.length <= n) return s
	return `${s.slice(0, n)}…[+${s.length - n} chars]`
}

/** Harvest up to PROJ.harvestMax path-shaped tokens from a span being elided. */
export function harvestLocators(span: string): string[] {
	const found: string[] = []
	const seen = new Set<string>()
	for (const m of span.matchAll(PATH_TOKEN)) {
		const token = m[1]!
		if (token.length < 4 || seen.has(token)) continue
		seen.add(token)
		found.push(token)
		if (found.length >= PROJ.harvestMax) break
	}
	return found
}

/**
 * Elide heredoc bodies and long quoted literals from a shell command, structure-aware
 * first so the command still reads as the command it is, then cap. Harvested locators
 * ride the marker.
 */
export function projectCommand(command: string): { text: string; locators: string[] } {
	let text = command
	const locators: string[] = []

	// Heredoc bodies: keep the opener line + head, elide the rest up to the terminator.
	text = text.replace(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\n([\s\S]*?)\n\1/g, (_m, tag: string, body: string) => {
		const lines = body.split("\n")
		const head = cap(lines.slice(0, 2).join("\n"), PROJ.heredocHead)
		const harvested = harvestLocators(body)
		locators.push(...harvested)
		const pathNote = harvested.length ? `; paths: ${harvested.join(", ")}` : ""
		return `<<${tag}\n${head}\n…[+${lines.length} lines elided${pathNote}]\n${tag}`
	})

	if (text.length > PROJ.command) {
		locators.push(...harvestLocators(text.slice(PROJ.command)))
		text = cap(text, PROJ.command)
	}
	return { text, locators: dedupe(locators) }
}

function dedupe(xs: string[]): string[] {
	return [...new Set(xs)]
}

function str(v: unknown): string {
	if (typeof v === "string") return v
	if (v === undefined || v === null) return ""
	try {
		return JSON.stringify(v)
	} catch {
		return String(v)
	}
}

/** Serialize non-locator args capped, locator args whole. */
function projectGenericArgs(args: Record<string, unknown>): { text: string; locators: string[] } {
	const parts: string[] = []
	const locators: string[] = []
	for (const [key, value] of Object.entries(args)) {
		const rendered = str(value)
		if (!rendered) continue
		if (LOCATOR_FIELDS.has(key)) {
			parts.push(`${key}: ${rendered}`)
			if (typeof value === "string") locators.push(value)
		} else {
			if (rendered.length > PROJ.defaultCap) locators.push(...harvestLocators(rendered.slice(PROJ.defaultCap)))
			parts.push(`${key}: ${cap(rendered, PROJ.defaultCap)}`)
		}
	}
	return { text: parts.join("  "), locators: dedupe(locators) }
}

/** Head + size marker for a body payload (write content, diff, edit strings). */
function bodyHead(body: string, headChars: number): { head: string; locators: string[] } {
	const locators = body.length > headChars ? harvestLocators(body.slice(headChars)) : []
	const lines = body.split("\n").length
	const head = body.length <= headChars ? body : `${body.slice(0, headChars)}…[+${lines} lines, ${body.length} chars]`
	return { head, locators }
}

/**
 * Project one tool call into an observation. `kind: "tool"`; the per-tool rules keep
 * the arguments' intent and the file coordinates while dropping the payload.
 */
export function projectToolCall(toolName: string, args: Record<string, unknown>): Omit<Observation, "at"> {
	const locators: string[] = []
	let text: string

	switch (toolName) {
		case "execute_command": {
			const projected = projectCommand(str(args.command))
			locators.push(...projected.locators)
			const cwd = typeof args.cwd === "string" && args.cwd ? `  (cwd: ${args.cwd})` : ""
			text = `execute_command${cwd}\n${projected.text}`
			break
		}
		case "write_to_file": {
			const path = str(args.path)
			const { head, locators: harvested } = bodyHead(str(args.content), PROJ.writeHead)
			locators.push(path, ...harvested)
			text = `write_to_file ${path}\ncontent: ${head}`
			break
		}
		case "apply_diff":
		case "insert_edit":
		case "sed":
		case "edit_file":
		case "search_replace":
		case "edit":
		case "apply_patch": {
			const path = str(args.path ?? args.file_path ?? args.filePath)
			if (path) locators.push(path)
			const body = str(args.diff ?? args.new_string ?? args.replace ?? args.content ?? args.patch ?? args.edit)
			const old = str(args.old_string ?? args.search ?? args.pattern)
			const { head, locators: harvested } = bodyHead(body, PROJ.editNew)
			locators.push(...harvested)
			const oldPart = old ? `\n- ${cap(old, PROJ.editOld)}` : ""
			text = `${toolName} ${path}${oldPart}\n+ ${head}`
			break
		}
		case "new_task": {
			const mode = str(args.mode)
			const message = cap(str(args.message ?? args.prompt), PROJ.subtaskPrompt)
			text = `new_task (mode: ${mode})\n${message}`
			break
		}
		case "attempt_completion": {
			text = `attempt_completion\n${cap(str(args.result), PROJ.subtaskFinal)}`
			break
		}
		case "use_mcp_tool": {
			const generic = projectGenericArgs({ arguments: args.arguments ?? {} })
			locators.push(...generic.locators)
			text = `use_mcp_tool ${str(args.server_name)}/${str(args.tool_name)}  ${generic.text}`
			break
		}
		default: {
			const generic = projectGenericArgs(args)
			locators.push(...generic.locators)
			text = `${toolName}  ${generic.text}`
			break
		}
	}

	return { kind: "tool", text, locators: dedupe(locators.filter(Boolean)) }
}

/**
 * Project a tool's FAILED result — the cheapest high-signal event in the stream. The
 * head usually carries `path:line: message`, the cheapest grounded pointer there is.
 * Successful results are dropped by the caller; this function never sees them.
 */
export function projectToolError(toolName: string, result: string): Omit<Observation, "at"> {
	const head = cap(result, PROJ.errorHead)
	return { kind: "error", text: `${toolName} FAILED: ${head}`, locators: harvestLocators(head) }
}

/** Assistant narration — forwarded whole (capped): the single most valuable segment per byte. */
export function projectNarration(text: string): Omit<Observation, "at"> {
	return { kind: "narration", text: cap(text.trim(), PROJ.text) }
}

/** A user prompt — the goal; without it, drift is undetectable. */
export function projectUserMessage(text: string): Omit<Observation, "at"> {
	return { kind: "user", text: cap(text.trim(), PROJ.userPrompt) }
}

/** An ask the agent raised (a proposal, a question, a completion claim). */
export function projectAsk(askType: string, text: string): Omit<Observation, "at"> {
	return { kind: "ask", text: `ask(${askType}): ${cap(text.trim(), PROJ.defaultCap)}` }
}

/** A subtask's conclusion — the verdict without the transcript. */
export function projectSubtaskFinal(childTaskId: string, result: string): Omit<Observation, "at"> {
	return {
		kind: "subtask",
		text: `subtask ${childTaskId} concluded: ${cap(result.trim(), PROJ.subtaskFinal)}`,
	}
}

/** Render one observation as a window line (stable format — part of the cached prefix). */
export function renderObservation(o: Observation): string {
	const when = new Date(o.at).toISOString().slice(11, 19)
	return `[${when}] ${o.kind}: ${o.text}`
}

/**
 * Heuristic error classifier for afterToolCall results: shofer tool results carry no
 * is_error flag, so the projection keeps only results that read as failures. Ambiguity
 * resolves to "not an error" — a dropped success costs nothing, a false error is noise.
 */
export function looksLikeError(result: string): boolean {
	const head = result.slice(0, 400)
	return /(^|\n)\s*(Error|ERROR|error:|Traceback|FAILED|FAIL\b|panic:|fatal:|exception\b|Exception\b|Command failed|exit code [1-9])/m.test(
		head,
	)
}
