import { checkAutoApproval } from "../index.js"

/**
 * Characterization tests for `checkAutoApproval` (v3 architecture §4).
 *
 * §4 wants the three permission systems (tool access, categories, per-model prefs)
 * plus auto-approval collapsed into ONE ordered allow/ask/deny rule engine. That
 * refactor touches security-critical decision logic, and the pre-existing suite
 * (`index.spec.ts`) only covered the questions and MCP paths. These tests lock the
 * CURRENT behavior of the `ask === "tool"` and `ask === "command"` paths so the
 * unification can proceed without silently changing what gets auto-approved.
 *
 * They assert behavior as it is today (not as it "should" be) — that is the point.
 */

const enabled = (extra: Record<string, unknown> = {}) => ({ autoApprovalEnabled: true, ...extra }) as any

const toolAsk = (tool: string, extra: Record<string, unknown> = {}) => ({
	ask: "tool" as const,
	text: JSON.stringify({ tool, ...extra }),
})

describe("checkAutoApproval — tool path characterization", () => {
	describe("unconditionally approved meta/informational tools (no toggle needed)", () => {
		const unconditional = [
			"updateTodoList",
			"skills",
			"setTaskTitle",
			"giveFeedback",
			"waitForTask",
			"checkTaskStatus",
			"listBackgroundTasks",
			"checkMcpCallStatus",
			"waitForMcpCall",
			"findFiles",
			"viewImage",
			"getErrors",
			"getProjectSetupInfo",
			"readProjectStructure",
			"listCodeUsages",
			"lspSearch",
			"sleep",
		]

		it.each(unconditional)("approves %s with only the master gate on", async (tool) => {
			expect(await checkAutoApproval({ state: enabled(), ...toolAsk(tool) })).toEqual({ decision: "approve" })
		})
	})

	describe("mode switching (alwaysAllowModeSwitch)", () => {
		it("asks when off", async () => {
			expect(await checkAutoApproval({ state: enabled(), ...toolAsk("switchMode") })).toEqual({ decision: "ask" })
		})
		it("approves when on", async () => {
			expect(
				await checkAutoApproval({ state: enabled({ alwaysAllowModeSwitch: true }), ...toolAsk("switchMode") }),
			).toEqual({ decision: "approve" })
		})
	})

	describe("subtask control tools (alwaysAllowSubtasks)", () => {
		const gated = ["newTask", "finishTask", "cancelTasks", "answerSubtaskQuestion"]
		it.each(gated)("asks for %s when off", async (tool) => {
			expect(await checkAutoApproval({ state: enabled(), ...toolAsk(tool) })).toEqual({ decision: "ask" })
		})
		it.each(gated)("approves %s when alwaysAllowSubtasks on", async (tool) => {
			expect(
				await checkAutoApproval({ state: enabled({ alwaysAllowSubtasks: true }), ...toolAsk(tool) }),
			).toEqual({ decision: "approve" })
		})
	})

	describe("sendMessageToTask (async always; sync gated by alwaysAllowSubtasks)", () => {
		it("approves async (fire-and-forget) regardless of toggle", async () => {
			expect(
				await checkAutoApproval({ state: enabled(), ...toolAsk("sendMessageToTask", { wait: false }) }),
			).toEqual({ decision: "approve" })
		})
		it("asks for sync send when alwaysAllowSubtasks off", async () => {
			expect(
				await checkAutoApproval({ state: enabled(), ...toolAsk("sendMessageToTask", { wait: true }) }),
			).toEqual({ decision: "ask" })
		})
		it("approves sync send when alwaysAllowSubtasks on", async () => {
			expect(
				await checkAutoApproval({
					state: enabled({ alwaysAllowSubtasks: true }),
					...toolAsk("sendMessageToTask", { wait: true }),
				}),
			).toEqual({ decision: "approve" })
		})
	})

	describe("browser group (alwaysAllowBrowser)", () => {
		it("asks for a browser_ tool when off", async () => {
			expect(await checkAutoApproval({ state: enabled(), ...toolAsk("browser_navigate") })).toEqual({
				decision: "ask",
			})
		})
		it("approves a browser_ tool when on", async () => {
			expect(
				await checkAutoApproval({
					state: enabled({ alwaysAllowBrowser: true }),
					...toolAsk("browser_navigate"),
				}),
			).toEqual({ decision: "approve" })
		})
	})

	describe("read-only tools (alwaysAllowReadOnly + outside-workspace)", () => {
		it("asks when alwaysAllowReadOnly off", async () => {
			expect(await checkAutoApproval({ state: enabled(), ...toolAsk("readFile") })).toEqual({ decision: "ask" })
		})
		it("approves an in-workspace read when on", async () => {
			expect(
				await checkAutoApproval({ state: enabled({ alwaysAllowReadOnly: true }), ...toolAsk("readFile") }),
			).toEqual({ decision: "approve" })
		})
		it("asks for an outside-workspace read unless the outside toggle is also on", async () => {
			expect(
				await checkAutoApproval({
					state: enabled({ alwaysAllowReadOnly: true }),
					...toolAsk("readFile", { isOutsideWorkspace: true }),
				}),
			).toEqual({ decision: "ask" })
			expect(
				await checkAutoApproval({
					state: enabled({ alwaysAllowReadOnly: true, alwaysAllowReadOnlyOutsideWorkspace: true }),
					...toolAsk("readFile", { isOutsideWorkspace: true }),
				}),
			).toEqual({ decision: "approve" })
		})
	})

	describe("write tools (alwaysAllowWrite + outside-workspace + protected)", () => {
		it("asks when alwaysAllowWrite off", async () => {
			expect(await checkAutoApproval({ state: enabled(), ...toolAsk("newFileCreated") })).toEqual({
				decision: "ask",
			})
		})
		it("approves an in-workspace write when on", async () => {
			expect(
				await checkAutoApproval({ state: enabled({ alwaysAllowWrite: true }), ...toolAsk("newFileCreated") }),
			).toEqual({ decision: "approve" })
		})
		it("requires the outside toggle for an outside-workspace write", async () => {
			expect(
				await checkAutoApproval({
					state: enabled({ alwaysAllowWrite: true }),
					...toolAsk("newFileCreated", { isOutsideWorkspace: true }),
				}),
			).toEqual({ decision: "ask" })
			expect(
				await checkAutoApproval({
					state: enabled({ alwaysAllowWrite: true, alwaysAllowWriteOutsideWorkspace: true }),
					...toolAsk("newFileCreated", { isOutsideWorkspace: true }),
				}),
			).toEqual({ decision: "approve" })
		})
		it("requires the protected toggle for a protected-file write", async () => {
			expect(
				await checkAutoApproval({
					state: enabled({ alwaysAllowWrite: true }),
					ask: "tool",
					text: JSON.stringify({ tool: "newFileCreated" }),
					isProtected: true,
				}),
			).toEqual({ decision: "ask" })
			expect(
				await checkAutoApproval({
					state: enabled({ alwaysAllowWrite: true, alwaysAllowWriteProtected: true }),
					ask: "tool",
					text: JSON.stringify({ tool: "newFileCreated" }),
					isProtected: true,
				}),
			).toEqual({ decision: "approve" })
		})
	})

	describe("malformed / unknown", () => {
		it("asks when the tool payload is not valid JSON", async () => {
			expect(await checkAutoApproval({ state: enabled(), ask: "tool", text: "{not json" })).toEqual({
				decision: "ask",
			})
		})
		it("asks for an unknown/uncategorized tool with no matching toggle", async () => {
			expect(await checkAutoApproval({ state: enabled(), ...toolAsk("totallyUnknownTool") })).toEqual({
				decision: "ask",
			})
		})
	})
})

describe("checkAutoApproval — command path characterization", () => {
	it("asks when alwaysAllowExecute is off", async () => {
		expect(await checkAutoApproval({ state: enabled(), ask: "command", text: "echo hi" })).toEqual({
			decision: "ask",
		})
	})
	it("approves an allow-listed command when alwaysAllowExecute is on", async () => {
		expect(
			await checkAutoApproval({
				state: enabled({ alwaysAllowExecute: true, allowedCommands: ["echo"] }),
				ask: "command",
				text: "echo hi",
			}),
		).toEqual({ decision: "approve" })
	})
	it("denies a deny-listed command", async () => {
		expect(
			await checkAutoApproval({
				state: enabled({ alwaysAllowExecute: true, allowedCommands: ["echo"], deniedCommands: ["rm"] }),
				ask: "command",
				text: "rm -rf /",
			}),
		).toEqual({ decision: "deny" })
	})
})
