/**
 * window — the observer's own conversation: append-only between compactions.
 *
 * This is the discipline the fan-out economics rest on: every pass re-reads a
 * byte-identical prefix (the provider caches it), and the only writes are appends at
 * the end. Nothing already in the window is ever rewritten, reordered or re-rendered;
 * compaction is the one sanctioned prefix rebuild, hysteresis-scheduled (triggered at
 * a high-water mark, compacting down to a floor — never to the trigger, which would
 * re-compact on the next observation and thrash the cache every pass), and it distils
 * the evicted span into the task ledger by NEUTRAL summarization rather than
 * truncation.
 */

import {
	COMPACTION_FLOOR,
	COMPACTION_THRESHOLD,
	WINDOW_BUDGET_CHARS,
	type Observation,
	type PassVerdict,
} from "./types.js"
import { renderObservation } from "./projection.js"

/** One appended window line: an observation or a pass's feedback record. */
interface WindowEntry {
	text: string
	chars: number
}

export class ObserverWindow {
	private entries: WindowEntry[] = []
	private charsTotal = 0

	get chars(): number {
		return this.charsTotal
	}

	get isOverThreshold(): boolean {
		return this.charsTotal > WINDOW_BUDGET_CHARS * COMPACTION_THRESHOLD
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

	/** Render the whole window as the shared user-message body (the cacheable prefix). */
	render(): string {
		return this.entries.map((e) => e.text).join("\n")
	}

	/**
	 * Evict the oldest span down to the floor and return its text for the compactor to
	 * distil into the ledger. The caller appends the distilled note back via
	 * {@link appendCompactionNote}, so the window's head becomes a short summary line
	 * instead of the raw span — a deliberate, rare, amortized prefix rebuild.
	 */
	evictForCompaction(): string {
		const floor = WINDOW_BUDGET_CHARS * COMPACTION_FLOOR
		const evicted: string[] = []
		while (this.charsTotal > floor && this.entries.length > 1) {
			const head = this.entries.shift()!
			this.charsTotal -= head.chars
			evicted.push(head.text)
		}
		return evicted.join("\n")
	}

	/** Prepend the compaction's distilled note as the window's new head. */
	appendCompactionNote(note: string): void {
		const entry = { text: `[compacted] ${note}`, chars: note.length + 13 }
		this.entries.unshift(entry)
		this.charsTotal += entry.chars
	}

	/** Drop every entry at/after `at` — the timeline rewound past them. */
	rewindTo(_at: number): void {
		// Window lines do not carry timestamps individually beyond their rendered text;
		// a rewind invalidates trust in the tail, so the honest cheap response is to
		// keep the window (observations remain true history of what WAS done) — the
		// rewind itself is appended as an observation by the caller. Nothing to do.
	}
}
