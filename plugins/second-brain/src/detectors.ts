/**
 * detectors — the single in-code source for the built-in detector modes and their
 * catalogue defaults.
 *
 * The manifest's `contributes.modes` block mirrors {@link DETECTOR_MODES} byte-for-byte;
 * a spec (`__tests__/catalogue.spec.ts`) asserts the two match, so the declarative
 * contribution and the runtime definitions cannot drift. What a MODE carries (prompt,
 * grant, provider link) lives here; what a mode has no field for (enablement, cadence,
 * floors, deadlines, pilot flag, exec allowlists, detector config) lives in
 * {@link CATALOGUE_DEFAULTS}, overridable per workspace from
 * `.shofer/second-brain/catalogue.json` (see catalogue.ts).
 */

import type { ModeConfig } from "@shofer/types"

/** The catalogue-side defaults a mode cannot express. */
export interface CatalogueEntry {
	enabled: boolean
	cadenceNth: number
	confidenceFloor: number
	deadlineS?: number
	pilot?: boolean
	structural?: boolean
	/** Exact-string command allowlist; only honored when the mode grants execute. */
	exec?: string[]
	config?: Record<string, unknown>
}

/** Mode definitions — MUST equal plugin.json `contributes.modes` (spec-enforced). */
export const DETECTOR_MODES: ModeConfig[] = [
	{
		slug: "repeat-failure",
		name: "Second Brain: repeat-failure",
		private: true,
		whenToUse: "Second Brain detector — a session burning time on a loop it cannot see. The pilot fork.",
		roleDefinition:
			"You watch for a session burning time on a loop it cannot see.\nAdvise only when the SAME command or approach has failed three or more times with cosmetic variations, or when the agent is retrying something that already failed the same way. Cite the failing observations. Everything else is silence.",
		tools: [],
	},
	{
		slug: "standard-questions",
		name: "Second Brain: standard-questions",
		private: true,
		whenToUse: "Second Brain detector — checklist items the observation stream never answers.",
		roleDefinition:
			"You are checking whether the work has answered a fixed set of questions.\nAsk only about a question the observation stream does not already answer — if the agent ran the tests, the question is answered and you say nothing. If the task looks close to done and nothing in the stream ever answers one, that silence is the finding.\nYou cannot see tool results, only what was run, so ask whether an ACTION occurred — never whether it succeeded.\nAn explicit user instruction waiving a check ('no tests', 'skip the docs') ANSWERS that question: the user decided, and advising about work they deliberately waived is noise, not vigilance. A question the stream already answers — including by such a waiver — is settled; do not re-open it on a later pass.",
		tools: [],
	},
	{
		slug: "default",
		name: "Second Brain: default",
		private: true,
		whenToUse: "Second Brain detector — anything a competent watcher would flag.",
		roleDefinition:
			"You are watching, not participating.\nSpeak only when you have something genuinely useful: a mistake about to compound, a constraint stated earlier and now contradicted, prior art the agent should see, a decision whose cost will only become visible later.\nThe expected steady state is silence. Do not summarise, do not encourage, do not restate what the agent just said, and never advise something it has already done.",
		tools: [{ read: { allowed: ["read_file", "grep_search", "list_files", "find_files"] } }],
	},
	{
		slug: "goal-drift",
		name: "Second Brain: goal-drift",
		private: true,
		whenToUse: "Second Brain detector — the user asked for A, the work is now B.",
		roleDefinition:
			"You watch for the work drifting off the goal.\nThe user asked for A; several turns later the work is about B, with no acknowledgment that the goal changed. Advise only with both halves cited: what was asked, and what is now being done. A user who redirected mid-task is not drift.",
		tools: [],
	},
	{
		slug: "git-log",
		name: "Second Brain: git-log",
		private: true,
		whenToUse:
			"Second Brain detector — the area being edited was changed recently, and that history contradicts the work.",
		roleDefinition:
			"You check whether the area being edited was changed recently, and whether that history contradicts what is being done now.\nUse the git commands you have on the files in the observation stream. The finding worth sending is specific: 'this was rewritten two days ago in <sha>; the thing being re-added was deliberately removed'. A file simply having history is not a finding.",
		tools: [{ read: { allowed: ["read_file"] } }, { execute: { allowed: ["execute_command"] } }],
	},
	{
		slug: "prior-art",
		name: "Second Brain: prior-art",
		private: true,
		whenToUse: "Second Brain detector — what is being built already exists in this repository.",
		roleDefinition:
			"You check whether what is being built already exists in this repository.\nSearch for an existing helper, shared library or sibling implementation before the agent finishes rebuilding it. Cite the path. Silence unless you have actually found the thing.",
		tools: [{ read: { allowed: ["read_file", "grep_search", "list_files", "find_files"] } }],
		tools_allowed: ["rag_search", "git_search"],
	},
	{
		slug: "constraint-drift",
		name: "Second Brain: constraint-drift",
		private: true,
		whenToUse: "Second Brain detector — work contradicting a rule the project writes down.",
		roleDefinition:
			"You check the work against the rules this project writes down — AGENTS.md, CLAUDE.md, and constraints the user stated earlier in the task.\nQuote the rule and the observation that contradicts it. This detector is the most false-positive-prone one there is: if you are inferring a rule rather than reading one, stay silent.",
		tools: [{ read: { allowed: ["read_file", "grep_search", "list_files", "find_files"] } }],
	},
	{
		slug: "static-analysis",
		name: "Second Brain: static-analysis",
		private: true,
		whenToUse:
			"Second Brain detector — does the edited tree still build / type-check. Ships with an EMPTY command allowlist.",
		roleDefinition:
			"You determine whether the tree the agent just edited still builds and type-checks.\nRun the command you are allowed to run, once, and report only a real failure with the compiler's own first error line as evidence. A build you could not run is silence, not a finding.",
		tools: [{ execute: { allowed: ["execute_command"] } }],
	},
	{
		slug: "cross-task-collision",
		name: "Second Brain: cross-task-collision",
		private: true,
		whenToUse: "Second Brain detector — another live task is editing the same files. Structurally triggered.",
		roleDefinition:
			"Another live task is editing files this task is also editing. The collision itself is already established — you are not asked to judge whether it is real, only to write one clear line about it.\nSay which file, which other task, and which case it is: the same working directory (both agents write the same file, later writer wins silently — urgent) or separate worktrees (two branches diverging, git will report it at merge time — lower).",
		tools: [],
	},
]

/**
 * Catalogue defaults keyed by mode slug. Enablement stops where tools begin: the
 * tool-less detectors ship on, everything that reads the repo or executes ships off —
 * writing a detector's prompt is not the same as knowing it earns its slice.
 */
export const CATALOGUE_DEFAULTS: Record<string, CatalogueEntry> = {
	"repeat-failure": { enabled: true, cadenceNth: 1, confidenceFloor: 0.6, pilot: true },
	"standard-questions": {
		enabled: true,
		cadenceNth: 1,
		confidenceFloor: 0.6,
		config: {
			questions: [
				{ key: "tests_run", ask: "Were the tests run since the first edit?" },
				{ key: "tests_added", ask: "Were tests added for new code paths?" },
				{ key: "compiles", ask: "Was a build or type-check run since the edits?" },
				{ key: "deployed", ask: "If a version was bumped, was a deploy command run?" },
				{ key: "docs_updated", ask: "Was the neighbouring doc updated with the code?" },
			],
		},
	},
	default: { enabled: true, cadenceNth: 1, confidenceFloor: 0.65 },
	"goal-drift": { enabled: false, cadenceNth: 2, confidenceFloor: 0.7 },
	"git-log": {
		enabled: false,
		cadenceNth: 2,
		confidenceFloor: 0.65,
		exec: ["git log --oneline -20", "git log --oneline -20 --stat", "git status --short"],
	},
	"prior-art": { enabled: false, cadenceNth: 3, confidenceFloor: 0.7 },
	"constraint-drift": { enabled: false, cadenceNth: 3, confidenceFloor: 0.75 },
	"static-analysis": { enabled: false, cadenceNth: 4, confidenceFloor: 0.8, deadlineS: 45, exec: [] },
	"cross-task-collision": { enabled: false, cadenceNth: 1, confidenceFloor: 0.6, structural: true },
}
