import os from "os"

import type { ShoferSettings } from "@shofer/types"
import { loadLayeredOverlay, resolveScopeRoots, type LayeredSettings, type ScopeRoots } from "@shofer/core/cli"

/**
 * approval-posture — resolve a CLI/served node's **tool-approval posture** from
 * its own layered `.shofer/` configuration, falling back to the host's built-in
 * seed.
 *
 * ## Why this module exists
 *
 * A headless host has no local user to ask, so it must decide up front which tools
 * auto-approve. Historically it decided that with two hardcoded settings blobs —
 * non-interactive seeded `autoApprovalEnabled: true` plus every `alwaysAllow*` and
 * `allowedCommands: ["*"]`; interactive seeded them off — and it consulted nothing
 * else. But those are exactly the `globalSettings` keys the layered
 * `.shofer/settings.json` scopes already carry, which an operator (or a platform
 * materialising a config bundle into a scope) can set. The result was an
 * auto-approval dial that was not connected: whatever the node's configuration
 * said, a served node approved everything or nothing.
 *
 * ## The precedence, and why it is expressed as omission
 *
 * **Configuration wins; the blob is only a default seed.** That is implemented by
 * *not sending* a posture key the config layers already supply, rather than by
 * merging the config over the seed, and the difference is load-bearing:
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
 * A key **no** scope supplies is still seeded exactly as before, so a node whose
 * configuration says nothing behaves byte-for-byte as it did: plain `shofer serve`
 * auto-approves everything, `--interactive` surfaces everything. Deployed workers
 * depend on that, so it is asserted by tests rather than assumed.
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
 * gate, every per-group `alwaysAllow*` toggle the headless seed sets, and the
 * command allow/deny lists that qualify `alwaysAllowExecute`.
 *
 * This is the exact set the host may seed AND the exact set config may take over.
 * Keeping one list means a key can never be seeded-but-not-overridable (the
 * original defect) or overridable-but-never-seeded (a silent behaviour change on
 * nodes with no config).
 */
export const APPROVAL_POSTURE_KEYS = [
	"autoApprovalEnabled",
	"alwaysAllowReadOnly",
	"alwaysAllowReadOnlyOutsideWorkspace",
	"alwaysAllowWrite",
	"alwaysAllowWriteOutsideWorkspace",
	"alwaysAllowWriteProtected",
	"alwaysAllowMcp",
	"alwaysAllowModeSwitch",
	"alwaysAllowSubtasks",
	"alwaysAllowExecute",
	"allowedCommands",
	"deniedCommands",
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
 * Non-interactive means "no local user exists to ask", so everything
 * auto-approves; `--interactive` means "a controller will broker approvals to a
 * human", so the master gate is off and each dangerous tool raises an `ask`. Only
 * the master gate is seeded in the interactive case — the per-group toggles are
 * inert while `autoApprovalEnabled` is false, and seeding them would needlessly
 * overwrite the operator's file for keys the flag does not actually decide.
 */
export function defaultApprovalSeed(nonInteractive: boolean): Partial<ShoferSettings> {
	if (!nonInteractive) {
		return { autoApprovalEnabled: false }
	}

	return {
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: true,
		alwaysAllowWrite: true,
		alwaysAllowWriteOutsideWorkspace: true,
		alwaysAllowWriteProtected: true,
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
	nonInteractive: boolean,
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
		summary: describeApprovalPosture(effective, configuredKeys, nonInteractive),
	}
}

/**
 * Render the one-line startup summary.
 *
 * Requirement: where configuration and the launch flag disagree, configuration
 * wins and the node **says so once**. A node whose posture came from a file must
 * never look, from its logs, like a node running the flag's default — that is how
 * a silently un-gated (or silently stalled) pipeline goes unnoticed.
 */
export function describeApprovalPosture(
	effective: Partial<ShoferSettings>,
	configuredKeys: readonly ApprovalPostureKey[],
	nonInteractive: boolean,
): string {
	if (configuredKeys.length === 0) {
		return nonInteractive ? "auto-approve (default)" : "interactive, brokered to controller (default)"
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
 * Fails **open to the seed**, deliberately: an unreadable scope root must not
 * silently change a deployed worker's posture. A config that cannot be read is
 * indistinguishable from a config that says nothing, and the seed is what a node
 * saying nothing has always run with.
 */
export async function resolveApprovalPosture(options: {
	nonInteractive: boolean
	roots: ScopeRoots
	/** Overrides the built-in seed (tests; hosts with a bespoke default). */
	seed?: Partial<ShoferSettings>
}): Promise<ApprovalPosture> {
	const seed = options.seed ?? defaultApprovalSeed(options.nonInteractive)

	let overlay: LayeredSettings = {}
	try {
		overlay = await loadLayeredOverlay(options.roots)
	} catch {
		overlay = {}
	}

	return applyConfiguredApprovalPosture(seed, overlay, options.nonInteractive)
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
