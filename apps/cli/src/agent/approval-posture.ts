import os from "os"

import type { ShoferSettings } from "@shofer/types"
import { loadLayeredOverlay, resolveScopeRoots, type LayeredSettings, type ScopeRoots } from "@shofer/core/cli"

/**
 * approval-posture — resolve a CLI/served node's **tool-approval posture** from
 * its own layered `.shofer/` configuration.
 *
 * ## Why this module exists
 *
 * A headless host has no local user standing at the keyboard, so it must decide up
 * front which tools auto-approve. Historically it decided that with two hardcoded
 * settings blobs — non-interactive seeded `autoApprovalEnabled: true` plus every
 * `alwaysAllow*` and `allowedCommands: ["*"]`; interactive seeded them off — and it
 * consulted nothing else. But those are exactly the `globalSettings` keys the
 * layered `.shofer/settings.json` scopes already carry, which an operator (or a
 * platform materialising a config bundle into a scope) can set. The result was an
 * auto-approval dial that was not connected: whatever the node's configuration
 * said, a served node approved everything or nothing.
 *
 * ## Doctrine: an absent key DENIES
 *
 * A posture key is auto-approving only when a `.shofer/` scope — the operator's
 * own file, or one a platform materialised from a config bundle — **says so
 * explicitly**. Silence means ASK: the tool call raises its approval and parks
 * until whoever is entitled to decide it does.
 *
 * The old rule was the inverse — silence seeded auto-approve — and it was wrong
 * for one reason that outweighs the convenience: **an absent key is not a
 * decision.** It is indistinguishable from a `settings` section nobody wrote, a
 * bundle published before the posture was thought about, or a key misspelled. All
 * three shipped an agent that auto-approved every declared capability — writes,
 * shell commands with `allowedCommands: ["*"]`, a browser that clicks and submits
 * inside whatever session its profile carries — and nothing anywhere reported it,
 * because the seed made the omission look exactly like a considered choice. Under
 * the current rule the same omission stalls the run instead, which is visible, and
 * the fix is to state the posture the agent was always meant to have.
 *
 * The consequence is real and accepted: a headless node whose configuration says
 * nothing does nothing dangerous, and does not run very far either. That is the
 * safe direction to fail in, and the failure announces itself.
 *
 * ## What the host still seeds, and why it is exactly one key
 *
 * {@link defaultApprovalSeed} sets the master gate to its denying value and
 * nothing else. It is not merely restating the default: `globalState` persists
 * across restarts of a node with a state directory, so a `autoApprovalEnabled:
 * true` written there by an earlier session (or an earlier build) would otherwise
 * survive into a run whose config says nothing. Re-asserting `false` each boot
 * closes that. The per-group toggles need no such treatment — the master gate
 * being off refuses every group regardless of what any of them hold.
 *
 * ## The precedence, and why it is expressed as omission
 *
 * **Configuration wins; the seed is only a default.** That is implemented by *not
 * sending* a posture key the config layers already supply, rather than by merging
 * the config over the seed, and the difference is load-bearing:
 *
 *   - `ContextProxy.getValue` serves the layered overlay ahead of `globalState`,
 *     so a key present in any scope wins **whatever** the host seeds. Sending a
 *     seed value for such a key would be shadowed on read — a write that silently
 *     does nothing.
 *   - Worse, it would not be inert. The host delivers its seed as an
 *     `updateSettings` message, which lands in `ContextProxy.setValue`, which
 *     **writes through to the user scope's `~/.shofer/settings.json`**. Seeding a
 *     configured key therefore *overwrites the operator's own file* with the
 *     host's default. Omission is the only way the seed stays a default.
 *
 * ## Scope precedence is the platform's, not ours
 *
 * Which scope wins among the three is `mergeLayeredConfig`'s business — unlocked
 * keys resolve project > user > global, and a key the global scope names in
 * `locked.json` inverts that so the global value is final. An operator whose
 * policy must not be overridable locks it; this module never second-guesses that
 * ordering, it only reads the effective result.
 */

/**
 * The settings keys that constitute a node's tool-approval posture: the master
 * gate, every per-group `alwaysAllow*` toggle, and the command allow/deny lists
 * that qualify `alwaysAllowExecute`.
 *
 * This is the exact set config may take over, and — since {@link
 * defaultApprovalSeed} sets only the master gate — very nearly the exact set that
 * does nothing at all unless a scope names it.
 *
 * The list is also what the startup banner counts, which is why it must stay
 * complete rather than shrink to the keys the host touches: a key omitted from it
 * is honoured on read (`ContextProxy` serves the overlay ahead of `globalState`)
 * but reported as though the node were running the built-in default, which is
 * precisely the misreading the summary exists to prevent.
 */
export const APPROVAL_POSTURE_KEYS = [
	"autoApprovalEnabled",
	"alwaysAllowReadOnly",
	"alwaysAllowReadOnlyOutsideWorkspace",
	"alwaysAllowWrite",
	"alwaysAllowWriteOutsideWorkspace",
	"alwaysAllowWriteProtected",
	"alwaysAllowBrowser",
	"alwaysAllowMcp",
	"alwaysAllowModeSwitch",
	"alwaysAllowSubtasks",
	"alwaysAllowExecute",
	"allowedCommands",
	"deniedCommands",
	"alwaysAllowUncategorized",
	"alwaysAllowFollowupQuestions",
] as const satisfies readonly (keyof ShoferSettings)[]

/** A settings key that participates in the approval posture. */
export type ApprovalPostureKey = (typeof APPROVAL_POSTURE_KEYS)[number]

/** The posture a node ends up running with, and where each part of it came from. */
export interface ApprovalPosture {
	/**
	 * The seed the host should actually send — the built-in default minus every
	 * key the config layers supply. Sending only these keeps configuration
	 * authoritative and leaves the operator's scope files untouched.
	 */
	seed: Partial<ShoferSettings>
	/** Posture keys the layered config supplies (and which are therefore NOT in {@link seed}). */
	configuredKeys: ApprovalPostureKey[]
	/** The effective value of every posture key: the config's where it has one, else the seed's. */
	effective: Partial<ShoferSettings>
	/** One line for the startup banner — the effective posture and its source. */
	summary: string
}

/**
 * The host's built-in seed: what a node runs with when its configuration says
 * nothing about approvals.
 *
 * It sets the master gate to its **denying** value and nothing else, on both
 * interactive and non-interactive hosts — the launch flag no longer decides the
 * posture, only configuration does. Every other posture key is left absent,
 * because absent already denies everywhere the decision is taken:
 * `checkAutoApproval` refuses the call unless `autoApprovalEnabled` is `true`,
 * and `isGroupAutoApproved` refuses a group whose toggle is not exactly `true`.
 *
 * ## Why the master gate is stated rather than left absent too
 *
 * Absent and `false` mean the same thing to the gate, but not to the node's
 * `globalState`, which persists across restarts wherever the host has a state
 * directory. A `true` written there by an earlier session — a controller's
 * `updateSettings`, or a build that still seeded auto-approval — would otherwise
 * outlive it and un-gate a run whose configuration says nothing. Re-asserting the
 * denying value each boot closes that, and one key suffices: with the master gate
 * off, no per-group toggle can approve anything.
 *
 * ## Why nothing is seeded ON, including `browser`
 *
 * The `browser` group is worth naming because it used to be the exception. It
 * holds no native tools at all — every member arrives over MCP — so an unseeded
 * toggle parked the first browser call of a headless run, and the seed existed to
 * stop that. It is gone for the same reason the rest are: a browser that reaches a
 * live session can click, type, fill and submit, and "nobody declared a posture"
 * is not a licence to do so. A deployment that wants its headless agent to browse
 * says `alwaysAllowBrowser: true` in its own `.shofer/` scope, and then it parks
 * on nothing.
 */
export function defaultApprovalSeed(): Partial<ShoferSettings> {
	return { autoApprovalEnabled: false }
}

/**
 * The seed an **unattended local run** supplies for itself: auto-approve every
 * DECLARED capability, and every command.
 *
 * This is not a default and it is not a fallback — it is a posture a command
 * passes deliberately, and only where the person at the terminal asked for an
 * unattended run (`shofer run` without `--require-approval`, `shofer acp`, whose
 * protocol carries no permission channel at all). The grant therefore has a
 * stated author: the human who typed the command, running the agent against
 * their own workspace with their own credentials.
 *
 * That is the whole distinction from {@link defaultApprovalSeed}. A served node
 * gets no such grant, because nobody stated one: its agent acts under authority
 * somebody else lent it, its asks have a controller that can answer them, and an
 * absent key there is silence rather than a choice.
 *
 * It is still only a seed. Every key here is dropped for any key the node's
 * `.shofer/` scopes supply, so a workspace that gates `execute` gates it even on
 * an unattended run.
 *
 * ## What it does NOT grant, and why
 *
 *   - `alwaysAllowUncategorized` — `uncategorized` is not a capability, it is
 *     the absence of a declaration. Granting it auto-approves exactly the tools
 *     nobody classified, so a posture that deliberately gates `write` is still
 *     bypassed by any mutating tool whose server forgot to declare a group. A
 *     tool that parks an unattended run is fixed by CLASSIFYING it.
 *   - `alwaysAllowFollowupQuestions` — its effect is to answer a question with a
 *     suggestion after a timeout. Running unattended is a reason to surface the
 *     question, not to fabricate an answer to it.
 */
export function unattendedApprovalSeed(): Partial<ShoferSettings> {
	return {
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: true,
		alwaysAllowWrite: true,
		alwaysAllowWriteOutsideWorkspace: true,
		alwaysAllowWriteProtected: true,
		alwaysAllowBrowser: true,
		alwaysAllowMcp: true,
		alwaysAllowModeSwitch: true,
		alwaysAllowSubtasks: true,
		alwaysAllowExecute: true,
		allowedCommands: ["*"],
	}
}

/**
 * Fold a node's layered configuration into the built-in seed.
 *
 * Pure: takes the already-merged overlay, returns a fresh {@link ApprovalPosture}.
 * The disk read lives in {@link resolveApprovalPosture} so this — the part that
 * encodes the precedence rule — is directly testable without a filesystem.
 */
export function applyConfiguredApprovalPosture(
	seed: Partial<ShoferSettings>,
	overlay: LayeredSettings,
): ApprovalPosture {
	const configuredKeys: ApprovalPostureKey[] = []
	const effectiveSeed: Partial<ShoferSettings> = { ...seed }
	const effective: Partial<ShoferSettings> = { ...seed }

	for (const key of APPROVAL_POSTURE_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(overlay, key)) {
			continue
		}
		configuredKeys.push(key)
		// Omission, not override: the overlay already wins in `ContextProxy.getValue`,
		// and a seeded value would be written through into the operator's own
		// `settings.json`. See this module's header.
		delete effectiveSeed[key]
		Object.assign(effective, { [key]: overlay[key] })
	}

	return {
		seed: effectiveSeed,
		configuredKeys,
		effective,
		summary: describeApprovalPosture(effective, configuredKeys),
	}
}

/**
 * Render the one-line startup summary.
 *
 * Requirement: a node **says once** where its posture came from. Both readings it
 * prevents matter, and they are opposite failures: a node running an
 * auto-approving posture from a file must not look like one running the built-in
 * default, and a node stalling on every tool call must be attributable to the
 * default rather than hunted for in a config nobody wrote.
 *
 * The `autoApprovalEnabled=false` fact carries more weight than it looks: a
 * configuration that names `alwaysAllowReadOnly` and forgets the master gate
 * approves nothing at all, and this line is where that shows.
 */
export function describeApprovalPosture(
	effective: Partial<ShoferSettings>,
	configuredKeys: readonly ApprovalPostureKey[],
): string {
	if (configuredKeys.length === 0) {
		return "ask (default — no posture configured)"
	}

	const facts = [
		`autoApprovalEnabled=${effective.autoApprovalEnabled === true}`,
		effective.autoApprovalEnabled === true && effective.alwaysAllowExecute === true
			? "execute auto-approved"
			: "execute gated",
		`${configuredKeys.length} key${configuredKeys.length === 1 ? "" : "s"} from .shofer config`,
	]

	return `from config (${facts.join(", ")})`
}

/**
 * Resolve a node's approval posture: read the three `.shofer/` scopes, then apply
 * {@link applyConfiguredApprovalPosture} to the built-in seed.
 *
 * Falls back to the seed, which is now the SAFE direction: a config that cannot
 * be read is indistinguishable from a config that says nothing, and a node saying
 * nothing auto-approves nothing. An unreadable scope root therefore stalls a
 * worker rather than un-gating one — the failure that can be noticed, not the one
 * that cannot.
 */
export async function resolveApprovalPosture(options: {
	roots: ScopeRoots
	/** Overrides the built-in seed (tests; hosts with a bespoke default). */
	seed?: Partial<ShoferSettings>
}): Promise<ApprovalPosture> {
	const seed = options.seed ?? defaultApprovalSeed()

	let overlay: LayeredSettings = {}
	try {
		overlay = await loadLayeredOverlay(options.roots)
	} catch {
		overlay = {}
	}

	return applyConfiguredApprovalPosture(seed, overlay)
}

/**
 * Resolve the three `.shofer/` scope roots for a CLI host, from the same inputs
 * `ContextProxy` uses inside the extension: the mock extension context's
 * global-storage path, the user's home directory, and the open workspace. Both
 * must agree — a posture computed against different roots than the one the
 * extension later reads would be worse than no posture at all.
 */
export function resolveCliScopeRoots(inputs: { globalStorageFsPath?: string; workspacePath?: string }): ScopeRoots {
	return resolveScopeRoots({
		globalStorageFsPath: inputs.globalStorageFsPath,
		homeDir: os.homedir(),
		workspaceFolder: inputs.workspacePath,
	})
}
