/**
 * fork — one detector on the shared prefix: private tail, small tool loop, feedback.
 *
 * A fork is N independent provider requests sharing one message prefix — the shape of
 * the data, not a runtime object. The prefix (shared system prompt + rendered digest)
 * is byte-identical across every fork of a pass and across passes (append-only), which
 * is what makes the fan-out cache-cheap; the detector's own instructions, grant, open
 * advisories and stated budgets ride in its PRIVATE tail, after the prefix. A fork's
 * tool results live only in its local message list, discarded on return — isolation by
 * scope. Every fork ends by calling `second_brain_detector_feedback`; a prose reply
 * with no call coerces to SILENT (never to an invented finding), and the last
 * iteration nudges the call explicitly (the ApiHandler surface has no tool_choice).
 */

import {
	FEEDBACK_TOOL_NAME,
	FORK_GRACE_S,
	MAX_FORK_ITERATIONS,
	type AdviceOutcome,
	type Advisory,
	type DetectorFeedback,
	type OutcomeVerdict,
} from "./types.js"
import type { ChatMessage, ContentBlock, ForkClient, ToolDefinition } from "./llm.js"
import type { ToolDispatcher } from "./tool-executor.js"
import type { DetectorDef } from "./types.js"

/** The feedback tool's wire definition — part of every pass's (union) tools array. */
export const FEEDBACK_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: FEEDBACK_TOOL_NAME,
		description:
			"Your ONLY way to conclude. verdict silent = nothing worth saying (the normal case); advise = one specific, evidenced finding; resolved = an earlier advisory of yours was acted on; still_open = it was not, yet.",
		parameters: {
			type: "object",
			properties: {
				verdict: { type: "string", enum: ["silent", "advise", "resolved", "still_open"] },
				headline: { type: "string", description: "One line; often all that gets read." },
				body: { type: "string", description: "The argument and what to do about it. Short." },
				evidence: {
					type: "array",
					items: { type: "string" },
					description: "Specific observations/locators grounding the finding. REQUIRED for advise.",
				},
				confidence: { type: "number", description: "0..1" },
				dedup_key: { type: "string", description: "Stable semantic key for this finding." },
				stale_if: {
					type: "array",
					items: { type: "string" },
					description:
						"Substrings whose later appearance in the stream means it was handled ('go test', 'deploy.sh').",
				},
				finish_gate: { type: "boolean", description: "True only for evidenced unfinished work at task end." },
				outcomes: {
					type: "array",
					description: "Verdicts on YOUR outstanding advisories, with cited post-delivery evidence.",
					items: {
						type: "object",
						properties: {
							advice_id: { type: "string" },
							verdict: {
								type: "string",
								enum: [
									"adopted",
									"partially_adopted",
									"rejected",
									"already_handled",
									"no_evidence",
									"contradicted",
								],
							},
							evidence: { type: "array", items: { type: "string" } },
						},
						required: ["advice_id", "verdict"],
					},
				},
			},
			required: ["verdict"],
		},
	},
}

const OUTCOME_VERDICTS: ReadonlySet<string> = new Set([
	"adopted",
	"partially_adopted",
	"rejected",
	"already_handled",
	"no_evidence",
	"contradicted",
])

/** Parse + validate the feedback tool's arguments; anything malformed coerces to silent. */
export function parseFeedback(argsRaw: string): DetectorFeedback {
	try {
		const raw = JSON.parse(argsRaw) as Record<string, unknown>
		const verdict = raw.verdict
		if (verdict !== "silent" && verdict !== "advise" && verdict !== "resolved" && verdict !== "still_open") {
			return { verdict: "silent" }
		}
		const outcomes: AdviceOutcome[] = Array.isArray(raw.outcomes)
			? (raw.outcomes as Record<string, unknown>[])
					.filter((o) => typeof o?.advice_id === "string" && OUTCOME_VERDICTS.has(String(o?.verdict)))
					.map((o) => ({
						adviceId: String(o.advice_id),
						verdict: String(o.verdict) as OutcomeVerdict,
						evidence: Array.isArray(o.evidence) ? o.evidence.map(String) : undefined,
					}))
			: []
		return {
			verdict,
			headline: typeof raw.headline === "string" ? raw.headline : undefined,
			body: typeof raw.body === "string" ? raw.body : undefined,
			evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String) : undefined,
			confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
			dedupKey: typeof raw.dedup_key === "string" ? raw.dedup_key : undefined,
			staleIf: Array.isArray(raw.stale_if) ? raw.stale_if.map(String) : undefined,
			finishGate: raw.finish_gate === true,
			outcomes,
		}
	} catch {
		return { verdict: "silent" }
	}
}

/** Build the fork's private tail — instructions, grant, open advisories, stated budgets. */
export function buildForkTail(
	detector: DetectorDef,
	openAdvisories: readonly Advisory[],
	deadlineS: number,
	bodyCap: number,
	structuralNote?: string,
): string {
	const lines: string[] = [
		`You are the "${detector.slug}" detector of the Second Brain, examining the observation log above.`,
		"",
		detector.system,
		"",
		`You have ~${deadlineS}s and ~${bodyCap} characters for your answer. ` +
			`You MUST conclude by calling ${FEEDBACK_TOOL_NAME}; ending without it counts as silent.`,
	]
	if (detector.tools.length) {
		lines.push(`Tools you may use: ${detector.tools.join(", ")}. Calls outside this list are refused.`)
		if (detector.exec.length) lines.push(`execute_command allowlist (exact strings): ${detector.exec.join(" | ")}`)
	} else {
		lines.push("You have no tools: reason over the log and answer in one call.")
	}
	if (detector.config && Object.keys(detector.config).length) {
		lines.push(`Your configuration: ${JSON.stringify(detector.config)}`)
	}
	if (structuralNote) {
		lines.push("", `Structural trigger (already established — write the advisory): ${structuralNote}`)
	}
	if (openAdvisories.length) {
		lines.push("", "Your outstanding advisories to adjudicate in `outcomes` (evidence or no_evidence):")
		for (const a of openAdvisories) {
			lines.push(
				`- ${a.id}: "${a.headline}" (delivered ${new Date(a.deliveredAt ?? a.generatedAt).toISOString()})`,
			)
		}
	}
	return lines.join("\n")
}

export interface ForkOutcome {
	feedback: DetectorFeedback
	verdictKind: "ok" | "timeout" | "error"
	tokens: { prompt: number; completion: number }
	costUsd: number
	/** Debug capture: the fork's whole private loop (tail, replies, tool rounds). */
	trace: string[]
}

/**
 * Run one detector fork to its feedback. The prefix is shared BY REFERENCE and never
 * mutated; if its last message and the tail are both user-role they are merged at
 * request build (providers require alternation), which preserves every earlier
 * message's bytes for the provider's prefix cache.
 */
export async function runFork(opts: {
	detector: DetectorDef
	systemPrompt: string
	prefix: readonly ChatMessage[]
	tail: string
	tools: ToolDefinition[]
	client: ForkClient
	executor: ToolDispatcher
	deadlineS: number
}): Promise<ForkOutcome> {
	const { detector, client, executor } = opts
	const tokens = { prompt: 0, completion: 0 }
	let costUsd = 0
	const trace: string[] = [`tail:\n${opts.tail}`]

	const controller = new AbortController()
	const hardMs = (opts.deadlineS + FORK_GRACE_S) * 1000
	const timer = setTimeout(() => controller.abort(), hardMs)

	// Merge an adjacent user tail into the prefix's last user message (alternation).
	const local: ChatMessage[] = [...opts.prefix]
	const last = local[local.length - 1]
	if (last && last.role === "user" && typeof last.content === "string") {
		local[local.length - 1] = { role: "user", content: `${last.content}\n\n====\n\n${opts.tail}` }
	} else {
		local.push({ role: "user", content: opts.tail })
	}

	try {
		for (let iteration = 0; iteration < MAX_FORK_ITERATIONS; iteration++) {
			const result = await client.chat({
				systemPrompt: opts.systemPrompt,
				messages: local,
				tools: opts.tools,
				signal: controller.signal,
			})
			tokens.prompt += result.tokens.prompt
			tokens.completion += result.tokens.completion
			costUsd += result.costUsd
			trace.push(
				`reply ${iteration}: ${result.text || "(no text)"} tools:[${result.toolCalls.map((c) => c.name).join(",")}]`,
			)

			const feedbackCall = result.toolCalls.find((c) => c.name === FEEDBACK_TOOL_NAME)
			if (feedbackCall) {
				clearTimeout(timer)
				return { feedback: parseFeedback(feedbackCall.arguments), verdictKind: "ok", tokens, costUsd, trace }
			}
			if (result.toolCalls.length === 0) {
				// Prose with no call coerces to silent — never to an invented finding.
				clearTimeout(timer)
				return { feedback: { verdict: "silent" }, verdictKind: "ok", tokens, costUsd, trace }
			}

			// Execute the requested tools; results stay in THIS fork's local list.
			const toolUses: ContentBlock[] = result.toolCalls.map((c) => ({
				type: "tool_use",
				id: c.id,
				name: c.name,
				input: safeParse(c.arguments),
			}))
			if (result.text) toolUses.unshift({ type: "text", text: result.text })
			local.push({ role: "assistant", content: toolUses })

			const results: ContentBlock[] = []
			for (const call of result.toolCalls) {
				const outcome = await executor.execute(detector, call.name, call.arguments)
				trace.push(`tool ${call.name}: ${outcome.content.slice(0, 500)}`)
				results.push({
					type: "tool_result",
					tool_use_id: call.id,
					content: outcome.content,
					is_error: outcome.isError,
				})
			}
			// The last iteration's nudge: conclude now.
			if (iteration === MAX_FORK_ITERATIONS - 2) {
				results.push({
					type: "text",
					text: `Out of iterations — call ${FEEDBACK_TOOL_NAME} now with your verdict.`,
				})
			}
			local.push({ role: "user", content: results })
		}
		clearTimeout(timer)
		return { feedback: { verdict: "silent" }, verdictKind: "ok", tokens, costUsd, trace }
	} catch (error) {
		clearTimeout(timer)
		const aborted = error instanceof Error && error.name === "AbortError"
		trace.push(aborted ? "hard deadline cancelled the fork" : `error: ${String(error)}`)
		return {
			feedback: { verdict: "silent" },
			verdictKind: aborted ? "timeout" : "error",
			tokens,
			costUsd,
			trace,
		}
	}
}

function safeParse(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw) as Record<string, unknown>
	} catch {
		return {}
	}
}
