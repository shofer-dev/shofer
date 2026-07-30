/**
 * second-brain — domain types and tunables.
 *
 * Everything numeric here is a named constant or a manifest `config` default (read via
 * `ctx.config`); nothing elsewhere in the plugin embeds a magic number. The observation /
 * feedback / advisory shapes are the plugin's own — zero footprint in `@shofer/types`.
 */

/** One projected observation — the unit the window accumulates. */
export interface Observation {
	/** Unix ms when observed. */
	at: number
	kind: "user" | "narration" | "tool" | "ask" | "error" | "subtask" | "task"
	/** The projected text (already elided/capped by projection.ts). */
	text: string
	/** Workspace-relative locators harvested from the source event (never elided). */
	locators?: string[]
}

/** A detector fork's structured return — the only thing merged back into the window. */
export interface DetectorFeedback {
	verdict: "silent" | "advise" | "resolved" | "still_open"
	headline?: string
	body?: string
	evidence?: string[]
	confidence?: number
	dedupKey?: string
	/** Patterns over later observations that would make this already-handled. */
	staleIf?: string[]
	/** Evidenced unfinished work, worth continuing a turn believed over. */
	finishGate?: boolean
	/** Verdicts on this detector's own outstanding advisories. */
	outcomes?: AdviceOutcome[]
}

export type OutcomeVerdict =
	| "adopted"
	| "partially_adopted"
	| "rejected"
	| "already_handled"
	| "no_evidence"
	| "contradicted"

export interface AdviceOutcome {
	adviceId: string
	verdict: OutcomeVerdict
	evidence?: string[]
}

/** A gated advisory awaiting or past delivery. */
export interface Advisory {
	id: string
	taskId: string
	/** Detector mode slug (unqualified, e.g. "standard-questions"). */
	detector: string
	headline: string
	body: string
	confidence: number
	evidence: string[]
	dedupKey: string
	staleIf: string[]
	/** Cleared the human floor but not the agent floor: marker only, never injected. */
	humanOnly: boolean
	finishGate: boolean
	generatedAt: number
	deliveredAt?: number
	outcome?: { verdict: OutcomeVerdict; evidence?: string[]; at: number }
}

/** Why the gate refused an advisory — recorded for `why`, never silent. */
export interface GateDrop {
	at: number
	detector: string
	headline: string
	reason:
		| "no_evidence_cited"
		| "muted"
		| "suppressed"
		| "duplicate"
		| "below_floor"
		| "rate_limited"
		| "cooldown"
		| "stale"
		| "expired_ttl"
		| "expired_queue"
		| "budget_exhausted"
}

/** One pass's per-detector verdict line (the turn-end report / `run` output). */
export interface PassVerdict {
	detector: string
	verdict: DetectorFeedback["verdict"] | "timeout" | "error" | "skipped"
	note?: string
}

export interface PassResult {
	pass: number
	at: number
	trigger: "volume" | "clock" | "salience" | "turn_end" | "manual"
	verdicts: PassVerdict[]
	tokens: { prompt: number; completion: number }
	costUsd: number
	durationMs: number
}

/** An effective detector definition: the mode's carry + the catalogue's carry, merged. */
export interface DetectorDef {
	/** Unqualified slug — also the mode slug under the plugin namespace. */
	slug: string
	enabled: boolean
	/** The detector's own system prompt (mode roleDefinition [+ customInstructions]). */
	system: string
	/** Expanded tool-name grant from the mode (plugin-catalog names). */
	tools: string[]
	/** Exact-string command allowlist (catalogue-only; requires the execute grant). */
	exec: string[]
	/** Run on every pass, or every nth. */
	cadenceNth: number
	confidenceFloor: number
	deadlineS: number
	pilot: boolean
	/** Structurally triggered (the worker computes the match; the model only writes). */
	structural: boolean
	/** Per-mode provider profile (mode.provider), overriding the plugin profileRef. */
	provider?: string
	/** Detector-specific config (e.g. the standard-questions checklist). */
	config?: Record<string, unknown>
}

/** The task ledger — durable, task-scoped judgment. Derived state; always safe to delete. */
export interface TaskLedger {
	version: 1
	taskId: string
	updatedAt: number
	/** One-line goal, from the task's initial prompt. */
	goal?: string
	/** Neutral compaction output — what left the window, distilled. */
	notes: string[]
	/** Delivered advisories with their adjudicated outcomes. */
	advisories: Advisory[]
	/** Gate refusals, newest last, capped. */
	drops: GateDrop[]
	/** dedup keys suppressed for this task (rejected/contradicted advice). */
	suppressed: string[]
	/** Finish-gate firings (budget accounting). */
	finishGateFirings: number[]
	/** Observer token spend for this task. */
	tokens: { prompt: number; completion: number }
	costUsd: number
	passes: number
}

/** The status snapshot the badge / panel / skills read (written through every pass). */
export interface StatusSnapshot {
	version: 1
	updatedAt: number
	muted: boolean
	consent: boolean
	tasks: {
		taskId: string
		passes: number
		windowChars: number
		spoolChars: number
		advisoriesDelivered: number
		lastPassAt?: number
		lastVerdicts?: PassVerdict[]
		costUsd: number
	}[]
}

// ─── Tunables not worth a Settings entry (named, never inline) ────────────────────

/** Hard cancel this many seconds after the soft fork deadline. */
export const FORK_GRACE_S = 8
/** Max provider round-trips per fork before the feedback call is forced. */
export const MAX_FORK_ITERATIONS = 6
/** Max forks in flight at once; the rest queue behind the first wave. */
export const MAX_PARALLEL_FORKS = 6
/** Consecutive timeouts before a detector is rate-limited to every k-th pass. */
export const DEMOTE_AFTER_TIMEOUTS = 2
/** The k of the demotion stride. */
export const DEMOTE_STRIDE = 3
/** Consecutive timeouts (while demoted) before a detector is disabled for the task. */
export const DISABLE_AFTER_TIMEOUTS = 4
/** A disabled detector is retried once after this many seconds. */
export const DEMOTE_RETRY_S = 1800
/** Salient events (errors, user prompts) may fire an early pass this often per hour. */
export const SALIENCE_PER_HOUR = 6
/** Window budget in characters; compaction trigger and floor as fractions of it. */
export const WINDOW_BUDGET_CHARS = 400_000
export const COMPACTION_THRESHOLD = 0.85
export const COMPACTION_FLOOR = 0.6
/** Ledger GC. */
export const LEDGER_TTL_DAYS = 7
export const LEDGER_MAX_NOTES = 60
export const LEDGER_MAX_DROPS = 40
/** Advisory shape caps (enforced at the gate; also stated to the fork). */
export const BODY_CAP = 700
export const HEADLINE_CAP = 160
/** Gate agent-floor default when a detector states none. */
export const GATE_CONFIDENCE_FLOOR = 0.6
/** Finish gate. */
export const FINISH_GATE_CONFIDENCE_FLOOR = 0.75
export const FINISH_GATE_PER_TASK_CAP = 3
/** Adjudication window: an outcome record self-closes as no_evidence after either. */
export const ADJUDICATION_WINDOW_OBSERVATIONS = 60
export const ADJUDICATION_WINDOW_S = 1800
/** Episode coalescing cap — beyond it the least salient middles are dropped. */
export const EPISODE_CAP_CHARS = 60_000
/** Cap on a single fork tool result fed back to the model. */
export const MAX_TOOL_OUTPUT_CHARS = 4_000
/** Max output tokens requested per fork call (advisory-sized answers). */
export const MAX_OUTPUT_TOKENS = 1024
/** The service tick driving due-pass checks. */
export const TICK_MS = 2_000
/** How often the status snapshot is rewritten outside passes. */
export const STATUS_INTERVAL_MS = 30_000

// ─── Projection caps (chars) ──────────────────────────────────────────────────────

export const PROJ = {
	command: 400,
	heredocHead: 120,
	editNew: 200,
	editOld: 100,
	writeHead: 200,
	subtaskPrompt: 400,
	defaultCap: 400,
	errorHead: 400,
	text: 4_000,
	userPrompt: 4_000,
	subtaskFinal: 1_500,
	harvestMax: 10,
} as const

/** The plugin's namespace prefix on its contributed mode slugs. */
export const MODE_NAMESPACE = "second-brain:"

/** The feedback tool every fork must end with. */
export const FEEDBACK_TOOL_NAME = "second_brain_detector_feedback"
