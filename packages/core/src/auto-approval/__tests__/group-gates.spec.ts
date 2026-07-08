import { describe, it, expect } from "vitest"

import { toolGroups } from "@shofer/types"
import { GROUP_GATE, isGroupAutoApproved } from "../group-gates.js"

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

	describe("outside-workspace path allowlist fallback", () => {
		const writeOn = { alwaysAllowWrite: true } as any
		const readOn = { alwaysAllowReadOnly: true } as any
		const ctx = (absolutePath?: string) => ({ isOutsideWorkspace: true, absolutePath })

		it("approves an outside write when the path is under allowedWritePaths (blanket toggle off)", () => {
			const state = { alwaysAllowWrite: true, allowedWritePaths: ["/data/out"] } as any
			expect(isGroupAutoApproved("write", state, ctx("/data/out/sub/f.ts"), { applyModifiers: true })).toBe(true)
			expect(isGroupAutoApproved("write", state, ctx("/data/other/f.ts"), { applyModifiers: true })).toBe(false)
		})

		it("read is satisfied by allowedReadPaths OR allowedWritePaths (write ⊇ read)", () => {
			expect(
				isGroupAutoApproved(
					"read",
					{ alwaysAllowReadOnly: true, allowedReadPaths: ["/ref"] } as any,
					ctx("/ref/a.md"),
					{ applyModifiers: true },
				),
			).toBe(true)
			// A write grant also covers reads there.
			expect(
				isGroupAutoApproved(
					"read",
					{ alwaysAllowReadOnly: true, allowedWritePaths: ["/ref"] } as any,
					ctx("/ref/a.md"),
					{ applyModifiers: true },
				),
			).toBe(true)
		})

		it("a read grant does NOT authorize a write (no superset in reverse)", () => {
			const state = { alwaysAllowWrite: true, allowedReadPaths: ["/ref"] } as any
			expect(isGroupAutoApproved("write", state, ctx("/ref/a.ts"), { applyModifiers: true })).toBe(false)
		})

		it("falls through to not-approved when absolutePath is missing", () => {
			expect(
				isGroupAutoApproved(
					"write",
					{ alwaysAllowWrite: true, allowedWritePaths: ["/data"] } as any,
					ctx(undefined),
					{
						applyModifiers: true,
					},
				),
			).toBe(false)
		})

		it("does not bypass the protected-file gate", () => {
			// Path is trusted for write, but the file is protected and the protected toggle is off → still not approved.
			const state = { alwaysAllowWrite: true, allowedWritePaths: ["/data"] } as any
			expect(
				isGroupAutoApproved(
					"write",
					state,
					{ isOutsideWorkspace: true, absolutePath: "/data/f", isProtected: true },
					{
						applyModifiers: true,
					},
				),
			).toBe(false)
		})

		it("is not consulted when the blanket outside toggle is on (already approved) or on the MCP path", () => {
			// Blanket on → approved regardless of paths.
			expect(
				isGroupAutoApproved(
					"write",
					{ alwaysAllowWrite: true, alwaysAllowWriteOutsideWorkspace: true } as any,
					ctx("/anywhere/f"),
					{ applyModifiers: true },
				),
			).toBe(true)
			// MCP path ignores outside-workspace modifiers entirely.
			expect(isGroupAutoApproved("write", writeOn, ctx("/anywhere/f"), { applyModifiers: false })).toBe(true)
			void readOn
		})
	})
})
