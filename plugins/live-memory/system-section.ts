/**
 * system-section — builds the "LIVE MEMORY" block appended to the agent's system
 * prompt on every build via `transformSystemPrompt`. It is the plugin-native
 * analogue of the built-in `getLiveMemorySection`: it advertises the
 * `ask_live_memory` tool and injects a *live* snapshot of what the memory currently
 * holds (files touched, observation/Q&A counts) so the model knows the companion's
 * state — read straight from the plugin's own store, so it refreshes each prompt.
 */

import type { MemoryData } from "./memory-store.js"

export interface SectionOptions {
	/** Model label (`id via provider`) when known, for parity with the built-in copy. */
	modelLabel?: string
	/** Whether `ctx.ai` is live (granted + consented). When false, the tool will error. */
	aiReady: boolean
}

/** Count distinct file subjects across edit/read/external observations. */
function distinctFiles(data: MemoryData): number {
	const set = new Set<string>()
	for (const o of data.observations) {
		if (o.kind === "task") continue
		set.add(o.subject)
	}
	return set.size
}

/**
 * Render the section. Unlike the built-in (which omits the block entirely when the
 * memory agent is unavailable), the plugin's block is always injected once enabled —
 * but it degrades its wording when `ctx.ai` is not consented, so the model does not
 * lean on a tool that will fail.
 */
export function buildLiveMemorySection(data: MemoryData, opts: SectionOptions): string {
	const files = distinctFiles(data)
	const model = opts.modelLabel ? ` (runs on ${opts.modelLabel})` : ""

	const consentNote = opts.aiReady
		? ""
		: "\n- ⚠️ Not yet AI-consented — `ask_live_memory` will error until the user grants billed-AI consent for this plugin in the Plugins panel."

	const summaryLine = data.stats.summary
		? `\n- **Running summary:** ${truncate(data.stats.summary, 300)}`
		: ""

	return `====

LIVE MEMORY

A persistent, workspace-scoped memory companion is available via the \`ask_live_memory\` tool${model}. It passively accumulates knowledge of this codebase as you work — the files you edit and read, and changes made outside Shofer — and answers investigative questions from that accumulated log.

Current memory state:
- **Observations retained:** ${data.observations.length} (of ${data.stats.totalObservations} seen) across ${files} file(s).
- **Questions answered so far:** ${data.stats.totalQuestions}.${summaryLine}${consentNote}

Best practices:
- Reserve it for **bigger investigative questions** that benefit from accumulated, cross-file context — how a subsystem fits together, what has recently been changing and where.
- Do NOT use it for **simple lookups you can do yourself** with a couple of reads/searches; a misdirected trivial question just costs a model call.
- It is **read-only** — it cannot edit files or run commands. Ask it *about* the code, don't ask it to change code.
`
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
