/**
 * memory-llm — the plugin's LLM adapter, built on `ctx.ai` (the P6.G1 host-LLM
 * capability). It is the plugin-native analogue of the built-in Live Memory's
 * `LiveMemoryLlmClient`: it obtains the *same* `ApiHandler` the main agent uses via
 * `ctx.ai.buildHandler(profileRef)` (never raw API keys) and consumes its stream
 * non-streaming style — drain the async generator, accumulate text, capture usage.
 *
 * The plugin sees the handler only as an opaque value (`PluginAi<unknown>` keeps
 * `@shofer/types` browser-safe), so we describe the slice of the handler surface we
 * actually use with a minimal structural type and cast to it. This mirrors
 * `LiveMemoryLlmClient._runChat` without re-porting its per-provider tool-call
 * plumbing (the plugin's Q&A is a single-turn summarize-over-memory call, not a
 * tool-using agent loop — see DOGFOOD.md "reduced-fidelity").
 */

import type { PluginAi } from "@shofer/types"

import type { MemoryData } from "./memory-store.js"

/** Synthetic task id tagged onto the memory LLM's requests (provider tracing). */
const MEMORY_TASK_ID = "shofer-live-memory-plugin"

/** The minimal slice of the host `ApiHandler` this adapter consumes. */
interface StreamChunk {
	type: string
	text?: string
	inputTokens?: number
	outputTokens?: number
	message?: string
	error?: string
}
interface MinimalMessage {
	role: "user" | "assistant"
	content: string
}
interface MinimalHandler {
	createMessage(
		systemPrompt: string,
		messages: MinimalMessage[],
		metadata: { taskId: string },
	): AsyncIterable<StreamChunk>
	getModel?(): { id: string; info?: { contextWindow?: number } }
}

export interface MemoryAnswer {
	answer: string
	promptTokens: number
	completionTokens: number
	/** The underlying model id, when the handler exposes it (for the section/UI). */
	modelId?: string
}

/**
 * Render the accumulated memory into a compact context block the LLM reasons over.
 * Newest activity last so the model weights recent edits; Q&A history is included so
 * the memory behaves as a persistent companion across tasks.
 */
export function renderMemoryContext(data: MemoryData, maxObservations = 120): string {
	const lines: string[] = []
	if (data.stats.summary) {
		lines.push("## Running summary", data.stats.summary, "")
	}
	const recent = data.observations.slice(-maxObservations)
	if (recent.length > 0) {
		lines.push("## Recent activity (oldest → newest)")
		for (const o of recent) {
			const when = new Date(o.at).toISOString()
			const via = o.via ? ` via ${o.via}` : ""
			const note = o.note ? ` — ${o.note}` : ""
			lines.push(`- [${when}] ${o.kind}: ${o.subject}${via}${note}`)
		}
		lines.push("")
	}
	if (data.qa.length > 0) {
		lines.push("## Earlier questions answered")
		for (const qa of data.qa.slice(-10)) {
			lines.push(`Q: ${qa.question}`, `A: ${qa.answer}`, "")
		}
	}
	if (lines.length === 0) {
		lines.push("(No activity has been observed in this workspace yet.)")
	}
	return lines.join("\n")
}

const SYSTEM_PREAMBLE = `You are Shofer's Live Memory — a persistent, read-only companion that has accumulated a log of activity in a software workspace (files Shofer edited and read, external changes, and prior Q&A).

Answer the user's question using ONLY the accumulated memory below. Be concise and concrete: cite the specific files/observations that ground your answer. If the memory does not contain enough information to answer, say so plainly and suggest what to inspect — do not invent details.`

/**
 * Answer `question` from the accumulated `memory` using `ctx.ai`. Builds the host
 * handler (throws loudly if the plugin is granted `permissions.ai` but not
 * AI-consented — the denying stub), then drains the stream. `profileRef` selects the
 * provider profile (host default when empty).
 */
export async function answerFromMemory(
	ai: PluginAi,
	profileRef: string | undefined,
	question: string,
	memory: MemoryData,
	opts: { maxAnswerChars?: number } = {},
): Promise<MemoryAnswer> {
	const handler = (await ai.buildHandler(profileRef || undefined)) as MinimalHandler

	const context = renderMemoryContext(memory)
	const budget = opts.maxAnswerChars && opts.maxAnswerChars > 0 ? `\n\nKeep your answer under ~${opts.maxAnswerChars} characters.` : ""
	const systemPrompt = `${SYSTEM_PREAMBLE}${budget}\n\n==== ACCUMULATED MEMORY ====\n${context}`

	let answer = ""
	let promptTokens = 0
	let completionTokens = 0

	const stream = handler.createMessage(systemPrompt, [{ role: "user", content: question }], {
		taskId: MEMORY_TASK_ID,
	})
	for await (const chunk of stream) {
		switch (chunk.type) {
			case "text":
				answer += chunk.text ?? ""
				break
			case "usage":
				promptTokens += chunk.inputTokens ?? 0
				completionTokens += chunk.outputTokens ?? 0
				break
			case "error":
				throw new Error(`Live Memory LLM error: ${chunk.message ?? chunk.error ?? "unknown"}`)
			default:
				break
		}
	}

	let modelId: string | undefined
	try {
		modelId = handler.getModel?.().id
	} catch {
		// getModel is best-effort; absence is fine.
	}

	return { answer: answer.trim(), promptTokens, completionTokens, modelId }
}

/**
 * Compact the observation log into a short running summary via `ctx.ai` (used by the
 * background maintenance service). Returns the summary text, or `undefined` when
 * there is nothing worth summarizing.
 */
export async function summarizeMemory(
	ai: PluginAi,
	profileRef: string | undefined,
	memory: MemoryData,
): Promise<string | undefined> {
	if (memory.observations.length === 0) return undefined
	const handler = (await ai.buildHandler(profileRef || undefined)) as MinimalHandler
	const systemPrompt =
		"Summarize the following workspace activity log into a compact, durable set of notes about what parts of the codebase are being worked on and how. Prefer file/area names and relationships. Keep it under 1500 characters."
	const context = renderMemoryContext(memory, 400)

	let summary = ""
	const stream = handler.createMessage(systemPrompt, [{ role: "user", content: context }], {
		taskId: MEMORY_TASK_ID,
	})
	for await (const chunk of stream) {
		if (chunk.type === "text") summary += chunk.text ?? ""
		else if (chunk.type === "error") throw new Error(`Live Memory summarize error: ${chunk.message ?? chunk.error}`)
	}
	return summary.trim() || undefined
}
