// Gate simulations — scripted advisory streams in, delivery decisions out: evidence
// requirement, dedup spanning drops, the agent/human floor split, rate limit +
// cooldown, staleness via stale_if, suppression, and both delivery-time expiry clocks.
// No model anywhere near this.

import type { DetectorFeedback, Observation, TaskLedger } from "../src/types.js"
import { emptyLedger } from "../src/ledger.js"
import { Gate, dedupKeyOf, type GateConfig } from "../src/gate.js"

const T0 = 1_000_000_000_000

function cfg(overrides: Partial<GateConfig> = {}): GateConfig {
	return {
		ratePerHour: 4,
		cooldownS: 300,
		humanFloor: 0.35,
		adviceTtlS: 900,
		queueTimeoutS: 1800,
		muted: false,
		...overrides,
	}
}

function advise(overrides: Partial<DetectorFeedback> = {}): DetectorFeedback {
	return {
		verdict: "advise",
		headline: "No test run observed since the first edit",
		body: "Three new exported functions; no test file touched.",
		evidence: ["write_to_file services/foo/health.go"],
		confidence: 0.72,
		...overrides,
	}
}

function obs(text: string): Observation {
	return { at: T0, kind: "tool", text }
}

let ledger: TaskLedger
let gate: Gate

beforeEach(() => {
	ledger = emptyLedger("t1", T0)
	gate = new Gate()
})

describe("Gate.judge", () => {
	it("delivers an evidenced, confident advisory", () => {
		const d = gate.judge("standard-questions", 0.6, advise(), ledger, [], cfg(), T0)
		expect(d.verdict).toBe("deliver")
		if (d.verdict === "deliver") {
			expect(d.advisory.headline).toContain("No test run")
			expect(d.advisory.humanOnly).toBe(false)
		}
	})

	it("refuses advise with no cited evidence", () => {
		const d = gate.judge("default", 0.6, advise({ evidence: [] }), ledger, [], cfg(), T0)
		expect(d).toEqual({ verdict: "drop", reason: "no_evidence_cited" })
	})

	it("mute drops before anything is shaped", () => {
		const d = gate.judge("default", 0.6, advise(), ledger, [], cfg({ muted: true }), T0)
		expect(d).toEqual({ verdict: "drop", reason: "muted" })
	})

	it("dedup spans dropped advice: a sub-floor hunch cannot spam the user either", () => {
		const weak = advise({ confidence: 0.1 })
		expect(gate.judge("default", 0.6, weak, ledger, [], cfg(), T0)).toEqual({
			verdict: "drop",
			reason: "below_floor",
		})
		// The same finding again — already seen, even though it was dropped.
		expect(gate.judge("default", 0.6, weak, ledger, [], cfg(), T0 + 1000)).toEqual({
			verdict: "drop",
			reason: "duplicate",
		})
	})

	it("the human floor routes weak-but-real hunches to the user only", () => {
		const d = gate.judge("default", 0.6, advise({ confidence: 0.5 }), ledger, [], cfg(), T0)
		expect(d.verdict).toBe("human_only")
		if (d.verdict === "human_only") expect(d.advisory.humanOnly).toBe(true)
	})

	it("suppressed keys (rejected advice) never come back for the task", () => {
		const feedback = advise()
		ledger.suppressed.push(dedupKeyOf("default", feedback))
		expect(gate.judge("default", 0.6, feedback, ledger, [], cfg(), T0)).toEqual({
			verdict: "drop",
			reason: "suppressed",
		})
	})

	it("stale_if kills advice the primary already handled", () => {
		const d = gate.judge(
			"standard-questions",
			0.6,
			advise({ staleIf: ["go test"] }),
			ledger,
			[obs("execute_command\ngo test ./...")],
			cfg(),
			T0,
		)
		expect(d).toEqual({ verdict: "drop", reason: "stale" })
	})

	it("rate limit and cooldown bound the primary's attention", () => {
		const c = cfg({ ratePerHour: 2, cooldownS: 300 })
		const first = gate.judge("a", 0.6, advise({ dedupKey: "k1" }), ledger, [], c, T0)
		expect(first.verdict).toBe("deliver")
		// Cooldown blocks an immediate second delivery.
		expect(gate.judge("a", 0.6, advise({ dedupKey: "k2" }), ledger, [], c, T0 + 1000)).toEqual({
			verdict: "drop",
			reason: "cooldown",
		})
		// After the cooldown a second fits; the third hits the hourly rate.
		expect(gate.judge("a", 0.6, advise({ dedupKey: "k3" }), ledger, [], c, T0 + 400_000).verdict).toBe("deliver")
		expect(gate.judge("a", 0.6, advise({ dedupKey: "k4" }), ledger, [], c, T0 + 800_000)).toEqual({
			verdict: "drop",
			reason: "rate_limited",
		})
	})
})

describe("Gate.stillDeliverable — the two clocks", () => {
	it("validity TTL: generated too long ago ⇒ dropped, never delivered late", () => {
		const d = gate.judge("a", 0.6, advise(), ledger, [], cfg(), T0)
		if (d.verdict !== "deliver") throw new Error("expected deliver")
		expect(gate.stillDeliverable(d.advisory, T0, [], cfg(), T0 + 901_000)).toBe("expired_ttl")
	})

	it("queue timeout: enqueued too long ago ⇒ dropped", () => {
		const d = gate.judge("a", 0.6, advise(), ledger, [], cfg({ adviceTtlS: 10_000 }), T0)
		if (d.verdict !== "deliver") throw new Error("expected deliver")
		expect(gate.stillDeliverable(d.advisory, T0, [], cfg({ adviceTtlS: 10_000 }), T0 + 1_801_000)).toBe(
			"expired_queue",
		)
	})

	it("a late stale match still kills a queued advisory", () => {
		const d = gate.judge("a", 0.6, advise({ staleIf: ["deploy.sh"] }), ledger, [], cfg(), T0)
		if (d.verdict !== "deliver") throw new Error("expected deliver")
		expect(
			gate.stillDeliverable(d.advisory, T0, [obs("execute_command\n./deploy.sh build")], cfg(), T0 + 5000),
		).toBe("stale")
		expect(gate.stillDeliverable(d.advisory, T0, [obs("read_file a.txt")], cfg(), T0 + 5000)).toBeUndefined()
	})
})

describe("dedupKeyOf", () => {
	it("prefers the detector's own key, else a stable headline skeleton", () => {
		expect(dedupKeyOf("d", advise({ dedupKey: "Tests-Not-Run " }))).toBe("tests-not-run")
		const auto = dedupKeyOf("d", advise())
		expect(auto).toBe(dedupKeyOf("d", advise({ body: "different body" })))
		expect(auto.startsWith("d:")).toBe(true)
	})
})
