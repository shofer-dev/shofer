// npx vitest run src/core/tools/__tests__/validateToolUse.spec.ts

import { describe, it, expect } from "vitest"
import type { ModeConfig } from "@roo-code/types"

import { modes } from "../../../shared/modes"
import { TOOL_GROUPS } from "../../../shared/tools"

import { validateToolUse, isToolAllowedForMode } from "../validateToolUse"

const codeMode = modes.find((m) => m.slug === "code")?.slug || "code"
const architectMode = modes.find((m) => m.slug === "architect")?.slug || "architect"
const askMode = modes.find((m) => m.slug === "ask")?.slug || "ask"

describe("mode-validator", () => {
	describe("isToolAllowedForMode", () => {
		describe("code mode", () => {
			it("allows all code mode tools", () => {
				// Code mode has all groups
				Object.entries(TOOL_GROUPS).forEach(([_, config]) => {
					config.tools.forEach((tool: string) => {
						expect(isToolAllowedForMode(tool, codeMode, [])).toBe(true)
					})
				})
			})

			it("disallows unknown tools", () => {
				expect(isToolAllowedForMode("unknown_tool" as any, codeMode, [])).toBe(false)
			})
		})

		describe("architect mode", () => {
			it("allows configured tools", () => {
				// Architect mode has read and mcp groups
				const architectTools = [...TOOL_GROUPS.read.tools, ...TOOL_GROUPS.mcp.tools]
				architectTools.forEach((tool) => {
					expect(isToolAllowedForMode(tool, architectMode, [])).toBe(true)
				})
			})
		})

		describe("ask mode", () => {
			it("allows configured tools", () => {
				// Ask mode has read and mcp groups
				const askTools = [...TOOL_GROUPS.read.tools, ...TOOL_GROUPS.mcp.tools]
				askTools.forEach((tool) => {
					expect(isToolAllowedForMode(tool, askMode, [])).toBe(true)
				})
			})
		})

		describe("custom modes", () => {
			it("allows tools from custom mode configuration", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "custom-mode",
						name: "Custom Mode",
						roleDefinition: "Custom role",
						groups: ["read", "edit"] as const,
					},
				]
				// Should allow tools from read and edit groups
				expect(isToolAllowedForMode("read_file", "custom-mode", customModes)).toBe(true)
				expect(isToolAllowedForMode("write_to_file", "custom-mode", customModes)).toBe(true)
				// Should not allow tools from other groups
				expect(isToolAllowedForMode("execute_command", "custom-mode", customModes)).toBe(false)
			})

			it("allows custom mode to override built-in mode", () => {
				const customModes: ModeConfig[] = [
					{
						slug: codeMode,
						name: "Custom Code Mode",
						roleDefinition: "Custom role",
						groups: ["read"] as const,
					},
				]
				// Should allow tools from read group
				expect(isToolAllowedForMode("read_file", codeMode, customModes)).toBe(true)
				// Should not allow tools from other groups
				expect(isToolAllowedForMode("write_to_file", codeMode, customModes)).toBe(false)
			})

			it("respects tool requirements in custom modes", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "custom-mode",
						name: "Custom Mode",
						roleDefinition: "Custom role",
						groups: ["edit"] as const,
					},
				]
				const requirements = { apply_diff: false }

				// Should respect disabled requirement even if tool group is allowed
				expect(isToolAllowedForMode("apply_diff", "custom-mode", customModes, requirements)).toBe(false)

				// Should allow other edit tools
				expect(isToolAllowedForMode("write_to_file", "custom-mode", customModes, requirements)).toBe(true)
			})

			it("allows tools from mode.tools_allowed whitelist", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "tools-only-mode",
						name: "Tools Only Mode",
						roleDefinition: "Custom role",
						groups: [],
						tools_allowed: ["read_file", "search_files"],
					},
				]
				// Should allow tools from the explicit tools list
				expect(isToolAllowedForMode("read_file", "tools-only-mode", customModes)).toBe(true)
				expect(isToolAllowedForMode("search_files", "tools-only-mode", customModes)).toBe(true)
				// Should not allow tools not in the list
				expect(isToolAllowedForMode("write_to_file", "tools-only-mode", customModes)).toBe(false)
				expect(isToolAllowedForMode("execute_command", "tools-only-mode", customModes)).toBe(false)
			})

			it("allows tools from mode.tools_allowed whitelist alone (no groups)", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "tools-alone-mode",
						name: "Tools Alone Mode",
						roleDefinition: "Custom role",
						tools_allowed: ["read_file"],
					} as ModeConfig,
				]
				// Should allow the whitelisted tool
				expect(isToolAllowedForMode("read_file", "tools-alone-mode", customModes)).toBe(true)
				// Should not allow tools not in the list
				expect(isToolAllowedForMode("search_files", "tools-alone-mode", customModes)).toBe(false)
			})

			it("allows tools when both groups and tools_allowed are present (OR semantics)", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "or-mode",
						name: "OR Mode",
						roleDefinition: "Custom role",
						groups: ["read"],
						tools_allowed: ["execute_command", "read_command_output"],
					} as ModeConfig,
				]
				// Should allow tools from groups
				expect(isToolAllowedForMode("read_file", "or-mode", customModes)).toBe(true)
				expect(isToolAllowedForMode("search_files", "or-mode", customModes)).toBe(true)
				// Should allow tools from tools_allowed whitelist (even though not in groups)
				expect(isToolAllowedForMode("execute_command", "or-mode", customModes)).toBe(true)
				expect(isToolAllowedForMode("read_command_output", "or-mode", customModes)).toBe(true)
				// Should not allow tools in neither
				expect(isToolAllowedForMode("write_to_file", "or-mode", customModes)).toBe(false)
			})

			it("allows always-available tools even in tools-only mode", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "minimal-tools-mode",
						name: "Minimal Tools Mode",
						roleDefinition: "Custom role",
						tools_allowed: ["read_file"],
					} as ModeConfig,
				]
				// Always-available tools should still be allowed
				expect(isToolAllowedForMode("ask_followup_question", "minimal-tools-mode", customModes)).toBe(true)
				expect(isToolAllowedForMode("attempt_completion", "minimal-tools-mode", customModes)).toBe(true)
				expect(isToolAllowedForMode("switch_mode", "minimal-tools-mode", customModes)).toBe(true)
			})

			it("tools_denied blocks tools even when allowed by groups", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "deny-mode",
						name: "Deny Mode",
						roleDefinition: "Custom role",
						groups: ["read", "command"],
						tools_denied: ["execute_command", "write_to_file"],
					} as ModeConfig,
				]
				// Tools in groups should be allowed
				expect(isToolAllowedForMode("read_file", "deny-mode", customModes)).toBe(true)
				expect(isToolAllowedForMode("search_files", "deny-mode", customModes)).toBe(true)
				// Denied tools should be blocked even if group allows them
				expect(isToolAllowedForMode("execute_command", "deny-mode", customModes)).toBe(false)
				// Non-group tools should still be blocked
				expect(isToolAllowedForMode("write_to_file", "deny-mode", customModes)).toBe(false)
			})

			it("tools_denied takes priority over tools_allowed", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "deny-override-mode",
						name: "Deny Override Mode",
						roleDefinition: "Custom role",
						tools_allowed: ["execute_command", "read_command_output"],
						tools_denied: ["execute_command"],
					} as ModeConfig,
				]
				// Allowed tool should work
				expect(isToolAllowedForMode("read_command_output", "deny-override-mode", customModes)).toBe(true)
				// Denied tool should be blocked even though also in tools_allowed
				expect(isToolAllowedForMode("execute_command", "deny-override-mode", customModes)).toBe(false)
			})
		})

		describe("dynamic MCP tools", () => {
			it("allows dynamic MCP tools when mcp group is in mode groups", () => {
				// Code mode has mcp group, so dynamic MCP tools should be allowed
				expect(isToolAllowedForMode("mcp_context7_resolve-library-id", codeMode, [])).toBe(true)
				expect(isToolAllowedForMode("mcp_serverName_toolName", codeMode, [])).toBe(true)
			})

			it("disallows dynamic MCP tools when mcp group is not in mode groups", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "no-mcp-mode",
						name: "No MCP Mode",
						roleDefinition: "Custom role",
						groups: ["read", "edit"] as const,
					},
				]
				// Custom mode without mcp group should not allow dynamic MCP tools
				expect(isToolAllowedForMode("mcp_context7_resolve-library-id", "no-mcp-mode", customModes)).toBe(false)
				expect(isToolAllowedForMode("mcp_serverName_toolName", "no-mcp-mode", customModes)).toBe(false)
			})

			it("allows dynamic MCP tools in custom mode with mcp group", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "custom-mcp-mode",
						name: "Custom MCP Mode",
						roleDefinition: "Custom role",
						groups: ["read", "mcp"] as const,
					},
				]
				expect(isToolAllowedForMode("mcp_context7_resolve-library-id", "custom-mcp-mode", customModes)).toBe(
					true,
				)
			})
		})

		describe("tool requirements", () => {
			it("respects tool requirements when provided", () => {
				const requirements = { apply_diff: false }
				expect(isToolAllowedForMode("apply_diff", codeMode, [], requirements)).toBe(false)

				const enabledRequirements = { apply_diff: true }
				expect(isToolAllowedForMode("apply_diff", codeMode, [], enabledRequirements)).toBe(true)
			})

			it("allows tools when their requirements are not specified", () => {
				const requirements = { some_other_tool: true }
				expect(isToolAllowedForMode("apply_diff", codeMode, [], requirements)).toBe(true)
			})

			it("handles undefined and empty requirements", () => {
				expect(isToolAllowedForMode("apply_diff", codeMode, [], undefined)).toBe(true)
				expect(isToolAllowedForMode("apply_diff", codeMode, [], {})).toBe(true)
			})

			it("prioritizes requirements over mode configuration", () => {
				const requirements = { apply_diff: false }
				// Even in code mode which allows all tools, disabled requirement should take precedence
				expect(isToolAllowedForMode("apply_diff", codeMode, [], requirements)).toBe(false)
			})

			it("prioritizes requirements over ALWAYS_AVAILABLE_TOOLS", () => {
				// Tools in ALWAYS_AVAILABLE_TOOLS (switch_mode, new_task, etc.) should still
				// be blockable via toolRequirements / disabledTools
				const requirements = { switch_mode: false, new_task: false, attempt_completion: false }
				expect(isToolAllowedForMode("switch_mode", codeMode, [], requirements)).toBe(false)
				expect(isToolAllowedForMode("new_task", codeMode, [], requirements)).toBe(false)
				expect(isToolAllowedForMode("attempt_completion", codeMode, [], requirements)).toBe(false)
			})
		})
	})

	describe("validateToolUse", () => {
		it("throws error for unknown/invalid tools", () => {
			// Unknown tools should throw with a specific "Unknown tool" error
			expect(() => validateToolUse("unknown_tool" as any, "architect", [])).toThrow(
				'Unknown tool "unknown_tool". This tool does not exist.',
			)
		})

		it("throws error for disallowed tools in architect mode", () => {
			// execute_command is a valid tool but not allowed in architect mode
			expect(() => validateToolUse("execute_command", "architect", [])).toThrow(
				'Tool "execute_command" is not allowed in architect mode.',
			)
		})

		it("does not throw for allowed tools in architect mode", () => {
			expect(() => validateToolUse("read_file", "architect", [])).not.toThrow()
		})

		it("throws error when tool requirement is not met", () => {
			const requirements = { apply_diff: false }
			expect(() => validateToolUse("apply_diff", codeMode, [], requirements)).toThrow(
				'Tool "apply_diff" is not allowed in code mode.',
			)
		})

		it("does not throw when tool requirement is met", () => {
			const requirements = { apply_diff: true }
			expect(() => validateToolUse("apply_diff", codeMode, [], requirements)).not.toThrow()
		})

		it("handles undefined requirements gracefully", () => {
			expect(() => validateToolUse("apply_diff", codeMode, [], undefined)).not.toThrow()
		})

		it("blocks tool when disabledTools is converted to toolRequirements", () => {
			const disabledTools = ["execute_command", "search_files"]
			const toolRequirements = disabledTools.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			expect(() => validateToolUse("execute_command", codeMode, [], toolRequirements)).toThrow(
				'Tool "execute_command" is not allowed in code mode.',
			)
			expect(() => validateToolUse("search_files", codeMode, [], toolRequirements)).toThrow(
				'Tool "search_files" is not allowed in code mode.',
			)
		})

		it("allows non-disabled tools when disabledTools is converted to toolRequirements", () => {
			const disabledTools = ["execute_command"]
			const toolRequirements = disabledTools.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			expect(() => validateToolUse("read_file", codeMode, [], toolRequirements)).not.toThrow()
			expect(() => validateToolUse("write_to_file", codeMode, [], toolRequirements)).not.toThrow()
		})

		it("handles empty disabledTools array converted to toolRequirements", () => {
			const disabledTools: string[] = []
			const toolRequirements = disabledTools.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			expect(() => validateToolUse("execute_command", codeMode, [], toolRequirements)).not.toThrow()
		})
	})
})
