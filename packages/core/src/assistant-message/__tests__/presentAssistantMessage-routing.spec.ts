import { toolNames, type ToolName } from "@shofer/types"

import { BaseTool } from "../../tools/BaseTool.js"
import { resolveToolAlias } from "../../tools/tool-aliases.js"
import { presentAssistantMessage } from "../presentAssistantMessage.js"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../tools/validateToolUse.js")>()),
	validateToolUse: vi.fn(),
}))
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: { captureToolUsage: vi.fn(), captureConsecutiveMistakeError: vi.fn() },
	},
}))

/**
 * The dispatcher's ROUTER — the switch in `presentAssistantMessage` that maps a
 * `ToolName` onto the singleton that runs it.
 *
 * The Native Tool Implementation Rule lists the router as one of the places a
 * new tool must be registered, and it is the one whose omission is least
 * visible: schema, `toolNames`, `TOOL_GROUPS`, parser and handler can all be
 * correct while the call falls through to the `default` arm and comes back as
 * "Unknown tool", with the handler's own tests still green because they call
 * `execute()` directly.
 *
 * So the table below drives EVERY name in `toolNames` through the real
 * dispatcher and asserts the call reached a handler. `BaseTool.prototype.handle`
 * is spied rather than each of the ~45 singletons mocked: every tool inherits
 * it, so one spy sees the whole surface and reports which tool it landed on.
 */

/** Minimal per-tool `nativeArgs`; the handler is stubbed, so only routing matters. */
const NATIVE_ARGS: Record<string, Record<string, unknown>> = {
	execute_command: { command: "echo hi" },
	read_file: { path: "a.ts" },
	read_command_output: { artifact_id: "a" },
	read_output_channel: {},
	write_to_file: { path: "a.ts", content: "x" },
	apply_diff: { path: "a.ts", diff: "d" },
	edit: { file_path: "a.ts", old_string: "a", new_string: "b" },
	search_and_replace: { file_path: "a.ts", old_string: "a", new_string: "b" },
	search_replace: { file_path: "a.ts", old_string: "a", new_string: "b" },
	edit_file: { file_path: "a.ts", old_string: "a", new_string: "b" },
	apply_patch: { patch: "p" },
	grep_search: { path: ".", query: "q" },
	list_files: { path: "." },
	use_mcp_tool: { server_name: "s", tool_name: "t" },
	access_mcp_resource: { server_name: "s", uri: "u" },
	ask_followup_question: { question: "q", follow_up: ["a"] },
	attempt_completion: { result: "done" },
	switch_mode: { mode_slug: "code", reason: "r" },
	new_task: { mode: "code", message: "m" },
	update_todo_list: { todos: "[ ] x" },
	run_slash_command: { command: "c" },
	skills: { skill: "s" },
	generate_image: { prompt: "p", path: "o.png" },
	create_directory: { path: "d" },
	create_new_workspace: { path: ".", name: "n" },
	file: { subcommand: "rm", path: "a.ts" },
	fetch_web_page: { urls: ["https://example.com"] },
	find_files: { pattern: "*.ts" },
	get_errors: {},
	get_project_setup_info: {},
	insert_edit: { path: "a.ts", line: 1, text: "x" },
	list_code_usages: { path: "a.ts", line: 1, column: 1 },
	read_project_structure: {},
	rename_symbol: { path: "a.ts", line: 1, column: 1, newName: "y" },
	view_image: { path: "a.png" },
	lsp_search: { query: "q" },
	set_task_title: { title: "t" },
	give_feedback: { feedback: "f" },
	check_task_status: { task_id: "t" },
	list_background_tasks: { scope: "children" },
	cancel_tasks: { task_ids: ["t"] },
	sed: { path: "a.ts", pattern: "a", replacement: "b" },
	call_mcp_tool_async: { server_name: "s", tool_name: "t" },
	check_mcp_call_status: { call_id: "c" },
	wait_for_mcp_call: { call_ids: ["c"] },
	send_message: { to: "t", body: "b" },
	reply: { replies: [{ message_id: "m", body: "b" }] },
	wait: {},
	describe_tools: { names: ["read_file"] },
}

/** `custom_tool` is the registry placeholder, not a routed native tool. */
const ROUTED = toolNames.filter((n) => n !== "custom_tool")

let handled: string[]

let handleSpy: any

function makeTask() {
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
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		withdrawStreamedToolAsk: vi.fn().mockResolvedValue(undefined),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
		providerRef: {
			deref: () => ({ getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }) }),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
	}
	task.pushToolResultToUserContent = vi.fn((toolResult: any) => {
		task.userMessageContent.push(toolResult)
		return true
	})
	return task
}

beforeEach(() => {
	handled = []
	// One spy over the shared entry point every tool inherits.
	handleSpy = vi.spyOn(BaseTool.prototype, "handle").mockImplementation(async function (this: BaseTool<ToolName>) {
		handled.push(this.name)
	})
})

afterEach(() => {
	handleSpy.mockRestore()
})

describe("presentAssistantMessage — every native tool is routed to its handler", () => {
	it("covers every name in `toolNames` with a fixture", () => {
		const missing = ROUTED.filter((n) => NATIVE_ARGS[n] === undefined)
		expect(missing, `add a NATIVE_ARGS row for: ${missing.join(", ")}`).toEqual([])
	})

	it.each(ROUTED)("routes %s", async (name) => {
		const task = makeTask()
		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: `call-${name}`,
				name,
				params: {},
				nativeArgs: NATIVE_ARGS[name],
				partial: false,
			},
		]

		await presentAssistantMessage(task)

		// An alias routes to its canonical handler; either way the call must reach
		// a handler rather than the router's unknown-tool arm.
		expect(handled, `${name} did not reach a tool handler`).toEqual([resolveToolAlias(name)])
		expect(task.consecutiveMistakeCount).toBe(0)
	})
})

describe("presentAssistantMessage — the router's own refusals", () => {
	it("rejects a native call that carries no nativeArgs instead of reaching execute()", async () => {
		const task = makeTask()
		task.assistantMessageContent = [
			{ type: "tool_use", id: "call-1", name: "read_file", params: {}, partial: false },
		]

		await presentAssistantMessage(task)

		expect(handled).toEqual([])
		const result = task.userMessageContent.find((b: any) => b.type === "tool_result")
		expect(String(result.content)).toContain("the arguments could not be parsed")
	})

	it("does not dispatch a PARTIAL block through the complete path", async () => {
		const task = makeTask()
		task.didCompleteReadingStream = false
		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call-1",
				name: "read_file",
				params: {},
				nativeArgs: { path: "a.ts" },
				partial: true,
			},
		]

		await presentAssistantMessage(task)

		// `handle()` is still the entry point for a partial, but it must be told so.
		expect(handleSpy).toHaveBeenCalledWith(task, expect.objectContaining({ partial: true }), expect.anything())
	})
})
