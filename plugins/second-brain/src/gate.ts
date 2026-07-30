/**
 * gate — between "a fork produced an advisory" and "anyone sees it".
 *
 * Stage order (the reference implementation's, deliberately): evidence required →
 * mute → suppression → dedup (spanning SENT and DROPPED advice, so a repeated
 * sub-floor hunch cannot spam anyone) → confidence floors (the agent/human split) →
 * rate limit + cooldown → staleness (stale_if matched against observations since
 * generation, re-checked at DELIVERY time — in-process, so a mute or a matching
 * action kills a queued advisory instantly) → cap + sanitize + frame. Every refusal
 * is recorded with its reason; a silent drop is indistinguishable from a bug.
 *
 * Two independent rate limits, never conflated: the loop's pass cadence bounds what
 * the observer COSTS; this gate's ratePerHour bounds what it costs the PRIMARY.
 */

import {
	GATE_CONFIDENCE_FLOOR,
	type Advisory,
	type DetectorFeedback,
	type GateDrop,
	type Observation,
	type TaskLedger,
} from "./types.js"
import { shape } from "./advice.js"

export interface GateConfig {
	ratePerHour: number
	cooldownS: number
	humanFloor: number
	adviceTtlS: number
	queueTimeoutS: number
	muted: boolean
}

export type GateDecision =
	| { verdict: "deliver"; advisory: Advisory }
	| { verdict: "human_only"; advisory: Advisory }
	| { verdict: "drop"; reason: GateDrop["reason"] }

/** Normalize a dedup key: detector-provided key, else the headline's word skeleton. */
export function dedupKeyOf(detector: string, feedback: DetectorFeedback): string {
	if (feedback.dedupKey?.trim()) return feedback.dedupKey.trim().toLowerCase()
	const skeleton = (feedback.headline ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9\s/.:-]/g, "")
		.split(/\s+/)
		.filter((w) => w.length > 3)
		.sort()
		.slice(0, 8)
		.join("-")
	return `${detector}:${skeleton}`
}

export class Gate {
	/** Keys of everything sent OR dropped — dedup spans both. Freed when TTLs expire. */
	private seenKeys = new Map<string, number>()
	/** Delivery timestamps inside the sliding hour (rate limit) + the last delivery (cooldown). */
	private deliveries: number[] = []

	/**
	 * Judge one fork advisory. `observationsSince` are the observations that arrived
	 * after the feedback was generated (the staleness re-check input).
	 */
	judge(
		detector: string,
		floor: number | undefined,
		feedback: DetectorFeedback,
		ledger: TaskLedger,
		observationsSince: readonly Observation[],
		cfg: GateConfig,
		now: number,
	): GateDecision {
		if (feedback.verdict !== "advise") return { verdict: "drop", reason: "no_evidence_cited" }

		// Evidence or nothing: an advisory that cannot cite what it saw does not leave.
		if (!feedback.evidence?.length || !feedback.headline?.trim()) {
			return { verdict: "drop", reason: "no_evidence_cited" }
		}
		if (cfg.muted) return { verdict: "drop", reason: "muted" }

		const key = dedupKeyOf(detector, feedback)
		if (ledger.suppressed.includes(key)) return { verdict: "drop", reason: "suppressed" }

		const seenAt = this.seenKeys.get(key)
		if (seenAt !== undefined && now - seenAt < cfg.adviceTtlS * 1000) {
			return { verdict: "drop", reason: "duplicate" }
		}
		this.seenKeys.set(key, now)
		this.expireSeen(now, cfg)

		// Staleness: the detector said at generation what would answer it; match those
		// patterns (case-insensitive substrings) against everything observed since.
		for (const pattern of feedback.staleIf ?? []) {
			const needle = pattern.toLowerCase()
			if (!needle) continue
			if (observationsSince.some((o) => o.text.toLowerCase().includes(needle))) {
				return { verdict: "drop", reason: "stale" }
			}
		}

		const confidence = feedback.confidence ?? 0
		const agentFloor = floor ?? GATE_CONFIDENCE_FLOOR
		if (confidence < cfg.humanFloor) return { verdict: "drop", reason: "below_floor" }

		const advisory: Advisory = shape({
			id: `a${now.toString(36)}${Math.abs(hash(key)).toString(36).slice(0, 4)}`,
			taskId: ledger.taskId,
			detector,
			headline: feedback.headline,
			body: feedback.body ?? "",
			confidence,
			evidence: feedback.evidence,
			dedupKey: key,
			staleIf: feedback.staleIf ?? [],
			humanOnly: confidence < agentFloor,
			finishGate: feedback.finishGate === true,
			generatedAt: now,
		})

		// A hunch too weak for the agent still reaches the person — it costs nothing
		// and is not subject to the agent-attention rate limit.
		if (advisory.humanOnly) return { verdict: "human_only", advisory }

		// Rate limit + cooldown bound the primary's attention.
		this.deliveries = this.deliveries.filter((t) => now - t < 3600 * 1000)
		if (this.deliveries.length >= cfg.ratePerHour) return { verdict: "drop", reason: "rate_limited" }
		const last = this.deliveries[this.deliveries.length - 1]
		if (last !== undefined && now - last < cfg.cooldownS * 1000) return { verdict: "drop", reason: "cooldown" }

		this.deliveries.push(now)
		return { verdict: "deliver", advisory }
	}

	/** Re-validate at the delivery moment (both TTL clocks + a late stale match). */
	stillDeliverable(
		advisory: Advisory,
		enqueuedAt: number,
		observationsSince: readonly Observation[],
		cfg: GateConfig,
		now: number,
	): GateDrop["reason"] | undefined {
		if (cfg.muted) return "muted"
		if (now - advisory.generatedAt > cfg.adviceTtlS * 1000) return "expired_ttl"
		if (now - enqueuedAt > cfg.queueTimeoutS * 1000) return "expired_queue"
		for (const pattern of advisory.staleIf) {
			const needle = pattern.toLowerCase()
			if (needle && observationsSince.some((o) => o.text.toLowerCase().includes(needle))) return "stale"
		}
		return undefined
	}

	/** Expiry frees the dedup key: the same finding may be raised again if still true. */
	private expireSeen(now: number, cfg: GateConfig): void {
		for (const [key, at] of this.seenKeys) {
			if (now - at > cfg.adviceTtlS * 1000 * 2) this.seenKeys.delete(key)
		}
	}
}

function hash(s: string): number {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return h | 0
}
