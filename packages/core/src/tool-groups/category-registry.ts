/**
 * @fileoverview The dynamic tool-category registry.
 *
 * The tool-category vocabulary is OPEN. Eight builtins (`@shofer/types`'
 * `toolGroups`) carry native tools or special semantics and are reserved; every
 * other valid slug is a **dynamic category**, minted the moment something
 * declares it — an MCP server's `_meta["shofer.dev/toolGroup"]`, a `toolGroups`
 * override in `mcp.json`, a private-tool provider's `group`, a plugin's
 * custom-tool `group`, or a name typed into the MCP group dropdown.
 *
 * This module is the one place that knows which dynamic categories exist. Two
 * consumers depend on it and neither can be served by a static table:
 *
 *   - the UI, which renders one auto-approve toggle per registered category
 *     (`ExtensionState.dynamicToolGroups`), so a category must be REGISTERED AT
 *     DISCOVERY rather than at first approval — a toggle that only appears after
 *     a call was already attempted is a broken affordance;
 *   - `getToolGroupForSayTool`, which resolves the group of a tool on the
 *     approval path. That is why the registry also records the declared
 *     tool-name → group MAPPING: without it, `filterPrivateToolsForMode` would
 *     read a private tool's DECLARED group for visibility while approval inferred
 *     one from the name prefix, so a `salesforce` tool would be visible as
 *     salesforce yet gated as `uncategorized` — its toggle on, and the tool still
 *     asking (the Tool-Group Dual-Resolution Rule, one layer down).
 *
 * Registration is fail-closed and never grants anything: a registered category's
 * toggle defaults to ABSENT, which means ask. What registration buys is that the
 * category stops lying about its name (unknown strings used to be silently
 * dropped to `uncategorized`) and that a toggle exists to turn on.
 *
 * Lifetime is the SESSION. There is deliberately no deregistration: a stale name
 * is an inert map entry in `alwaysAllowGroups`, not an error, and a server that
 * disconnects mid-run has not stopped being the reason a toggle is meaningful.
 */

import { toolGroupNameSchema, toolGroups } from "@shofer/types"

import { toolsLog } from "../logging/subsystems.js"

/** The reserved builtin vocabulary — never a dynamic category. */
const BUILTIN_GROUPS: ReadonlySet<string> = new Set<string>(toolGroups)

/**
 * The `alwaysAllowGroups` wildcard. Not a category and never registrable — it is
 * also not a valid slug, so the name check alone would refuse it; the explicit
 * guard states the intent rather than relying on that coincidence.
 */
export const TOOL_GROUP_WILDCARD = "*"

export class ToolGroupRegistry {
	private readonly dynamic = new Set<string>()
	private readonly groupByTool = new Map<string, string>()
	private readonly listeners = new Set<() => void>()

	/**
	 * Record `name` as a dynamic category.
	 *
	 * @returns `true` only when this call ADDED a category — a new, valid,
	 *   non-builtin slug. Every other outcome is a no-op returning `false`: an
	 *   invalid name, the reserved wildcard, a builtin (which needs no registry
	 *   entry — its toggle is a flat settings key), and a name already known.
	 */
	register(name: string): boolean {
		if (name === TOOL_GROUP_WILDCARD) {
			return false
		}

		if (!toolGroupNameSchema.safeParse(name).success) {
			return false
		}

		if (BUILTIN_GROUPS.has(name) || this.dynamic.has(name)) {
			return false
		}

		this.dynamic.add(name)
		this.emitChange()
		return true
	}

	/**
	 * Record that `toolName` was DECLARED to belong to `group`, and register the
	 * group.
	 *
	 * Builtin groups are recorded here too: the mapping's job is to let the
	 * approval path resolve a declared group instead of guessing from a prefix,
	 * and a private tool declaring `read` needs that just as much as one declaring
	 * `salesforce`. A malformed group name records nothing — an undeclared tool
	 * belongs in `uncategorized`, which is where the caller's fallback puts it.
	 */
	registerToolMapping(toolName: string, group: string): void {
		if (toolName.length === 0 || !toolGroupNameSchema.safeParse(group).success) {
			return
		}

		this.groupByTool.set(toolName, group)
		this.register(group)
	}

	/** The group `toolName` declared, or `undefined` when nothing declared one. */
	groupForTool(toolName: string): string | undefined {
		return this.groupByTool.get(toolName)
	}

	/** Every registered dynamic category, sorted so the snapshot is stable. */
	getDynamicGroups(): string[] {
		return Array.from(this.dynamic).sort()
	}

	/**
	 * Subscribe to category additions (the UI refreshes its toggle list on this).
	 *
	 * @returns a dispose function; calling it twice is harmless.
	 */
	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	/**
	 * Drop every registration. Tests only — the registry is a process-lifetime
	 * singleton and nothing in the product clears it.
	 */
	reset(): void {
		this.dynamic.clear()
		this.groupByTool.clear()
	}

	private emitChange(): void {
		// A listener that throws must not abort the registration that notified it:
		// the category is already recorded, and losing the rest of the fan-out would
		// leave the UI and the registry disagreeing about what exists.
		for (const listener of Array.from(this.listeners)) {
			try {
				listener()
			} catch (error) {
				toolsLog.error("tool-group registry listener failed", error)
			}
		}
	}
}

/** Singleton Re-export Rule: the registry has no per-instance configuration. */
export const toolGroupRegistry = new ToolGroupRegistry()

/** Convenience delegate — see {@link ToolGroupRegistry.register}. */
export function registerToolGroup(name: string): boolean {
	return toolGroupRegistry.register(name)
}

/** Convenience delegate — see {@link ToolGroupRegistry.getDynamicGroups}. */
export function getDynamicToolGroups(): string[] {
	return toolGroupRegistry.getDynamicGroups()
}
