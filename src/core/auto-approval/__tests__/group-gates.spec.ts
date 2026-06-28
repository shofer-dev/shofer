import { describe, it, expect } from "vitest"

import { toolGroups } from "@shofer/types"
import { GROUP_GATE, isGroupAutoApproved } from "../group-gates"

/**
 * §4 unified group-gate engine. The full decision behavior is covered by the
 * checkAutoApproval characterization suite; these tests pin the engine itself.
 */
describe("GROUP_GATE / isGroupAutoApproved", () => {
	it("declares a gate for every ToolGroup (no group can be silently ungated)", () => {
		const missing = toolGroups.filter((g) => !(g in GROUP_GATE))
		expect(missing, `ToolGroup(s) missing a GROUP_GATE entry: ${missing.join(", ")}`).toEqual([])
	})

	it("requires the base toggle for a gated group", () => {
		expect(isGroupAutoApproved("read", {} as any, {}, { applyModifiers: false })).toBe(false)
		expect(isGroupAutoApproved("read", { alwaysAllowReadOnly: true } as any, {}, { applyModifiers: false })).toBe(
			true,
		)
	})

	it("treats the no-dedicated-gate group (mcp) as approved (master gate is the caller's job)", () => {
		expect(isGroupAutoApproved("mcp", {} as any, {}, { applyModifiers: false })).toBe(true)
	})

	it("enforces outside-workspace / protected modifiers only when applyModifiers is true", () => {
		const writeOn = { alwaysAllowWrite: true } as any
		// Modifiers ignored (MCP path).
		expect(isGroupAutoApproved("write", writeOn, { isOutsideWorkspace: true }, { applyModifiers: false })).toBe(
			true,
		)
		// Modifiers enforced (native path).
		expect(isGroupAutoApproved("write", writeOn, { isOutsideWorkspace: true }, { applyModifiers: true })).toBe(
			false,
		)
		expect(
			isGroupAutoApproved(
				"write",
				{ alwaysAllowWrite: true, alwaysAllowWriteOutsideWorkspace: true } as any,
				{ isOutsideWorkspace: true },
				{ applyModifiers: true },
			),
		).toBe(true)
		expect(isGroupAutoApproved("write", writeOn, { isProtected: true }, { applyModifiers: true })).toBe(false)
	})
})
