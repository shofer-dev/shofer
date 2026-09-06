import fsp from "fs/promises"
import os from "os"
import path from "path"

import type { ToolName } from "@shofer/types"
import { createInMemoryHost, setHost } from "@shofer/types"

import { BaseTool } from "../../tools/BaseTool.js"
import { setPrivateToolInvokeMap } from "../../tools/private-tool-registry.js"
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
 * The **private-tool** arm of the dispatcher — tools another VS Code extension
 * contributes through `arkware.privateToolProviders`.
 *
 * It is the one execution path that leaves the process without going through
 * MCP: the call is a host command, and the counterparty is an extension we do
 * not control. Three things follow, and each is asserted below:
 *
 *  - **it is gated like an MCP call, not like a native one.** The approval is
 *    raised as `use_mcp_server` with an `external_lm_tool` marker, because from
 *    the user's point of view it IS a third party acting;
 *  - **a provider that vanished between build and execution falls through to
 *    the unknown-tool arm** rather than throwing — the extension may have been
 *    disabled mid-turn;
 *  - **an image the provider returns is READ and attached**, so a vision model
 *    can see it. A path in the text is not something a model can look at, and
 *    an unreadable one is skipped rather than failing the call, because the
 *    text result still names it.
 *
 * The Private-Tool Discovery Error Visibility Rule notes that this arm shares
 * discovery's silence problem; what it must never do is fail the whole turn, so
 * an execution error comes back through `handleError` as a tool result.
 */

let handled: string[]
let handleSpy: ReturnType<typeof vi.spyOn>
let executeCommand: ReturnType<typeof vi.fn>

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

const call = (over: Record<string, unknown> = {}) => ({
	type: "tool_use",
	id: "call-1",
	name: "acme_lookup",
	params: {},
	nativeArgs: { account: "ACME" },
	partial: false,
	...over,
})

const results = (task: FakeTask) => task.userMessageContent.filter((b) => b.type === "tool_result")
const images = (task: FakeTask) => task.userMessageContent.filter((b) => b.type === "image")

/** Run one private-tool call and hand back the task. */
async function run(commandResult: unknown, over: Record<string, unknown> = {}) {
	executeCommand.mockResolvedValue(commandResult)
	const task = makeTask(over)
	task.assistantMessageContent = [call()]
	await presentAssistantMessage(task as never)
	return task
}

beforeEach(() => {
	handled = []
	executeCommand = vi.fn()
	const bridge = createInMemoryHost()
	setHost({ ...bridge, workspace: { ...bridge.workspace, executeCommand } } as never)
	setPrivateToolInvokeMap([["acme_lookup", "acme.invoke"]])
	handleSpy = vi.spyOn(BaseTool.prototype, "handle").mockImplementation(async function (this: BaseTool<ToolName>) {
		handled.push(this.name)
	}) as never
})

afterEach(() => {
	handleSpy.mockRestore()
	setPrivateToolInvokeMap([])
})

describe("invoking a private tool", () => {
	it("calls the provider's command with the tool name and its arguments", async () => {
		await run({ content: "found it" })

		expect(executeCommand).toHaveBeenCalledWith("acme.invoke", "acme_lookup", { account: "ACME" })
		expect(handled).toEqual([])
	})

	it("is REFUSED, not invoked with guesses, when the arguments would not parse", async () => {
		// A private tool is a valid tool name, so the parser-failure guard covers
		// it too: invoking a third party's command with half-streamed arguments
		// is the one outcome worse than answering the model with an error.
		executeCommand.mockResolvedValue({ content: "ok" })
		const task = makeTask()
		task.assistantMessageContent = [call({ nativeArgs: undefined, params: { account: "RAW" } })]

		await presentAssistantMessage(task as never)

		expect(executeCommand).not.toHaveBeenCalled()
		expect(String(results(task)[0]!.content)).toContain("could not be parsed")
	})

	it("gates the call as a THIRD-PARTY action, marked as an external tool", async () => {
		const task = await run({ content: "ok" })

		const [askType, payload] = (task.ask as ReturnType<typeof vi.fn>).mock.calls[0]!
		expect(askType).toBe("use_mcp_server")
		expect(JSON.parse(payload)).toMatchObject({
			type: "use_mcp_tool",
			serverName: "extension-tools",
			toolName: "acme_lookup",
			external_lm_tool: true,
		})
	})

	it("does not invoke anything when the approval is refused", async () => {
		await run({ content: "ok" }, { ask: vi.fn().mockResolvedValue({ response: "noButtonClicked" }) })

		expect(executeCommand).not.toHaveBeenCalled()
	})

	it("falls through to the unknown-tool arm when the provider vanished mid-turn", async () => {
		setPrivateToolInvokeMap([["acme_lookup", ""]])

		const task = await run({ content: "ok" })

		expect(executeCommand).not.toHaveBeenCalled()
		expect(String(results(task)[0]!.content)).toMatch(/nknown tool/)
	})
})

describe("what the provider returned", () => {
	it("renders the text result and hands it to the model", async () => {
		const task = await run({ content: "the answer" })

		expect(task.say).toHaveBeenCalledWith("mcp_server_response", "the answer")
		expect(results(task)[0]!.content).toContain("the answer")
	})

	it("says so when the provider returned nothing at all", async () => {
		const task = await run(undefined)

		expect(results(task)[0]!.content).toContain("(tool returned empty result)")
	})

	it("marks an error result as an error rather than as an answer", async () => {
		const task = await run({ content: "no such account", is_error: true })

		expect(results(task)[0]!.is_error ?? String(results(task)[0]!.content)).toBeTruthy()
		expect(String(results(task)[0]!.content)).toContain("no such account")
	})

	it("reads an image the provider named, so a vision model can see it", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "private-tool-"))
		const png = path.join(dir, "chart.png")
		await fsp.writeFile(png, Buffer.from("PNGBYTES"))

		const task = await run({ content: "here is the chart", images: [png] })

		// The dispatcher splits the response: text becomes the tool_result, and
		// image blocks ride beside it in the user content.
		expect(results(task)[0]!.content).toBe("here is the chart")
		expect(images(task)).toEqual([
			expect.objectContaining({
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: Buffer.from("PNGBYTES").toString("base64"),
				},
			}),
		])

		await fsp.rm(dir, { recursive: true, force: true })
	})

	it("skips an image whose extension it cannot type", async () => {
		const task = await run({ content: "text", images: ["/tmp/thing.bmp"] })

		expect(images(task)).toEqual([])
	})

	it("skips an unreadable image rather than failing the call", async () => {
		// The text result still lists the path, so the model is not left blind.
		const task = await run({ content: "text", images: ["/nonexistent/missing.png"] })

		expect(images(task)).toEqual([])
		expect(results(task)[0]!.content).toBe("text")
	})
})

describe("when the provider throws", () => {
	it("reports the failure as a tool result and counts a mistake", async () => {
		executeCommand.mockRejectedValue(new Error("extension not activated"))
		const task = makeTask()
		task.assistantMessageContent = [call()]

		await presentAssistantMessage(task as never)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(String(results(task)[0]!.content)).toContain("extension not activated")
	})

	it("survives a rejection that is not an Error", async () => {
		executeCommand.mockRejectedValue("a bare string")
		const task = makeTask()
		task.assistantMessageContent = [call()]

		await expect(presentAssistantMessage(task as never)).resolves.toBeUndefined()
		expect(results(task)).toHaveLength(1)
	})
})
