import type { ToolName } from "@shofer/types"
import { createInMemoryHost, setHost } from "@shofer/types"

import { BaseTool } from "../../tools/BaseTool.js"
import { pluginRegistry } from "../../plugins/plugin-registry.js"
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
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
			captureToolRejected: vi.fn(),
		},
	},
}))

/**
 * The dispatcher's GUARDS and its non-native arms — everything between "a block
 * arrived" and "a handler ran".
 *
 * Each guard exists because of a specific way a turn goes wrong, and all of
 * them fail by producing a `tool_result` rather than by throwing: the native
 * protocol requires one result per `tool_use`, and a missing one is an API 400
 * on the NEXT request, blamed on a message nobody wrote.
 *
 *  - **repetition**: a model that calls the same tool with the same arguments
 *    is not making progress, and left alone it burns the budget in a tight
 *    loop. The gate asks the user and, either way, tells the model to try
 *    something else. `new_task` is exempt — spawning two identical children is
 *    a legitimate fan-out — and the disable-mistake-limit experiment turns the
 *    whole check off;
 *  - **duplicate `attempt_completion`**: one terminal declaration per response.
 *    A second would emit `TaskCompleted` twice, and the flag is deliberately
 *    NOT set on a partial, or the complete block that follows it would be
 *    rejected as its own duplicate;
 *  - **a rejected previous tool** short-circuits the rest of the batch, and
 *    still pushes a result for every skipped call;
 *  - the **private-tool arm**, which is not a native tool at all: it is invoked
 *    over a host command contributed by another extension, gated by the
 *    approval plane, and its result may carry image paths this arm reads off
 *    disk so a vision model can see them.
 */

const NOOP_ARGS = { path: "a.ts" }

let handled: string[]
let handleSpy: ReturnType<typeof vi.spyOn>

type FakeTask = Record<string, unknown> & {
	assistantMessageContent: unknown[]
	userMessageContent: Array<Record<string, unknown>>
}

function makeTask(over: Record<string, unknown> = {}): FakeTask {
	const task = {
		taskId: "task-1",
		instanceId: "i",
		abort: false,
		turnCount: 1,
		cwd: "/ws",
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [] as unknown[],
		userMessageContent: [] as Array<Record<string, unknown>>,
		didCompleteReadingStream: true,
		didRejectTool: false,
		didAlreadyUseTool: false,
		didExecuteAttemptCompletion: false,
		consecutiveMistakeCount: 0,
		consecutiveMistakeLimit: 3,
		shoferMessages: [],
		apiConfiguration: { apiProvider: "anthropic" },
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		withdrawStreamedToolAsk: vi.fn().mockResolvedValue(undefined),
		emitTaskInteraction: vi.fn().mockResolvedValue(undefined),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
		providerRef: {
			deref: () => ({ getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [], experiments: {} }) }),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		...over,
	} as FakeTask

	task.pushToolResultToUserContent = vi.fn((toolResult: Record<string, unknown>) => {
		task.userMessageContent.push(toolResult)
		return true
	})
	return task
}

const toolUse = (name: string, over: Record<string, unknown> = {}) => ({
	type: "tool_use",
	id: `call-${name}`,
	name,
	params: {},
	nativeArgs: NOOP_ARGS,
	partial: false,
	...over,
})

const resultsOf = (task: FakeTask) =>
	task.userMessageContent.filter((b) => b.type === "tool_result").map((b) => String(b.content))

beforeEach(() => {
	handled = []
	setHost(createInMemoryHost())
	handleSpy = vi.spyOn(BaseTool.prototype, "handle").mockImplementation(async function (this: BaseTool<ToolName>) {
		handled.push(this.name)
	}) as never
})

afterEach(() => {
	handleSpy.mockRestore()
	vi.restoreAllMocks()
})

describe("the repetition gate", () => {
	const repeating = () => ({
		check: vi.fn().mockReturnValue({
			allowExecution: false,
			askUser: { messageKey: "mistake_limit_reached", messageDetail: "{toolName} again" },
		}),
	})

	it("refuses the call and tells the model to try something else", async () => {
		const task = makeTask({ toolRepetitionDetector: repeating() })
		task.assistantMessageContent = [toolUse("read_file")]

		await presentAssistantMessage(task as never)

		expect(handled).toEqual([])
		expect(resultsOf(task)[0]).toContain("repetition limit reached for read_file")
	})

	it("names the tool in the question it puts to the user", async () => {
		const task = makeTask({ toolRepetitionDetector: repeating() })
		task.assistantMessageContent = [toolUse("read_file")]

		await presentAssistantMessage(task as never)

		expect(task.ask).toHaveBeenCalledWith("mistake_limit_reached", "read_file again")
	})

	it("folds the user's typed answer into the turn rather than discarding it", async () => {
		const task = makeTask({
			toolRepetitionDetector: repeating(),
			ask: vi.fn().mockResolvedValue({ response: "messageResponse", text: "try apply_diff", images: [] }),
		})
		task.assistantMessageContent = [toolUse("read_file")]

		await presentAssistantMessage(task as never)

		expect(task.userMessageContent.some((b) => String(b.text).includes("try apply_diff"))).toBe(true)
		expect(task.say).toHaveBeenCalledWith("user_feedback", "try apply_diff", [])
	})

	it("exempts new_task, because fanning out identical children is legitimate", async () => {
		const detector = repeating()
		const task = makeTask({ toolRepetitionDetector: detector })
		task.assistantMessageContent = [toolUse("new_task", { nativeArgs: { mode: "code", message: "m" } })]

		await presentAssistantMessage(task as never)

		expect(detector.check).not.toHaveBeenCalled()
		expect(handled).toEqual(["new_task"])
	})

	it("is skipped entirely under the disable-mistake-limit experiment", async () => {
		const detector = repeating()
		const task = makeTask({
			toolRepetitionDetector: detector,
			providerRef: {
				deref: () => ({
					getState: vi
						.fn()
						.mockResolvedValue({
							mode: "code",
							customModes: [],
							experiments: { disableMistakeLimitChecks: true },
						}),
				}),
			},
		})
		task.assistantMessageContent = [toolUse("read_file")]

		await presentAssistantMessage(task as never)

		expect(detector.check).not.toHaveBeenCalled()
		expect(handled).toEqual(["read_file"])
	})

	it("does not run against a PARTIAL block, whose arguments are incomplete", async () => {
		const detector = repeating()
		const task = makeTask({ toolRepetitionDetector: detector, didCompleteReadingStream: false })
		task.assistantMessageContent = [toolUse("read_file", { partial: true })]

		await presentAssistantMessage(task as never)

		expect(detector.check).not.toHaveBeenCalled()
	})
})

describe("one attempt_completion per response", () => {
	it("refuses a SECOND terminal declaration", async () => {
		const task = makeTask({ didExecuteAttemptCompletion: true })
		task.assistantMessageContent = [toolUse("attempt_completion", { nativeArgs: { result: "done" } })]

		await presentAssistantMessage(task as never)

		expect(handled).toEqual([])
		expect(resultsOf(task)[0]).toContain("Skipped duplicate attempt_completion")
	})

	it("marks the flag on the COMPLETE block only", async () => {
		// Setting it on a partial would make the complete block that follows read
		// as its own duplicate.
		const partialTask = makeTask({ didCompleteReadingStream: false })
		partialTask.assistantMessageContent = [
			toolUse("attempt_completion", { nativeArgs: { result: "d" }, partial: true }),
		]

		await presentAssistantMessage(partialTask as never)

		expect(partialTask.didExecuteAttemptCompletion).toBe(false)
	})

	it("marks it once the complete block runs", async () => {
		const task = makeTask()
		task.assistantMessageContent = [toolUse("attempt_completion", { nativeArgs: { result: "d" } })]

		await presentAssistantMessage(task as never)

		expect(task.didExecuteAttemptCompletion).toBe(true)
	})
})

describe("after a tool has been rejected", () => {
	it("skips the rest of the batch but still answers every call", async () => {
		// A `tool_use` with no `tool_result` is an API 400 on the next request.
		const task = makeTask({ didRejectTool: true })
		task.assistantMessageContent = [toolUse("read_file"), toolUse("list_files")]

		await presentAssistantMessage(task as never)
		task.currentStreamingContentIndex = 1
		task.presentAssistantMessageLocked = false
		await presentAssistantMessage(task as never)

		expect(handled).toEqual([])
		expect(resultsOf(task).join(" ")).toContain("Skipping tool")
	})

	it("answers a skipped MCP call too", async () => {
		const task = makeTask({ didRejectTool: true })
		task.assistantMessageContent = [
			{ type: "mcp_tool_use", id: "mcp-1", name: "mcp--srv--do", arguments: {}, partial: false },
		]

		await presentAssistantMessage(task as never)

		expect(resultsOf(task)[0]).toContain("Skipping MCP tool")
	})

	it("reports an INTERRUPTED partial MCP call distinctly from a skipped complete one", async () => {
		const task = makeTask({ didRejectTool: true, didCompleteReadingStream: false })
		task.assistantMessageContent = [
			{ type: "mcp_tool_use", id: "mcp-1", name: "mcp--srv--do", arguments: {}, partial: true },
		]

		await presentAssistantMessage(task as never)

		expect(resultsOf(task)[0]).toContain("was interrupted")
	})
})

describe("the narration between tool calls", () => {
	it("offers a COMPLETE text block to the observer plugins", async () => {
		const notify = vi.spyOn(pluginRegistry, "notifyAssistantMessage").mockResolvedValue(undefined as never)
		vi.spyOn(pluginRegistry, "hasLifecycleHook").mockReturnValue(true)
		const task = makeTask()
		task.assistantMessageContent = [{ type: "text", content: "let me look at that", partial: false }]

		await presentAssistantMessage(task as never)

		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "task-1", text: "let me look at that", turn: 1 }),
			expect.objectContaining({ cwd: "/ws" }),
		)
	})

	it("offers nothing for a partial, so nothing sits inside the streaming path", async () => {
		const notify = vi.spyOn(pluginRegistry, "notifyAssistantMessage").mockResolvedValue(undefined as never)
		vi.spyOn(pluginRegistry, "hasLifecycleHook").mockReturnValue(true)
		const task = makeTask({ didCompleteReadingStream: false })
		task.assistantMessageContent = [{ type: "text", content: "half a thou", partial: true }]

		await presentAssistantMessage(task as never)

		expect(notify).not.toHaveBeenCalled()
	})

	it("offers nothing when the block is only whitespace", async () => {
		const notify = vi.spyOn(pluginRegistry, "notifyAssistantMessage").mockResolvedValue(undefined as never)
		vi.spyOn(pluginRegistry, "hasLifecycleHook").mockReturnValue(true)
		const task = makeTask()
		task.assistantMessageContent = [{ type: "text", content: "   ", partial: false }]

		await presentAssistantMessage(task as never)

		expect(notify).not.toHaveBeenCalled()
	})
})

describe("an unknown tool", () => {
	it("comes back as a tool_result rather than as a throw", async () => {
		const task = makeTask()
		task.assistantMessageContent = [toolUse("no_such_tool", { nativeArgs: {} })]

		await presentAssistantMessage(task as never)

		expect(handled).toEqual([])
		expect(resultsOf(task).join(" ")).toMatch(/nknown tool/)
	})
})
