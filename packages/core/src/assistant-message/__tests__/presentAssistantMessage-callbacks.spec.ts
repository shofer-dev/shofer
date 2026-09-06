import { toolNames, type ToolName } from "@shofer/types"

import { BaseTool, type ToolCallbacks } from "../../tools/BaseTool.js"
import { presentAssistantMessage } from "../presentAssistantMessage.js"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../tools/validateToolUse.js")>()),
	validateToolUse: vi.fn(),
}))
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		hasInstance: () => true,
		instance: {
			captureToolUsage: vi.fn(),
			captureToolRejected: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

/**
 * The dispatcher's per-tool CALLBACK BAG — `askApproval`, `handleError`,
 * `pushToolResult` — and the descriptions it renders around them.
 *
 * A tool never touches the transcript directly: it calls one of these three,
 * and the closures decide what the model sees. That makes them the place a
 * whole class of protocol bugs lives, and all three are pinned here:
 *
 *  - **exactly one `tool_result` per `tool_use_id`.** A second one is a
 *    duplicate the provider rejects, so the closure drops it rather than
 *    emitting it;
 *  - **approval feedback is MERGED into the tool's result**, never pushed as a
 *    result of its own — pushing it separately is how the duplicate above used
 *    to be produced;
 *  - **`AskIgnoredError` is control flow, not a failure.** It means a newer ask
 *    superseded this one; reporting it as an error would put a spurious error
 *    row in the chat every time a user re-asked.
 */

/** One tool call per `ToolName`, so the description switch is covered whole. */
const DESCRIPTION_CASES: Array<[ToolName, Record<string, string>, string]> = [
	["execute_command", { command: "ls -la" }, "[execute_command for 'ls -la']"],
	["write_to_file", { path: "a.ts" }, "[write_to_file for 'a.ts']"],
	["apply_diff", { path: "a.ts" }, "[apply_diff for 'a.ts']"],
	["grep_search", { query: "needle", fileTypes: "*.ts" }, "[grep_search for 'needle' in '*.ts']"],
	["edit", { file_path: "a.ts" }, "[edit for 'a.ts']"],
	["search_and_replace", { file_path: "a.ts" }, "[search_and_replace for 'a.ts']"],
	["search_replace", { file_path: "a.ts" }, "[search_replace for 'a.ts']"],
	["edit_file", { file_path: "a.ts" }, "[edit_file for 'a.ts']"],
	["apply_patch", {}, "[apply_patch]"],
	["list_files", { path: "src" }, "[list_files for 'src']"],
	["use_mcp_tool", { server_name: "srv" }, "[use_mcp_tool for 'srv']"],
	["access_mcp_resource", { server_name: "srv" }, "[access_mcp_resource for 'srv']"],
	["call_mcp_tool_async", { server_name: "srv", tool_name: "t" }, "[call_mcp_tool_async for 'srv/t']"],
	["check_mcp_call_status", { call_id: "c1" }, "[check_mcp_call_status for 'c1']"],
	["ask_followup_question", { question: "which?" }, "[ask_followup_question for 'which?']"],
	["attempt_completion", {}, "[attempt_completion]"],
	["wait", { in_reply_to: "m1" }, "[wait for reply to m1]"],
	["switch_mode", { mode_slug: "code", reason: "why" }, "[switch_mode to 'code' because: why]"],
	["set_task_title", { title: "T" }, "[set_task_title to 'T']"],
	["give_feedback", {}, "[give_feedback]"],
	["lsp_search", { query: "Task" }, "[lsp_search for 'Task']"],
	["read_command_output", { artifact_id: "a1" }, "[read_command_output for 'a1']"],
	["read_output_channel", { channel: "Shofer" }, "[read_output_channel for 'Shofer']"],
	["update_todo_list", {}, "[update_todo_list]"],
	["run_slash_command", { command: "test", args: "-v" }, "[run_slash_command for 'test' with args: -v]"],
	["check_task_status", { task_id: "t1" }, "[check_task_status for 't1']"],
	["send_message", { to: "t2", kind: "request" }, "[send_message → 't2' (request)]"],
	["reply", {}, "[reply]"],
	["list_background_tasks", {}, "[list_background_tasks]"],
	["skills", { skill: "s", args: "x" }, "[skills for 's' with args: x]"],
	["generate_image", { path: "o.png" }, "[generate_image for 'o.png']"],
	["get_errors", {}, "[get_errors]"],
	["get_project_setup_info", {}, "[get_project_setup_info]"],
	["read_project_structure", {}, "[read_project_structure]"],
	["list_code_usages", { filePath: "a.ts" }, "[list_code_usages for 'a.ts']"],
	["fetch_web_page", { urls: "https://x" }, "[fetch_web_page for 'https://x']"],
	["create_directory", { path: "d" }, "[create_directory for 'd']"],
	["create_new_workspace", { path: "." }, "[create_new_workspace for '.']"],
	["file", { subcommand: "mv", path: "a", destination: "b" }, "[file mv 'a' -> 'b']"],
	["find_files", { pattern: "*.ts" }, "[find_files for '*.ts']"],
	["view_image", { filePath: "i.png" }, "[view_image for 'i.png']"],
	["insert_edit", { filePath: "a.ts" }, "[insert_edit for 'a.ts']"],
	["rename_symbol", { filePath: "a.ts" }, "[rename_symbol for 'a.ts']"],
	["sed", { path: "a.ts" }, "[sed for 'a.ts']"],
	["read_file", { path: "a.ts" }, "[read_file for 'a.ts']"],
	["new_task", { mode: "code", message: "go" }, "[new_task in"],
	["cancel_tasks", { task_ids: ["t1", "t2"] as never }, "[cancel_tasks for 't1, t2']"],
	["wait_for_mcp_call", { call_ids: ["c1", "c2"] as never }, "[wait_for_mcp_call for 'c1, c2']"],
	["describe_tools", { names: ["read_file"] as never }, "[describe_tools for 'read_file']"],
]

function makeTask(overrides: Record<string, any> = {}) {
	const task: any = {
		taskId: "task-1",
		instanceId: "i",
		abort: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [],
		userMessageContent: [],
		didCompleteReadingStream: true,
		didRejectTool: false,
		didAlreadyUseTool: false,
		consecutiveMistakeCount: 0,
		shoferMessages: [],
		timelineOriginMs: 0,
		_pendingToolSpans: [],
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		withdrawStreamedToolAsk: vi.fn().mockResolvedValue(undefined),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
		providerRef: {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({
					mode: "code",
					customModes: [],
					experiments: { showToolInputOutput: true },
				}),
				getMcpHub: () => undefined,
			}),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		...overrides,
	}
	task.pushToolResultToUserContent = vi.fn((toolResult: any) => {
		task.userMessageContent.push(toolResult)
		return true
	})
	return task
}

const toolUse = (name: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	type: "tool_use",
	id: `call-${name}`,
	name,
	params,
	nativeArgs: {},
	partial: false,
	...extra,
})

/** The text of the single tool_result the dispatcher pushed. */
function resultText(task: any): string {
	const result = task.userMessageContent.find((b: any) => b.type === "tool_result")
	return String(result?.content ?? "")
}

/** Drive one tool call with a handler that runs `body` against the callback bag. */
async function runWithHandler(task: any, block: unknown, body: (cbs: ToolCallbacks) => Promise<void> | void) {
	const spy = vi
		.spyOn(BaseTool.prototype, "handle")
		.mockImplementation(async (_task, _block, callbacks) => body(callbacks))
	try {
		task.assistantMessageContent = [block]
		await presentAssistantMessage(task)
	} finally {
		spy.mockRestore()
	}
}

describe("toolDescription — every tool renders its own summary", () => {
	it.each(DESCRIPTION_CASES)("describes %s", async (name, params, expected) => {
		// A rejected turn renders the description into the skip message, which is
		// the shortest path through the switch that does not execute anything.
		const task = makeTask({ didRejectTool: true })
		// No `nativeArgs`: a skipped call is described from the params that
		// streamed, which is all a rejected turn ever has. (`read_file` PREFERS
		// nativeArgs when present, so supplying an empty one would describe it as
		// "missing path".)
		task.assistantMessageContent = [toolUse(name, params, { nativeArgs: undefined })]

		await presentAssistantMessage(task)

		expect(resultText(task)).toContain(expected)
	})

	it("falls back to the bare name for a tool the switch does not know", async () => {
		const task = makeTask({ didRejectTool: true })
		task.assistantMessageContent = [toolUse("custom_tool", {})]

		await presentAssistantMessage(task)

		expect(resultText(task)).toContain("[custom_tool]")
	})

	it("says INTERRUPTED rather than skipped for a partial block", async () => {
		const task = makeTask({ didRejectTool: true })
		task.assistantMessageContent = [toolUse("read_file", { path: "a.ts" }, { partial: true })]
		task.didCompleteReadingStream = false

		await presentAssistantMessage(task)

		expect(resultText(task)).toContain("was interrupted and not executed")
	})

	it("withdraws the ask a skipped call's streamed arguments already published", async () => {
		const task = makeTask({ didRejectTool: true })
		task.assistantMessageContent = [toolUse("read_file", { path: "a.ts" })]

		await presentAssistantMessage(task)

		expect(task.withdrawStreamedToolAsk).toHaveBeenCalled()
	})
})

describe("pushToolResult", () => {
	it("emits exactly ONE tool_result per call, dropping a duplicate", async () => {
		const task = makeTask()

		await runWithHandler(task, toolUse("read_file"), (cbs) => {
			cbs.pushToolResult("first")
			cbs.pushToolResult("second")
		})

		expect(task.userMessageContent.filter((b: any) => b.type === "tool_result")).toHaveLength(1)
		expect(resultText(task)).toBe("first")
	})

	it("says so when the tool returned nothing at all", async () => {
		const task = makeTask()

		await runWithHandler(task, toolUse("read_file"), (cbs) => cbs.pushToolResult(""))

		expect(resultText(task)).toBe("(tool did not return anything)")
	})

	it("splits a block array into text for the model and images for the turn", async () => {
		const task = makeTask()

		await runWithHandler(task, toolUse("view_image"), (cbs) =>
			cbs.pushToolResult([
				{ type: "text", text: "the picture" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
			] as never),
		)

		expect(resultText(task)).toBe("the picture")
		expect(task.userMessageContent.some((b: any) => b.type === "image")).toBe(true)
	})

	it("mirrors the output to the webview and truncates a very large one", async () => {
		const task = makeTask()
		const huge = "x".repeat(5000)

		await runWithHandler(task, toolUse("read_file"), (cbs) => cbs.pushToolResult(huge))

		const mirrored = task.say.mock.calls.find((c: unknown[]) => c[0] === "tool_result")
		expect(mirrored).toBeDefined()
		const payload = JSON.parse(String(mirrored![1]))
		expect(payload.tool).toBe("read_file")
		expect(payload.output).toContain("[Output truncated: 5,000 chars total]")
	})

	it("does not mirror the output when the experiment is off", async () => {
		const task = makeTask({
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [], experiments: {} }),
					getMcpHub: () => undefined,
				}),
			},
		})

		await runWithHandler(task, toolUse("read_file"), (cbs) => cbs.pushToolResult("some output"))

		expect(task.say.mock.calls.some((c: unknown[]) => c[0] === "tool_result")).toBe(false)
	})

	it("records the call as a tool span for the trace view", async () => {
		const task = makeTask()

		await runWithHandler(task, toolUse("read_file"), (cbs) => cbs.pushToolResult("done"))

		expect(task._pendingToolSpans).toHaveLength(1)
		expect(task._pendingToolSpans[0]).toMatchObject({ toolName: "read_file", isError: false })
	})

	it("marks the span as an error when the result is a structured failure", async () => {
		const task = makeTask()

		await runWithHandler(task, toolUse("read_file"), (cbs) =>
			cbs.pushToolResult(JSON.stringify({ status: "error", message: "nope" })),
		)

		expect(task._pendingToolSpans[0]!.isError).toBe(true)
	})
})

describe("askApproval", () => {
	it("returns true and merges the user's words into the tool's own result", async () => {
		const task = makeTask({
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "go ahead", images: ["img"] }),
		})
		let approved: boolean | undefined

		await runWithHandler(task, toolUse("read_file"), async (cbs) => {
			approved = await cbs.askApproval("tool", "{}")
			cbs.pushToolResult("the file contents")
		})

		expect(approved).toBe(true)
		expect(task.say).toHaveBeenCalledWith("user_feedback", "go ahead", ["img"])
		// ONE result, carrying both the approval feedback and the tool's output.
		expect(task.userMessageContent.filter((b: any) => b.type === "tool_result")).toHaveLength(1)
		expect(resultText(task)).toContain("approved")
		expect(resultText(task)).toContain("the file contents")
	})

	it("returns false and reports a bare denial", async () => {
		const task = makeTask({ ask: vi.fn().mockResolvedValue({ response: "noButtonClicked" }) })
		let approved: boolean | undefined

		await runWithHandler(task, toolUse("read_file"), async (cbs) => {
			approved = await cbs.askApproval("tool", "{}")
		})

		expect(approved).toBe(false)
		expect(task.didRejectTool).toBe(true)
		expect(resultText(task)).toContain("denied")
	})

	it("carries the user's reason when they denied WITH feedback", async () => {
		const task = makeTask({
			ask: vi.fn().mockResolvedValue({ response: "messageResponse", text: "not that file" }),
		})

		await runWithHandler(task, toolUse("read_file"), async (cbs) => {
			await cbs.askApproval("tool", "{}")
		})

		expect(task.say).toHaveBeenCalledWith("user_feedback", "not that file", undefined)
		expect(resultText(task)).toContain("not that file")
	})
})

describe("handleError", () => {
	it("shows the failure and hands the model a structured tool error", async () => {
		const task = makeTask()

		await runWithHandler(task, toolUse("read_file"), async (cbs) => {
			await cbs.handleError("reading file", new Error("ENOENT"))
		})

		expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("reading file"))
		expect(resultText(task)).toContain("ENOENT")
		expect(resultText(task)).toContain("error")
	})

	it("stays SILENT for AskIgnoredError, which is control flow rather than a failure", async () => {
		const { AskIgnoredError } = await import("../../task/AskIgnoredError.js")
		const task = makeTask()

		await runWithHandler(task, toolUse("read_file"), async (cbs) => {
			await cbs.handleError("asking", new AskIgnoredError("superseded"))
		})

		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
		expect(task.userMessageContent.filter((b: any) => b.type === "tool_result")).toHaveLength(0)
	})
})

describe("an MCP tool call", () => {
	it("skips with a tool_result when a previous tool was rejected", async () => {
		const task = makeTask({ didRejectTool: true })
		task.assistantMessageContent = [
			{
				type: "mcp_tool_use",
				id: "call-1",
				name: "mcp--srv--do",
				serverName: "srv",
				toolName: "do",
				partial: false,
			},
		]

		await presentAssistantMessage(task)

		expect(resultText(task)).toContain("Skipping MCP tool")
		expect(task.userMessageContent[0]!.is_error).toBe(true)
	})

	it("resolves a SANITIZED server name back to the one the hub knows", async () => {
		const findServerNameBySanitizedName = vi.fn(() => "My Server")
		const task = makeTask({
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [], experiments: {} }),
					getMcpHub: () => ({ findServerNameBySanitizedName }),
				}),
			},
		})
		let seenServer: string | undefined
		const spy = vi.spyOn(BaseTool.prototype, "handle").mockImplementation(async (_t, block) => {
			seenServer = (block as { params: { server_name?: string } }).params.server_name
		})

		try {
			task.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call-1",
					name: "mcp--My_Server--do",
					serverName: "My_Server",
					toolName: "do",
					arguments: { a: 1 },
					partial: false,
				},
			]
			await presentAssistantMessage(task)
		} finally {
			spy.mockRestore()
		}

		expect(findServerNameBySanitizedName).toHaveBeenCalledWith("My_Server")
		expect(seenServer).toBe("My Server")
	})

	it("records the call as an mcp: tool span", async () => {
		const task = makeTask()
		const spy = vi
			.spyOn(BaseTool.prototype, "handle")
			.mockImplementation(async (_t, _b, callbacks) => callbacks.pushToolResult("mcp output"))

		try {
			task.assistantMessageContent = [
				{
					type: "mcp_tool_use",
					id: "call-1",
					name: "mcp--srv--do",
					serverName: "srv",
					toolName: "do",
					arguments: {},
					partial: false,
				},
			]
			await presentAssistantMessage(task)
		} finally {
			spy.mockRestore()
		}

		expect(task._pendingToolSpans[0]).toMatchObject({ toolName: "mcp:srv/do" })
		expect(resultText(task)).toBe("mcp output")
	})
})

describe("the table itself", () => {
	it("describes every native tool", () => {
		const described = new Set(DESCRIPTION_CASES.map(([name]) => name))
		const missing = toolNames.filter((n) => n !== "custom_tool" && !described.has(n))
		expect(missing, `add a DESCRIPTION_CASES row for: ${missing.join(", ")}`).toEqual([])
	})
})
