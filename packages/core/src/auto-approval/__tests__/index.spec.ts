import { checkAutoApproval } from "../index.js"

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

	// A verb-multiplexing tool — one tool, an `operation` argument, several verbs
	// of different danger — is what keeps the catalog small. Gating it at the tool
	// level would collapse "allow the read verbs, gate the mutating ones" into
	// all-or-nothing, so the group is resolved PER CALL from the operation the
	// call will run (`_meta["shofer.dev/opGroups"]`, carried on McpTool.opGroups).
	describe("per-operation MCP gating (verb-multiplexing tools)", () => {
		// `events` is a family: read verbs and write verbs behind one name. Its
		// tool-level group is the MAXIMUM over its operations, which is what makes
		// every fallback below stricter rather than looser.
		const mcpServers = [
			{
				name: "justceo",
				tools: [
					{
						name: "events",
						group: "write",
						opGroups: { list: "read", get: "read", create: "write", delete: "write" },
					},
					// Same family, but the user assigned the whole tool a group in
					// mcp.json — a statement about the tool that must beat the
					// server's per-operation refinement.
					{
						name: "agents",
						group: "read",
						groupIsUserOverride: true,
						opGroups: { list: "read", delete: "write" },
					},
					// No map at all: the pre-consolidation shape, unchanged.
					{ name: "web_search", group: "read" },
				],
			},
		] as any

		const call = (toolName: string, args?: Record<string, unknown>) =>
			JSON.stringify({
				type: "use_mcp_tool",
				serverName: "justceo",
				toolName,
				arguments: args ? JSON.stringify(args) : undefined,
			})

		// The posture that makes the whole exercise visible: reads flow, writes
		// stop. Before per-operation groups, `events` was one `write` tool and
		// `events list` parked with the rest.
		const writeGating = {
			autoApprovalEnabled: true,
			alwaysAllowMcp: true,
			alwaysAllowReadOnly: true,
			mcpServers,
		} as any

		it("auto-approves a read operation of a write-grouped family", async () => {
			expect(
				await checkAutoApproval({
					state: writeGating,
					ask: "use_mcp_server",
					text: call("events", { operation: "list", project_id: "p1" }),
				}),
			).toEqual({ decision: "approve" })
		})

		it("still asks for a write operation of the SAME tool", async () => {
			expect(
				await checkAutoApproval({
					state: writeGating,
					ask: "use_mcp_server",
					text: call("events", { operation: "delete", id: "e1" }),
				}),
			).toEqual({ decision: "ask" })

			// …and approves it once the write toggle is on, proving the refusal was
			// the group gate and not a parse failure.
			expect(
				await checkAutoApproval({
					state: { ...writeGating, alwaysAllowWrite: true },
					ask: "use_mcp_server",
					text: call("events", { operation: "delete", id: "e1" }),
				}),
			).toEqual({ decision: "approve" })
		})

		// Every way of not resolving an operation falls back to the tool-level
		// group — the maximum over the operations — so each of these over-gates.
		it.each([
			["an operation absent from the map", call("events", { operation: "exfiltrate" })],
			["a non-string operation", call("events", { operation: 7 })],
			["an empty operation", call("events", { operation: "" })],
			["no operation argument at all", call("events", { project_id: "p1" })],
			["no arguments at all", call("events")],
			[
				"an unparsable arguments blob",
				JSON.stringify({
					type: "use_mcp_tool",
					serverName: "justceo",
					toolName: "events",
					arguments: "{not json",
				}),
			],
			[
				"a non-object arguments blob",
				JSON.stringify({
					type: "use_mcp_tool",
					serverName: "justceo",
					toolName: "events",
					arguments: JSON.stringify(["list"]),
				}),
			],
		])("falls back to the tool group given %s", async (_case, text) => {
			expect(await checkAutoApproval({ state: writeGating, ask: "use_mcp_server", text })).toEqual({
				decision: "ask",
			})
		})

		it("lets the user's whole-tool override win over the operation's group", async () => {
			// `agents delete` is `write` per the server's map, but the user pinned
			// the tool to `read` — the override is authoritative in both directions.
			expect(
				await checkAutoApproval({
					state: writeGating,
					ask: "use_mcp_server",
					text: call("agents", { operation: "delete", id: "a1" }),
				}),
			).toEqual({ decision: "approve" })

			// And with the read toggle off, the override refuses an operation the
			// map calls `read`.
			expect(
				await checkAutoApproval({
					state: { ...writeGating, alwaysAllowReadOnly: false, alwaysAllowWrite: true },
					ask: "use_mcp_server",
					text: call("agents", { operation: "list" }),
				}),
			).toEqual({ decision: "ask" })
		})

		it("leaves a tool with no operation map behaving exactly as before", async () => {
			// Its group decides, and an `operation` argument it never declared
			// changes nothing.
			expect(
				await checkAutoApproval({
					state: writeGating,
					ask: "use_mcp_server",
					text: call("web_search", { operation: "delete", query: "x" }),
				}),
			).toEqual({ decision: "approve" })

			expect(
				await checkAutoApproval({
					state: { ...writeGating, alwaysAllowReadOnly: false },
					ask: "use_mcp_server",
					text: call("web_search", { query: "x" }),
				}),
			).toEqual({ decision: "ask" })
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
