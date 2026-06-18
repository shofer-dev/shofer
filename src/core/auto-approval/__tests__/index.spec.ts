import { checkAutoApproval } from "../index"

// Minimal enabled state — auto-approval master gate on, every category toggle off.
// Individual tests turn on only the toggle under test.
const enabledState = { autoApprovalEnabled: true } as any

describe("checkAutoApproval", () => {
	describe("inter-task questions (ask_followup_question routed to parent)", () => {
		// A background child routes its question UP to the parent via
		// askApproval("tool", { tool: "askFollowupQuestion", ... }). No human is
		// interrupted (the parent answers via answer_subtask_question), so this is
		// unconditionally approved regardless of any toggle.
		it("approves askFollowupQuestion even with no followup toggle", async () => {
			const result = await checkAutoApproval({
				state: enabledState,
				ask: "tool",
				text: JSON.stringify({ tool: "askFollowupQuestion", question: "Which file?" }),
			})

			expect(result).toEqual({ decision: "approve" })
		})

		it("approves askFollowupQuestion even when alwaysAllowFollowupQuestions is false", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowFollowupQuestions: false } as any,
				ask: "tool",
				text: JSON.stringify({ tool: "askFollowupQuestion", question: "Which file?" }),
			})

			expect(result).toEqual({ decision: "approve" })
		})
	})

	describe("user-directed questions (followup ask)", () => {
		// A question directed at the USER flows through the `followup` ask category,
		// which remains gated by alwaysAllowFollowupQuestions.
		it("asks when alwaysAllowFollowupQuestions is off", async () => {
			const result = await checkAutoApproval({
				state: enabledState,
				ask: "followup",
				text: JSON.stringify({ question: "Pick one", suggest: [{ answer: "a" }] }),
			})

			expect(result).toEqual({ decision: "ask" })
		})

		it("times out (auto-selects) when toggle on and a timeout is configured", async () => {
			const result = await checkAutoApproval({
				state: {
					autoApprovalEnabled: true,
					alwaysAllowFollowupQuestions: true,
					followupAutoApproveTimeoutMs: 5000,
				} as any,
				ask: "followup",
				text: JSON.stringify({ question: "Pick one", suggest: [{ answer: "a" }] }),
			})

			expect(result.decision).toBe("timeout")
		})
	})

	describe("MCP tool auto-approval (use_mcp_server ask)", () => {
		// A connected MCP server whose tools carry resolved groups, mirroring what
		// McpHub pushes to the webview (group resolved from mcp.json toolGroups).
		const mcpServers = [
			{
				name: "browser-tools",
				tools: [
					{ name: "navigate", group: "browser" },
					{ name: "read_dom", group: "read" },
				],
			},
			{
				name: "misc",
				tools: [
					{ name: "do_thing", group: "mcp" },
					{ name: "ungrouped", group: "uncategorized" },
				],
			},
		] as any

		const mcpUse = (serverName: string, toolName: string) =>
			JSON.stringify({ type: "use_mcp_tool", serverName, toolName })

		it("asks for a browser-group MCP tool when alwaysAllowBrowser is off (even with alwaysAllowMcp on)", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowMcp: true, mcpServers } as any,
				ask: "use_mcp_server",
				text: mcpUse("browser-tools", "navigate"),
			})

			expect(result).toEqual({ decision: "ask" })
		})

		it("approves a browser-group MCP tool when both alwaysAllowMcp and alwaysAllowBrowser are on", async () => {
			const result = await checkAutoApproval({
				state: {
					autoApprovalEnabled: true,
					alwaysAllowMcp: true,
					alwaysAllowBrowser: true,
					mcpServers,
				} as any,
				ask: "use_mcp_server",
				text: mcpUse("browser-tools", "navigate"),
			})

			expect(result).toEqual({ decision: "approve" })
		})

		it("asks for a read-group MCP tool when alwaysAllowReadOnly is off", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowMcp: true, mcpServers } as any,
				ask: "use_mcp_server",
				text: mcpUse("browser-tools", "read_dom"),
			})

			expect(result).toEqual({ decision: "ask" })
		})

		it("approves a generic 'mcp'-group tool with only alwaysAllowMcp on (no dedicated gate)", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowMcp: true, mcpServers } as any,
				ask: "use_mcp_server",
				text: mcpUse("misc", "do_thing"),
			})

			expect(result).toEqual({ decision: "approve" })
		})

		it("asks for an uncategorized tool unless alwaysAllowUncategorized is on", async () => {
			const base = { autoApprovalEnabled: true, alwaysAllowMcp: true, mcpServers } as any

			expect(
				await checkAutoApproval({ state: base, ask: "use_mcp_server", text: mcpUse("misc", "ungrouped") }),
			).toEqual({ decision: "ask" })

			expect(
				await checkAutoApproval({
					state: { ...base, alwaysAllowUncategorized: true },
					ask: "use_mcp_server",
					text: mcpUse("misc", "ungrouped"),
				}),
			).toEqual({ decision: "approve" })
		})

		it("asks when the master gate alwaysAllowMcp is off regardless of group toggles", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowBrowser: true, mcpServers } as any,
				ask: "use_mcp_server",
				text: mcpUse("browser-tools", "navigate"),
			})

			expect(result).toEqual({ decision: "ask" })
		})
	})

	it("asks for everything when the master gate is off", async () => {
		const result = await checkAutoApproval({
			state: { autoApprovalEnabled: false } as any,
			ask: "tool",
			text: JSON.stringify({ tool: "askFollowupQuestion", question: "Which file?" }),
		})

		expect(result).toEqual({ decision: "ask" })
	})
})
