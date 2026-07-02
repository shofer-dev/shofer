import type { ExtensionState, ToolGroup } from "@shofer/types"

/**
 * Unified per-group auto-approval gating (v3 architecture §4).
 *
 * Before this module, "which toggle must be on for a tool's group to be
 * auto-approved" was declared in TWO places that could drift:
 *   - `MCP_GROUP_APPROVAL_GATE` (for MCP-served tools), and
 *   - inline `if (browser) … / if (isReadOnly) … / if (isWrite) …` branches in
 *     `checkAutoApproval` (for native tools), which additionally apply the
 *     outside-workspace / protected-file modifiers.
 *
 * `GROUP_GATE` is now the single source of truth: each tool group maps to its
 * base toggle plus the modifier toggles that apply. Both the native-tool path
 * and the MCP path evaluate it through `isGroupAutoApproved`, so the gating rule
 * for a group is declared once.
 */

// Auto-approval category toggles ("always allow X").
export type AutoApprovalState =
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowBrowser"
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
export const GROUP_GATE: Record<ToolGroup, GroupGate> = {
	read: { base: "alwaysAllowReadOnly", outsideToggle: "alwaysAllowReadOnlyOutsideWorkspace" },
	write: {
		base: "alwaysAllowWrite",
		outsideToggle: "alwaysAllowWriteOutsideWorkspace",
		protectedToggle: "alwaysAllowWriteProtected",
	},
	execute: { base: "alwaysAllowExecute" },
	browser: { base: "alwaysAllowBrowser" },
	mode: { base: "alwaysAllowModeSwitch" },
	subtasks: { base: "alwaysAllowSubtasks" },
	questions: { base: "alwaysAllowFollowupQuestions" },
	uncategorized: { base: "alwaysAllowUncategorized" },
	mcp: { base: null },
}

export interface GroupGateContext {
	isOutsideWorkspace?: boolean
	isProtected?: boolean
}

/**
 * Whether a tool's group permits auto-approval under the current settings.
 *
 * @param applyModifiers when true (native-tool path), also enforce the
 *   outside-workspace / protected-file modifier toggles; when false (MCP path),
 *   only the base toggle is consulted. The caller is responsible for the master
 *   gate (`alwaysAllowMcp` for MCP; `autoApprovalEnabled` for everything).
 */
export function isGroupAutoApproved(
	group: ToolGroup,
	state: AutoApprovalSettings,
	ctx: GroupGateContext,
	{ applyModifiers }: { applyModifiers: boolean },
): boolean {
	const gate = GROUP_GATE[group]
	// Group with no dedicated toggle (e.g. `mcp`): the master gate already
	// approved it.
	if (gate.base === null) return true
	if (state[gate.base] !== true) return false
	if (applyModifiers) {
		if (ctx.isOutsideWorkspace && gate.outsideToggle && state[gate.outsideToggle] !== true) return false
		if (ctx.isProtected && gate.protectedToggle && state[gate.protectedToggle] !== true) return false
	}
	return true
}
