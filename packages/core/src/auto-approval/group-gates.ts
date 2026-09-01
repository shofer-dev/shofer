import type { BuiltinToolGroup, ExtensionState } from "@shofer/types"

import { isPathAutoApproved } from "./paths.js"

/**
 * Unified per-group auto-approval gating (v3 architecture §4).
 *
 * "Which toggle must be on for a tool's group to be auto-approved" is declared
 * HERE and nowhere else, for both the MCP path and the native path — a second
 * declaration at either call site is how the two drift.
 *
 * `GROUP_GATE` is now the single source of truth for the BUILTIN groups: each maps
 * to its base toggle plus the modifier toggles that apply. Both the native-tool
 * path and the MCP path evaluate it through `isGroupAutoApproved`, so the gating
 * rule for a group is declared once.
 *
 * A DYNAMIC category has no entry — it could not have one, since the table is
 * keyed by a closed type and the categories are minted at runtime. Its gate is an
 * entry in the `alwaysAllowGroups` record, evaluated by the same function, which
 * is what keeps "which toggle decides this group" a single question with a single
 * answer whichever kind of category it is.
 */

// Auto-approval category toggles ("always allow X") — one flat key per BUILTIN
// group. A dynamic category has no flat key and could not have one (see
// `alwaysAllowGroups` in `globalSettingsSchema`); it is gated by an entry in that
// record instead.
export type AutoApprovalState =
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowMcp"
	| "alwaysAllowUncategorized"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "alwaysAllowFollowupQuestions"

// Additional settings associated with some of the toggles above.
export type AutoApprovalStateOptions =
	| "autoApprovalEnabled"
	| "alwaysAllowReadOnlyOutsideWorkspace" // For `alwaysAllowReadOnly`.
	| "alwaysAllowWriteOutsideWorkspace" // For `alwaysAllowWrite`.
	| "alwaysAllowWriteProtected"
	| "followupAutoApproveTimeoutMs" // For `alwaysAllowFollowupQuestions`.
	| "mcpServers" // For `alwaysAllowMcp`.
	| "allowedCommands" // For `alwaysAllowExecute`.
	| "deniedCommands"
	| "allowedReadPaths" // Outside-workspace path allowlist (read + write superset).
	| "allowedWritePaths" // Outside-workspace path allowlist (read+write).
	| "alwaysAllowGroups" // Per-dynamic-category toggles (plus the "*" wildcard).

type AutoApprovalSettings = Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>

interface GroupGate {
	/** The toggle that must be `true` for this group, or `null` when the group has no dedicated gate (e.g. `mcp`, gated by the `alwaysAllowMcp` master toggle alone). */
	base: AutoApprovalState | null
	/** Toggle additionally required when the resource is outside the workspace. */
	outsideToggle?: AutoApprovalStateOptions
	/** Toggle additionally required when the resource is a protected file. */
	protectedToggle?: AutoApprovalStateOptions
}

/**
 * Single source of truth: per-group base toggle + applicable modifier toggles.
 * The modifier toggles are only consulted on the native-tool path (see
 * `applyModifiers`), matching the historical behavior where MCP-served tools were
 * not subject to the outside-workspace / protected-file checks.
 */
export const GROUP_GATE: Record<BuiltinToolGroup, GroupGate> = {
	read: { base: "alwaysAllowReadOnly", outsideToggle: "alwaysAllowReadOnlyOutsideWorkspace" },
	write: {
		base: "alwaysAllowWrite",
		outsideToggle: "alwaysAllowWriteOutsideWorkspace",
		protectedToggle: "alwaysAllowWriteProtected",
	},
	execute: { base: "alwaysAllowExecute" },
	mode: { base: "alwaysAllowModeSwitch" },
	subtasks: { base: "alwaysAllowSubtasks" },
	questions: { base: "alwaysAllowFollowupQuestions" },
	uncategorized: { base: "alwaysAllowUncategorized" },
	mcp: { base: null },
}

export interface GroupGateContext {
	isOutsideWorkspace?: boolean
	isProtected?: boolean
	/** Resolved absolute path of the resource — matched against the outside-workspace path allowlist. */
	absolutePath?: string
}

/** Whether `group` is a builtin — i.e. whether the static table decides it. */
export function hasBuiltinGroupGate(group: string): boolean {
	return group in GROUP_GATE
}

/**
 * The gate for a DYNAMIC category: one entry in the `alwaysAllowGroups` record.
 *
 * Deny-by-exception, the same shape as `allowedCommands`/`deniedCommands`: an
 * explicit `true` approves, `"*"` approves every category nobody has spoken about
 * (which is what the unattended headless seed grants), and an explicit `false`
 * beats the wildcard. ABSENT is not a decision and never approves — identical
 * fail-closed posture to the old drop-to-`uncategorized`.
 */
function isDynamicGroupAutoApproved(group: string, allowGroups: Record<string, boolean> | undefined): boolean {
	if (allowGroups?.[group] === true) return true
	return allowGroups?.[group] === undefined && allowGroups?.["*"] === true
}

/**
 * Whether a tool's group permits auto-approval under the current settings.
 *
 * A builtin group is decided by {@link GROUP_GATE}; anything else is a dynamic
 * category decided by `alwaysAllowGroups`. A builtin NAME appearing inside that
 * record is ignored, so each category has exactly one source of truth for its
 * toggle.
 *
 * @param applyModifiers when true (native-tool path), also enforce the
 *   outside-workspace / protected-file modifier toggles; when false (MCP path),
 *   only the base toggle is consulted. It is a no-op for a dynamic category —
 *   those modifiers are `read`/`write`-specific and `isPathAutoApproved` refuses
 *   every other group. The caller is responsible for the master gate
 *   (`alwaysAllowMcp` for MCP; `autoApprovalEnabled` for everything).
 */
export function isGroupAutoApproved(
	group: string,
	state: AutoApprovalSettings,
	ctx: GroupGateContext,
	{ applyModifiers }: { applyModifiers: boolean },
): boolean {
	const gate = (GROUP_GATE as Record<string, GroupGate | undefined>)[group]
	if (!gate) return isDynamicGroupAutoApproved(group, state.alwaysAllowGroups)
	// Group with no dedicated toggle (e.g. `mcp`): the master gate already
	// approved it.
	if (gate.base === null) return true
	if (state[gate.base] !== true) return false
	if (applyModifiers) {
		if (ctx.isOutsideWorkspace && gate.outsideToggle && state[gate.outsideToggle] !== true) {
			// Blanket outside-workspace toggle off — fall back to the per-path allowlist before denying.
			if (group !== "read" && group !== "write") return false
			if (!ctx.absolutePath) return false
			if (
				!isPathAutoApproved(
					ctx.absolutePath,
					group,
					state.allowedReadPaths ?? [],
					state.allowedWritePaths ?? [],
				)
			)
				return false
		}
		if (ctx.isProtected && gate.protectedToggle && state[gate.protectedToggle] !== true) return false
	}
	return true
}
