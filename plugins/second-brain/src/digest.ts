/**
 * digest — a stripped-down version of the COMPLETE conversation.
 *
 * Not a window: nothing is ever evicted, compacted, or summarized away. The digest is
 * the full projected observation stream of the task from the moment the observer
 * attached — every narration, projected tool call, ask, error head, user prompt and
 * prior pass's feedback lines — appended in order and never rewritten. That gives the
 * detectors the whole story every pass, and it is exactly what makes the fan-out
 * cache-cheap: the rendered digest is a byte-stable, append-only prefix, so each pass
 * re-reads the accumulated history at the provider's cached rates and pays full price
 * only for its own increment. The cost ceiling is the budget guard and, ultimately,
 * the observer model's context window (a digest past the practical cap skips passes
 * loudly — see task-observer.ts — rather than silently truncating).
 */

import type { Observation, PassVerdict } from "./types.js"
import { renderObservation } from "./projection.js"

interface DigestEntry {
	text: string
	chars: number
}

export class ConversationDigest {
	private entries: DigestEntry[] = []
	private charsTotal = 0

	get chars(): number {
		return this.charsTotal
	}

	appendObservation(o: Observation): void {
		this.push(renderObservation(o))
	}

	/** One compact line per detector per pass — the only fork output that returns. */
	appendFeedback(pass: number, at: number, verdicts: PassVerdict[]): void {
		const when = new Date(at).toISOString().slice(11, 19)
		for (const v of verdicts) {
			const note = v.note ? ` ${v.note}` : ""
			this.push(`[pass ${pass}, ${when}] ${v.detector} → ${v.verdict}${note}`)
		}
	}

	private push(text: string): void {
		this.entries.push({ text, chars: text.length + 1 })
		this.charsTotal += text.length + 1
	}

	/** Render the whole digest as the shared user-message body (the cacheable prefix). */
	render(): string {
		return this.entries.map((e) => e.text).join("\n")
	}
}
