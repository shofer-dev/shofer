/**
 * task-observer — everything the Second Brain holds for ONE root task: the spool the
 * hooks feed, the append-only conversation digest, the trigger policy, single-flight passes with
 * pilot-then-fan-out, the demotion ladder, adjudication, budgets, the gate, and
 * delivery. One instance per root task, owned by main.ts, driven by the service tick.
 *
 * The trigger policy is the ported one: two limits that both bind — the clock floor
 * (minIntervalS: the throttle; bounds cost unconditionally) and the volume trigger
 * (triggerChars: proportionality within it) — plus a liveness ceiling (maxIntervalS),
 * a bounded salience allowance (errors, user prompts), and ONE exemption: the task's
 * turn ending always fires a pass, whose verdicts reach the USER only. Bursts are
 * absorbed, not chased: while throttled, observations coalesce into a larger episode.
 */

import {
	ADJUDICATION_WINDOW_OBSERVATIONS,
	ADJUDICATION_WINDOW_S,
	DEMOTE_AFTER_TIMEOUTS,
	DEMOTE_RETRY_S,
	DEMOTE_STRIDE,
	DIGEST_HARD_CAP_CHARS,
	DISABLE_AFTER_TIMEOUTS,
	FINISH_GATE_CONFIDENCE_FLOOR,
	FINISH_GATE_PER_TASK_CAP,
	MAX_PARALLEL_FORKS,
	SALIENCE_PER_HOUR,
	type Advisory,
	type DetectorDef,
	type Observation,
	type PassResult,
	type PassVerdict,
	type TaskLedger,
} from "./types.js"
import { BODY_CAP } from "./types.js"
import { ConversationDigest } from "./digest.js"
import { LedgerStore, recordAdvisory, recordDrop } from "./ledger.js"
import { Gate, type GateConfig } from "./gate.js"
import { renderForAgent, renderForUser } from "./advice.js"
import { buildForkTail, FEEDBACK_TOOL, runFork, type ForkOutcome } from "./fork.js"
import { passToolUnion } from "./tool-executor.js"
import type { ToolDispatcher } from "./tool-executor.js"
import type { ForkClient, ChatMessage } from "./llm.js"
import type { Collision } from "./collisions.js"

/** The stable, cache-shared system prompt every fork of every pass receives. */
export const SHARED_SYSTEM_PROMPT =
	"You are the Second Brain: a background observer watching a coding agent's session through a " +
	"projected log of its EMISSIONS — what it said and what it reached for, never its tool results. " +
	"You are watching, not participating: you cannot edit, block, or ask. The log below uses " +
	"[time] kind: text lines; '…[+N chars]' markers record deliberate elisions (paths are never " +
	"elided — read the file yourself when content decides the question). Prior passes' verdicts " +
	"appear as '[pass N] detector → verdict' lines: reason INCREMENTALLY from your own history " +
	"instead of re-deriving the session. The expected steady state is silence."

export interface ObserverTunables {
	minIntervalS: number
	triggerChars: number
	maxIntervalS: number
	forkDeadlineS: number
	tokensPerTask: number
	tokensPerHour: number
	finishGateEnabled: boolean
	finishGateMinIntervalS: number
	turnEndReport: boolean
	gate: GateConfig
}

/** How main.ts delivers for the observer (seams, so the observer stays host-free). */
export interface DeliverySeams {
	/** One-way injection beside the agent's next request (notify mode). */
	notifyAgent(text: string): Promise<void>
	/** Queue-mode injection that can restart a completed task (the finish gate). */
	queueAgent(text: string): Promise<void>
	/** A user-visible marker row (the advisory / report renderings). */
	marker(kind: string, text: string, data?: Record<string, unknown>): Promise<void>
	/** Load the effective catalogue (re-read at pass boundaries). */
	loadDetectors(): Promise<DetectorDef[]>
	/** Client for a detector's provider profile (undefined = the plugin default). */
	clientFor(provider?: string): ForkClient
	executor(): ToolDispatcher
	tunables(): ObserverTunables
	debugCapture(taskId: string, pass: number, name: string, content: string): Promise<void>
	log(message: string): void
}

interface DetectorRuntime {
	consecutiveTimeouts: number
	demoted: boolean
	disabledAt?: number
}

export class TaskObserver {
	/** Every projected observation, in order — the source the digest/gate read from. */
	private spool: Observation[] = []
	private spoolChars = 0
	private digest = new ConversationDigest()
	private gate = new Gate()
	private ledger?: TaskLedger
	private runtime = new Map<string, DetectorRuntime>()
	private pendingCollisions: Collision[] = []

	private passCount = 0
	private lastPassStartedAt = 0
	private lastPassSpoolIndex = 0
	private charsSinceLastPass = 0
	private passInFlight = false
	private salienceFires: number[] = []
	private saliencePending = false
	private turnEndPending = false
	private manualPending = false
	private hourTokens: { at: number; total: number }[] = []
	private completed = false

	lastPass?: PassResult

	constructor(
		readonly taskId: string,
		private readonly cwd: string | undefined,
		private readonly ledgers: LedgerStore,
		private readonly seams: DeliverySeams,
	) {}

	// ─── Feeding (called from hooks; must stay O(observation) and never throw) ─────

	observe(o: Observation): void {
		this.spool.push(o)
		this.spoolChars += o.text.length
		this.charsSinceLastPass += o.text.length
		this.digest.appendObservation(o)
		if (o.kind === "error" || o.kind === "user") this.saliencePending = true
	}

	noteGoal(goal: string): void {
		void this.withLedger((ledger) => {
			if (!ledger.goal) ledger.goal = goal.slice(0, 300)
		})
	}

	noteCollisions(collisions: Collision[]): void {
		this.pendingCollisions.push(...collisions)
	}

	/** The task's turn ended (idle ask) or the task completed — always worth a pass. */
	noteTurnEnd(completed: boolean): void {
		this.turnEndPending = true
		if (completed) this.completed = true
	}

	requestManualPass(): void {
		this.manualPending = true
	}

	get stats() {
		return {
			taskId: this.taskId,
			passes: this.passCount,
			digestChars: this.digest.chars,
			spoolChars: this.spoolChars,
			advisoriesDelivered: this.ledger?.advisories.filter((a) => !a.humanOnly).length ?? 0,
			lastPassAt: this.lastPass?.at,
			lastVerdicts: this.lastPass?.verdicts,
			costUsd: this.ledger?.costUsd ?? 0,
		}
	}

	// ─── The trigger policy ────────────────────────────────────────────────────────

	/** Decide whether a pass is due now; called from the service tick. */
	dueTrigger(now: number): PassResult["trigger"] | undefined {
		if (this.passInFlight) return undefined
		if (this.manualPending) return "manual"
		// Turn end: exempt from every limit — turns end infrequently by nature.
		if (this.turnEndPending && this.spool.length > this.lastPassSpoolIndex) return "turn_end"

		const t = this.seams.tunables()
		const sinceLast = (now - this.lastPassStartedAt) / 1000
		const pending = this.spool.length > this.lastPassSpoolIndex

		if (!pending) return undefined
		// Salience: an error or user prompt may fire early, from a bounded hourly bucket.
		if (this.saliencePending && sinceLast >= t.minIntervalS / 3) {
			this.salienceFires = this.salienceFires.filter((at) => now - at < 3600 * 1000)
			if (this.salienceFires.length < SALIENCE_PER_HOUR) return "salience"
		}
		if (sinceLast < t.minIntervalS) return undefined
		if (this.charsSinceLastPass >= t.triggerChars) return "volume"
		if (sinceLast >= t.maxIntervalS) return "clock"
		return undefined
	}

	// ─── The pass ─────────────────────────────────────────────────────────────────

	/** Run one pass (single-flight; callers check {@link dueTrigger} or force manual). */
	async runPass(trigger: PassResult["trigger"], now: () => number): Promise<PassResult | undefined> {
		if (this.passInFlight) return undefined
		this.passInFlight = true
		const startedAt = now()
		this.lastPassStartedAt = startedAt
		if (trigger === "salience") this.salienceFires.push(startedAt)
		this.saliencePending = false
		const wasTurnEnd = this.turnEndPending
		this.turnEndPending = false
		this.manualPending = false

		try {
			const t = this.seams.tunables()
			const ledger = await this.withLedger(() => {})
			const episodeStart = this.lastPassSpoolIndex
			this.lastPassSpoolIndex = this.spool.length
			this.charsSinceLastPass = 0
			this.passCount++
			ledger.passes = this.passCount

			// Budget guard: exhaustion degrades to SILENCE, and says so.
			if (this.budgetExhausted(t, startedAt)) {
				const result: PassResult = {
					pass: this.passCount,
					at: startedAt,
					trigger,
					verdicts: [{ detector: "*", verdict: "skipped", note: "(budget exhausted)" }],
					tokens: { prompt: 0, completion: 0 },
					costUsd: 0,
					durationMs: 0,
				}
				this.lastPass = result
				return result
			}

			// The digest is the complete conversation and is never truncated; a digest
			// past the practical cap skips passes LOUDLY instead of feeding a request
			// the observer model cannot hold.
			if (this.digest.chars > DIGEST_HARD_CAP_CHARS) {
				const result: PassResult = {
					pass: this.passCount,
					at: startedAt,
					trigger,
					verdicts: [
						{
							detector: "*",
							verdict: "skipped",
							note: "(digest exceeds the observer's practical context)",
						},
					],
					tokens: { prompt: 0, completion: 0 },
					costUsd: 0,
					durationMs: 0,
				}
				this.lastPass = result
				return result
			}

			const defs = await this.seams.loadDetectors()
			const running = this.selectDetectors(defs, startedAt)
			if (running.length === 0) return undefined

			// The pass union goes on the wire for every fork; grants enforce per detector.
			const tools = [...passToolUnion(running), FEEDBACK_TOOL]
			const systemPrompt = `${SHARED_SYSTEM_PROMPT}\n\nWorkspace: ${this.cwd ?? "(unknown)"}`
			// The prefix is the digest alone. Judgment (advisories, suppression) stays in
			// storage and rides each fork's private tail — putting the mutable ledger in
			// the prefix would bust the byte-stable prefix on every delivery.
			const prefix: ChatMessage[] = [
				{
					role: "user",
					content: `OBSERVATION DIGEST (the complete conversation, stripped)\n${this.digest.render()}`,
				},
			]

			// Pilot first — the prefix must be written once regardless, so the write may
			// as well come with useful output; the rest fan out against the warm prefix.
			const pilot = running.find((d) => d.pilot) ?? running.find((d) => d.tools.length === 0) ?? running[0]!
			const rest = running.filter((d) => d !== pilot)

			const verdicts: PassVerdict[] = []
			const tokens = { prompt: 0, completion: 0 }
			let costUsd = 0
			const advisoriesOut: Advisory[] = []

			const runOne = async (detector: DetectorDef): Promise<void> => {
				const openAdvisories = ledger.advisories.filter(
					(a) => a.detector === detector.slug && a.deliveredAt && !a.outcome,
				)
				const structuralNote =
					detector.slug === "cross-task-collision" && this.pendingCollisions.length
						? this.pendingCollisions
								.map(
									(c) =>
										`${c.path} also touched by task ${c.otherTaskId} (${c.sameCwd ? "SAME working directory — urgent" : "separate worktree — merge-time"})`,
								)
								.join("; ")
						: undefined
				const deadlineS = detector.deadlineS || t.forkDeadlineS
				const outcome = await runFork({
					detector,
					systemPrompt,
					prefix,
					tail: buildForkTail(detector, openAdvisories, deadlineS, BODY_CAP, structuralNote),
					tools,
					client: this.seams.clientFor(detector.provider),
					executor: this.seams.executor(),
					deadlineS,
				})
				tokens.prompt += outcome.tokens.prompt
				tokens.completion += outcome.tokens.completion
				costUsd += outcome.costUsd
				this.absorbForkOutcome(detector, outcome, ledger, episodeStart, verdicts, advisoriesOut, startedAt)
				await this.seams.debugCapture(this.taskId, this.passCount, detector.slug, outcome.trace.join("\n\n"))
			}

			await runOne(pilot)
			for (let i = 0; i < rest.length; i += MAX_PARALLEL_FORKS) {
				await Promise.all(rest.slice(i, i + MAX_PARALLEL_FORKS).map(runOne))
			}
			if (pilot.slug === "cross-task-collision" || rest.some((d) => d.slug === "cross-task-collision")) {
				this.pendingCollisions = []
			}

			// Only the compact feedback merges back — append-only, detector-name order.
			verdicts.sort((a, b) => a.detector.localeCompare(b.detector))
			this.digest.appendFeedback(this.passCount, startedAt, verdicts)

			// Self-close stale outcome records: ambiguity resolves against the observer.
			this.closeLapsedOutcomes(ledger, startedAt)

			ledger.tokens.prompt += tokens.prompt
			ledger.tokens.completion += tokens.completion
			ledger.costUsd += costUsd
			this.hourTokens.push({ at: startedAt, total: tokens.prompt + tokens.completion })
			await this.ledgers.save(ledger, now())

			// Deliver what survived the gate (delivery-time staleness re-checked).
			for (const advisory of advisoriesOut) {
				await this.deliver(advisory, ledger, now())
			}
			// Turn-end verdicts reach the user only.
			if (wasTurnEnd && t.turnEndReport) {
				await this.reportTurnEnd(verdicts)
			}
			// The finish gate: at most once per task per interval, hard per-task cap.
			if (this.completed && t.finishGateEnabled) {
				await this.maybeFinishGate(advisoriesOut, ledger, t, now())
			}

			const result: PassResult = {
				pass: this.passCount,
				at: startedAt,
				trigger,
				verdicts,
				tokens,
				costUsd,
				durationMs: now() - startedAt,
			}
			this.lastPass = result
			return result
		} catch (error) {
			this.seams.log(`pass failed: ${error instanceof Error ? error.message : String(error)}`)
			return undefined
		} finally {
			this.passInFlight = false
		}
	}

	// ─── Pieces ───────────────────────────────────────────────────────────────────

	private selectDetectors(defs: DetectorDef[], now: number): DetectorDef[] {
		return defs.filter((d) => {
			if (!d.enabled) return false
			// Structural detectors run only when the worker computed a match.
			if (d.structural && d.slug === "cross-task-collision" && this.pendingCollisions.length === 0) return false
			const rt = this.runtime.get(d.slug)
			if (rt?.disabledAt !== undefined) {
				// Retry a disabled detector once after the retry interval.
				if (now - rt.disabledAt < DEMOTE_RETRY_S * 1000) return false
				rt.disabledAt = undefined
				rt.consecutiveTimeouts = 0
				rt.demoted = false
			}
			const stride = rt?.demoted ? d.cadenceNth * DEMOTE_STRIDE : d.cadenceNth
			return this.passCount % Math.max(1, stride) === 0
		})
	}

	private absorbForkOutcome(
		detector: DetectorDef,
		outcome: ForkOutcome,
		ledger: TaskLedger,
		episodeStart: number,
		verdicts: PassVerdict[],
		advisoriesOut: Advisory[],
		now: number,
	): void {
		const rt = this.runtime.get(detector.slug) ?? { consecutiveTimeouts: 0, demoted: false }
		this.runtime.set(detector.slug, rt)

		if (outcome.verdictKind === "timeout") {
			rt.consecutiveTimeouts++
			// The demotion ladder: rate-limit, then disable for the task, then retry once.
			if (rt.consecutiveTimeouts >= DISABLE_AFTER_TIMEOUTS) {
				rt.disabledAt = now
				this.seams.log(`detector ${detector.slug} disabled for this task (${rt.consecutiveTimeouts} timeouts)`)
			} else if (rt.consecutiveTimeouts >= DEMOTE_AFTER_TIMEOUTS && !rt.demoted) {
				rt.demoted = true
				this.seams.log(
					`detector ${detector.slug} demoted to every ${DEMOTE_STRIDE * detector.cadenceNth}th pass`,
				)
			}
			verdicts.push({ detector: detector.slug, verdict: "timeout" })
			return
		}
		if (outcome.verdictKind === "error") {
			verdicts.push({ detector: detector.slug, verdict: "error" })
			return
		}
		rt.consecutiveTimeouts = 0

		const feedback = outcome.feedback
		// Adjudication rides the same call: suppression + the ledger consume it.
		for (const o of feedback.outcomes ?? []) {
			const advisory = ledger.advisories.find((a) => a.id === o.adviceId)
			if (!advisory || advisory.outcome) continue
			const evidenced = o.verdict === "no_evidence" || (o.evidence?.length ?? 0) > 0
			const verdict = evidenced ? o.verdict : "no_evidence"
			advisory.outcome = { verdict, evidence: o.evidence, at: now }
			if (verdict === "rejected" || verdict === "contradicted") {
				if (!ledger.suppressed.includes(advisory.dedupKey)) ledger.suppressed.push(advisory.dedupKey)
			}
		}

		if (feedback.verdict === "advise") {
			const t = this.seams.tunables()
			const since = this.spool.slice(episodeStart)
			const decision = this.gate.judge(
				detector.slug,
				detector.confidenceFloor,
				feedback,
				ledger,
				since,
				t.gate,
				now,
			)
			if (decision.verdict === "drop") {
				recordDrop(ledger, {
					at: now,
					detector: detector.slug,
					headline: feedback.headline ?? "",
					reason: decision.reason,
				})
				verdicts.push({ detector: detector.slug, verdict: "advise", note: `(gated: ${decision.reason})` })
				return
			}
			advisoriesOut.push(decision.advisory)
			verdicts.push({
				detector: detector.slug,
				verdict: "advise",
				note: `"${decision.advisory.headline}" (${decision.advisory.confidence.toFixed(2)})`,
			})
			return
		}
		verdicts.push({ detector: detector.slug, verdict: feedback.verdict })
	}

	private async deliver(advisory: Advisory, ledger: TaskLedger, now: number): Promise<void> {
		// Delivery-time re-check: both clocks + late staleness + mute.
		const t = this.seams.tunables()
		const since = this.spool.slice(this.lastPassSpoolIndex)
		const refusal = this.gate.stillDeliverable(advisory, advisory.generatedAt, since, t.gate, now)
		if (refusal) {
			recordDrop(ledger, { at: now, detector: advisory.detector, headline: advisory.headline, reason: refusal })
			return
		}
		advisory.deliveredAt = now
		recordAdvisory(ledger, advisory)
		await this.ledgers.save(ledger, now)

		// Say it to both: the marker is the user half of every delivery.
		await this.seams.marker("advisory", renderForUser(advisory), {
			advisoryId: advisory.id,
			detector: advisory.detector,
			humanOnly: advisory.humanOnly,
		})
		if (!advisory.humanOnly) {
			await this.seams.notifyAgent(renderForAgent(advisory))
		}
	}

	private async reportTurnEnd(verdicts: PassVerdict[]): Promise<void> {
		const lines = verdicts.map((v) => `   ${v.detector} → ${v.verdict}${v.note ? ` ${v.note}` : ""}`)
		await this.seams.marker(
			"turn-report",
			`🧠 Second Brain — turn-end verdicts (not shown to the agent):\n${lines.join("\n")}`,
		)
	}

	private async maybeFinishGate(
		advisories: Advisory[],
		ledger: TaskLedger,
		t: ObserverTunables,
		now: number,
	): Promise<void> {
		const candidate = advisories.find(
			(a) => a.finishGate && !a.humanOnly && a.confidence >= FINISH_GATE_CONFIDENCE_FLOOR,
		)
		if (!candidate) return
		ledger.finishGateFirings = ledger.finishGateFirings.filter((at) => now - at < t.finishGateMinIntervalS * 1000)
		if (ledger.finishGateFirings.length > 0) return
		if (ledger.advisories.filter((a) => a.finishGate && a.deliveredAt).length >= FINISH_GATE_PER_TASK_CAP) return
		ledger.finishGateFirings.push(now)
		await this.ledgers.save(ledger, now)
		await this.seams.marker(
			"finish-gate",
			`🧠 Second Brain finish gate: the task stopped, but "${candidate.headline}" (${candidate.detector}) is evidenced as unfinished.`,
		)
		await this.seams.queueAgent(renderForAgent(candidate))
	}

	private closeLapsedOutcomes(ledger: TaskLedger, now: number): void {
		for (const advisory of ledger.advisories) {
			if (!advisory.deliveredAt || advisory.outcome) continue
			const observationsSince = this.spool.length - this.lastPassSpoolIndex
			const lapsedByTime = now - advisory.deliveredAt > ADJUDICATION_WINDOW_S * 1000
			const lapsedByVolume = observationsSince > ADJUDICATION_WINDOW_OBSERVATIONS
			if (lapsedByTime || lapsedByVolume) {
				advisory.outcome = { verdict: "no_evidence", at: now }
			}
		}
	}

	private budgetExhausted(t: ObserverTunables, now: number): boolean {
		const ledger = this.ledger
		if (ledger && ledger.tokens.prompt + ledger.tokens.completion >= t.tokensPerTask) return true
		this.hourTokens = this.hourTokens.filter((h) => now - h.at < 3600 * 1000)
		const hourly = this.hourTokens.reduce((sum, h) => sum + h.total, 0)
		return hourly >= t.tokensPerHour
	}

	private async withLedger(mutate: (ledger: TaskLedger) => void): Promise<TaskLedger> {
		if (!this.ledger) {
			this.ledger = await this.ledgers.load(this.taskId, Date.now())
		}
		mutate(this.ledger)
		return this.ledger
	}

	/** Expose the ledger for the surfaces (why/stats). May be undefined before first use. */
	get currentLedger(): TaskLedger | undefined {
		return this.ledger
	}
}
