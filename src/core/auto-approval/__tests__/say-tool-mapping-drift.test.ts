import { describe, it, expect } from "vitest"

import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS, toolNames } from "@shofer/types"
import { SAY_TOOL_TO_NATIVE_NAME, getToolGroupForSayTool } from "../tools"

/**
 * Auto-approval mapping drift guard (todos/opencode_inspired_work.md §4).
 *
 * `getToolGroupForSayTool` resolves a UI-facing camelCase tool id to its
 * snake_case native name (via `SAY_TOOL_TO_NATIVE_NAME`) and then to a
 * ToolGroup, which selects the auto-approval gate. If a native tool is renamed
 * or removed, a stale entry here resolves to "uncategorized" *silently* — the
 * tool then honors the wrong (or no) approval toggle, a security-relevant drift.
 *
 * Until tool identity is single-sourced (the §3/§4 target), this makes that
 * drift fail loudly: every mapping must point at a real native tool that is
 * classified into a group.
 */
describe("auto-approval say-tool mapping drift guard", () => {
	const knownTools = new Set<string>(toolNames)

	const groupOf = (nativeName: string): string | undefined => {
		for (const [group, cfg] of Object.entries(TOOL_GROUPS)) {
			if (
				(cfg.tools as readonly string[]).includes(nativeName) ||
				(cfg.customTools as readonly string[] | undefined)?.includes(nativeName)
			) {
				return group
			}
		}
		return undefined
	}

	it("every mapped native name is a real tool in the toolNames enum", () => {
		const unknown = Object.entries(SAY_TOOL_TO_NATIVE_NAME)
			.filter(([, native]) => !knownTools.has(native))
			.map(([say, native]) => `${say} -> ${native}`)
		expect(unknown, `stale say-tool mapping(s) (native name not in toolNames): ${unknown.join(", ")}`).toEqual([])
	})

	it("every mapped native name is grouped or always-available", () => {
		// Always-available tools (attempt_completion, update_todo_list, skills, …)
		// are intentionally ungrouped: explicit early-return branches in
		// checkAutoApproval handle them, so they never reach the group-gated path.
		// Anything else falling through to "uncategorized" is drift.
		const always = new Set<string>(ALWAYS_AVAILABLE_TOOLS)
		const ungrouped = Object.entries(SAY_TOOL_TO_NATIVE_NAME)
			.filter(([, native]) => !groupOf(native) && !always.has(native))
			.map(([say, native]) => `${say} -> ${native}`)
		expect(
			ungrouped,
			`mapped native name(s) neither grouped nor always-available (would silently auto-approve as "uncategorized"): ${ungrouped.join(", ")}`,
		).toEqual([])
	})

	it("getToolGroupForSayTool resolves every mapped tool to its declared group", () => {
		for (const [say, native] of Object.entries(SAY_TOOL_TO_NATIVE_NAME)) {
			const expected = groupOf(native) ?? "uncategorized"
			expect(getToolGroupForSayTool({ tool: say } as never), `${say} (${native})`).toBe(expected)
		}
	})
})
