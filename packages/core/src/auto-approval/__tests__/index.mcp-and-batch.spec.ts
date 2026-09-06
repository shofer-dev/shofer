import { checkAutoApproval } from "../index.js"

/**
 * `checkAutoApproval`'s two paths that are NOT a plain group lookup: the MCP
 * `use_mcp_server` ask, and a batch `read_file`.
 *
 * MCP is gated TWICE on purpose. `alwaysAllowMcp` is the master switch, and
 * past it the tool's own resolved category must be approved through the shared
 * `GROUP_GATE` table — the same table native tools go through. One gate would
 * be wrong in both directions: master-only would auto-run a server's `write`
 * tool for anyone who allowed MCP at all, and group-only would ignore the
 * user's decision about MCP as a whole. The **Tool-Group Dual-Resolution Rule**
 * is what makes the second gate meaningful: the category comes from what the
 * server DECLARED, not from the tool's name.
 *
 * The private-tool arm is the deliberate exception: a tool contributed by
 * another installed extension rides this ask purely for UI consistency, and
 * the user opted in by installing that extension.
 *
 * The batch-read arm exists because one `read_file` can carry several paths,
 * each with its own workspace status. The top-level check only ever saw the
 * first, so an outside-workspace entry could ride into an approved call
 * unexamined — every entry is checked, and one unmatched entry falls the whole
 * call back to a prompt.
 */

/**
 * Every call here goes through the MASTER switch first — an absent
 * `autoApprovalEnabled` denies unconditionally, which is the headless default
 * — so the fixtures state it and the per-gate assertions are about what comes
 * after it.
 */
const ON = { autoApprovalEnabled: true }

const mcpAsk = (payload: Record<string, unknown>, state: Record<string, unknown> = {}) =>
	checkAutoApproval({ ask: "use_mcp_server", text: JSON.stringify(payload), state: { ...ON, ...state } as never })

const toolAsk = (payload: Record<string, unknown>, state: Record<string, unknown> = {}) =>
	checkAutoApproval({ ask: "tool", text: JSON.stringify(payload), state: { ...ON, ...state } as never })

describe("the master switch", () => {
	it("denies everything when it is absent, which is the headless default", async () => {
		// Silence is not a decision: an absent key must read as ASK, or a bundle
		// nobody wrote a posture into ships an agent that approves itself.
		expect(
			await checkAutoApproval({
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "a.ts" }),
				state: { alwaysAllowReadOnly: true } as never,
			}),
		).toEqual({ decision: "ask" })
	})

	it("denies everything when there is no state at all", async () => {
		expect(await checkAutoApproval({ ask: "tool", text: "{}" })).toEqual({ decision: "ask" })
	})
})

describe("the MCP ask", () => {
	const SERVERS = [
		{
			name: "srv",
			tools: [
				{ name: "reader", group: "read" },
				{ name: "writer", group: "write" },
			],
		},
	]

	it("asks when the payload is missing", async () => {
		expect(await checkAutoApproval({ ask: "use_mcp_server", state: ON as never })).toEqual({ decision: "ask" })
	})

	it("asks when the payload is not JSON", async () => {
		// A malformed ask must fail CLOSED; guessing what it meant is how an
		// unreviewed call gets auto-run.
		expect(await checkAutoApproval({ ask: "use_mcp_server", text: "{ not json", state: ON as never })).toEqual({
			decision: "ask",
		})
	})

	it("asks for a payload whose type it does not recognise", async () => {
		expect(await mcpAsk({ type: "something_new" }, { alwaysAllowMcp: true })).toEqual({ decision: "ask" })
	})

	it("asks when the MASTER switch is off, whatever the group says", async () => {
		expect(
			await mcpAsk(
				{ type: "use_mcp_tool", serverName: "srv", toolName: "reader" },
				{ alwaysAllowMcp: false, alwaysAllowReadOnly: true, mcpServers: SERVERS },
			),
		).toEqual({ decision: "ask" })
	})

	it("asks when the master switch is on but the tool's GROUP is not approved", async () => {
		expect(
			await mcpAsk(
				{ type: "use_mcp_tool", serverName: "srv", toolName: "writer" },
				{ alwaysAllowMcp: true, alwaysAllowReadOnly: true, mcpServers: SERVERS },
			),
		).toEqual({ decision: "ask" })
	})

	it("approves only when BOTH gates are open", async () => {
		expect(
			await mcpAsk(
				{ type: "use_mcp_tool", serverName: "srv", toolName: "reader" },
				{ alwaysAllowMcp: true, alwaysAllowReadOnly: true, mcpServers: SERVERS },
			),
		).toEqual({ decision: "approve" })
	})

	it("gates an UNGROUPED tool on the uncategorized toggle", async () => {
		const servers = [{ name: "srv", tools: [{ name: "mystery" }] }]
		const call = { type: "use_mcp_tool", serverName: "srv", toolName: "mystery" }

		expect(await mcpAsk(call, { alwaysAllowMcp: true, mcpServers: servers })).toEqual({ decision: "ask" })
		expect(
			await mcpAsk(call, { alwaysAllowMcp: true, alwaysAllowUncategorized: true, mcpServers: servers }),
		).toEqual({ decision: "approve" })
	})

	it("gates a DYNAMIC category through the open map, not a flat key", async () => {
		const servers = [{ name: "srv", tools: [{ name: "lead", group: "salesforce" }] }]
		const call = { type: "use_mcp_tool", serverName: "srv", toolName: "lead" }

		expect(await mcpAsk(call, { alwaysAllowMcp: true, mcpServers: servers })).toEqual({ decision: "ask" })
		expect(
			await mcpAsk(call, {
				alwaysAllowMcp: true,
				alwaysAllowGroups: { salesforce: true },
				mcpServers: servers,
			}),
		).toEqual({ decision: "approve" })
	})

	it("gates a RESOURCE read on the master switch alone", async () => {
		const call = { type: "access_mcp_resource", serverName: "srv", uri: "file://x" }

		expect(await mcpAsk(call, { alwaysAllowMcp: true })).toEqual({ decision: "approve" })
		expect(await mcpAsk(call, {})).toEqual({ decision: "ask" })
	})

	it("approves a PRIVATE provider's tool without consulting the MCP gates at all", async () => {
		// It rides this ask for UI consistency; the user opted in by installing
		// the providing extension.
		expect(await mcpAsk({ type: "use_mcp_tool", toolName: "acme_lookup", external_lm_tool: true }, {})).toEqual({
			decision: "approve",
		})
	})
})

describe("a batch read", () => {
	const batch = (entries: Array<Record<string, unknown>>) => ({
		tool: "readFile",
		path: "src/a.ts",
		batchFiles: entries,
	})

	const READ_ON = { alwaysAllowReadOnly: true }

	it("approves a batch entirely inside the workspace", async () => {
		expect(await toolAsk(batch([{ absolutePath: "/ws/a.ts" }, { absolutePath: "/ws/b.ts" }]), READ_ON)).toEqual({
			decision: "approve",
		})
	})

	it("asks when ONE entry is outside the workspace and unlisted", async () => {
		// The top-level check only ever saw the tool's own path, so without this
		// the outside entry rode in unexamined.
		expect(
			await toolAsk(
				batch([{ absolutePath: "/ws/a.ts" }, { absolutePath: "/etc/passwd", isOutsideWorkspace: true }]),
				READ_ON,
			),
		).toEqual({ decision: "ask" })
	})

	it("approves an outside entry the user listed as a trusted read path", async () => {
		expect(
			await toolAsk(batch([{ absolutePath: "/data/notes.md", isOutsideWorkspace: true }]), {
				...READ_ON,
				allowedReadPaths: ["/data"],
			}),
		).toEqual({ decision: "approve" })
	})

	it("skips the per-entry check when the blanket outside-workspace toggle is on", async () => {
		// The group check already approved every outside entry.
		expect(
			await toolAsk(batch([{ absolutePath: "/etc/passwd", isOutsideWorkspace: true }]), {
				...READ_ON,
				alwaysAllowReadOnlyOutsideWorkspace: true,
			}),
		).toEqual({ decision: "approve" })
	})

	it("still asks for a batch when read is not auto-approved at all", async () => {
		expect(await toolAsk(batch([{ absolutePath: "/ws/a.ts" }]), {})).toEqual({ decision: "ask" })
	})
})

describe("the command ask", () => {
	it("asks when there is no command text", async () => {
		expect(
			await checkAutoApproval({ ask: "command", state: { ...ON, alwaysAllowExecute: true } as never }),
		).toEqual({
			decision: "ask",
		})
	})

	it("asks when execute is not auto-approved, whatever the allow-list says", async () => {
		expect(
			await checkAutoApproval({
				ask: "command",
				text: "ls",
				state: { ...ON, allowedCommands: ["ls"] } as never,
			}),
		).toEqual({ decision: "ask" })
	})

	it("approves a listed command, DENIES a denied one, and asks about the rest", async () => {
		const state = { ...ON, alwaysAllowExecute: true, allowedCommands: ["ls"], deniedCommands: ["rm"] }

		expect(await checkAutoApproval({ ask: "command", text: "ls -la", state: state as never })).toEqual({
			decision: "approve",
		})
		// Deny is its own answer, not a prompt: an explicitly denied command must
		// not be reachable by clicking through.
		expect(await checkAutoApproval({ ask: "command", text: "rm -rf /", state: state as never })).toEqual({
			decision: "deny",
		})
		expect(await checkAutoApproval({ ask: "command", text: "curl example.com", state: state as never })).toEqual({
			decision: "ask",
		})
	})
})

describe("the follow-up question ask", () => {
	it("asks when the payload will not parse", async () => {
		expect(await checkAutoApproval({ ask: "followup", text: "{ not json", state: ON as never })).toEqual({
			decision: "ask",
		})
	})

	it("asks when there is no suggestion to fall back on", async () => {
		expect(
			await checkAutoApproval({
				ask: "followup",
				text: JSON.stringify({ question: "which?", suggest: [] }),
				state: { ...ON, alwaysAllowFollowupQuestions: true, followupAutoApproveTimeoutMs: 1000 } as never,
			}),
		).toEqual({ decision: "ask" })
	})

	it("answers with the first suggestion after a TIMEOUT rather than immediately", async () => {
		// The user gets the window to answer themselves; the fallback is what
		// stops an unattended run stalling forever.
		const result = await checkAutoApproval({
			ask: "followup",
			text: JSON.stringify({ question: "which?", suggest: [{ answer: "the first one" }] }),
			state: { ...ON, alwaysAllowFollowupQuestions: true, followupAutoApproveTimeoutMs: 1_500 } as never,
		})

		expect(result).toMatchObject({ decision: "timeout", timeout: 1_500 })
		expect((result as { fn: () => { askResponse: string; text?: string } }).fn()).toEqual({
			askResponse: "messageResponse",
			text: "the first one",
		})
	})

	it("asks when the follow-up toggle is off", async () => {
		expect(
			await checkAutoApproval({
				ask: "followup",
				text: JSON.stringify({ question: "which?", suggest: [{ answer: "a" }] }),
				state: ON as never,
			}),
		).toEqual({ decision: "ask" })
	})
})
