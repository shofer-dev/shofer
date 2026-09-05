// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-missing-nativeArgs.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage.js"
import { NativeToolCallParser } from "../NativeToolCallParser.js"

// ---------------------------------------------------------------------------
// Mock dependencies — minimal set, identical pattern to
// presentAssistantMessage-unknown-tool.spec.ts
// ---------------------------------------------------------------------------
vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../tools/validateToolUse.js")>()),
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

describe("presentAssistantMessage — missing nativeArgs guard (§C)", () => {
	let mockTask: any

	beforeEach(() => {
		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [],
			userMessageContent: [],
			didCompleteReadingStream: false,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			shoferMessages: [],
			api: {
				getModel: () => ({ id: "test-model", info: {} }),
			},
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			// A tool call that is abandoned before it executes withdraws the ask its
			// streaming arguments already rendered (Task.withdrawStreamedToolAsk).
			withdrawStreamedToolAsk: vi.fn().mockResolvedValue(undefined),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		}

		// pushToolResultToUserContent — bound after mock construction
		mockTask.pushToolResultToUserContent = vi.fn().mockImplementation((toolResult: any) => {
			const existingResult = mockTask.userMessageContent.find(
				(block: any) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
			)
			if (existingResult) {
				return false
			}
			mockTask.userMessageContent.push(toolResult)
			return true
		})
	})

	// -----------------------------------------------------------------------
	// REGRESSION TEST — the bug described in docs/tool-call-failures.md §B / §C
	//
	// When the streaming parser's finalizeStreamingToolCall() returns null
	// (malformed JSON / missing required param), Task.ts now clears the stale
	// partial nativeArgs left behind by createPartialToolUse.  The guard at
	// presentAssistantMessage.ts:572 checks:
	//
	//     isKnownTool && !block.nativeArgs && !customTool
	//
	// If nativeArgs is *not* cleared (old bug), the guard skips and the tool
	// is silently dispatched with incomplete args.
	//
	// This test drives presentAssistantMessage with the same state the
	// fixed null-branches produce: a known tool, non-partial, no nativeArgs.
	// -----------------------------------------------------------------------

	it("should surface error when a known tool has no nativeArgs (streaming null-branch)", async () => {
		const toolCallId = "toolu_stale_partial_001"

		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "read_file",
				params: {},
				partial: false,
				// Intentionally no nativeArgs — simulating what the fixed
				// null-branch produces after clearing the stale partial.
			},
		]

		await presentAssistantMessage(mockTask)

		// Guard must fire → say("error", …)
		expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Tool call 'read_file' failed"))

		// Mistake counter incremented
		expect(mockTask.consecutiveMistakeCount).toBe(1)

		// recordToolError called
		expect(mockTask.recordToolError).toHaveBeenCalledWith(
			"read_file",
			expect.stringContaining("Tool call 'read_file' failed"),
		)

		// is_error tool_result pushed so the LLM can self-correct
		const toolResult = mockTask.userMessageContent.find(
			(item: any) => item.type === "tool_result" && item.tool_use_id === toolCallId,
		)
		expect(toolResult).toBeDefined()
		expect(toolResult.is_error).toBe(true)
	})

	// -----------------------------------------------------------------------
	// CONVERSE: prove that a truthy (stale) nativeArgs defeats the guard.
	// This is the bug scenario — without the fix, this test would show
	// the tool being dispatched instead of errored.
	// -----------------------------------------------------------------------
	it("should NOT fire the guard when nativeArgs is truthy (stale partial)", async () => {
		const toolCallId = "toolu_stale_partial_002"

		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "read_file",
				params: {},
				partial: false,
				nativeArgs: { path: "test.ts" }, // stale partial from createPartialToolUse
			},
		]

		await presentAssistantMessage(mockTask)

		// The guard should NOT fire — nativeArgs is truthy, so the block
		// falls through to dispatch.  We assert that no error was surfaced
		// via the guard path.
		const guardErrorCalls = (mockTask.say as ReturnType<typeof vi.fn>).mock.calls.filter(
			([askType, msg]: any[]) =>
				askType === "error" && typeof msg === "string" && msg.includes("Tool call 'read_file' failed"),
		)
		expect(guardErrorCalls).toHaveLength(0)

		// consecutiveMistakeCount should NOT have been incremented by the guard
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// -----------------------------------------------------------------------
	// EDGE CASE: multiple tools, one with missing nativeArgs, one valid.
	// The guard should only fire for the broken one.
	// -----------------------------------------------------------------------
	it("should handle mixed blocks: only error on the one missing nativeArgs", async () => {
		const badId = "toolu_bad_003"
		const goodId = "toolu_good_003"

		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: badId,
				name: "read_file",
				params: {},
				partial: false,
				// no nativeArgs → guard should fire
			},
			{
				type: "tool_use",
				id: goodId,
				name: "read_file",
				params: {},
				partial: false,
				nativeArgs: { path: "good.ts" },
			},
		]

		await presentAssistantMessage(mockTask)

		// The guard error was surfaced exactly once (for the bad block)
		const guardErrorCalls = (mockTask.say as ReturnType<typeof vi.fn>).mock.calls.filter(
			([askType, msg]: any[]) =>
				askType === "error" && typeof msg === "string" && msg.includes("Tool call 'read_file' failed"),
		)
		expect(guardErrorCalls).toHaveLength(1)

		// Error tool_result for the bad tool
		const badResult = mockTask.userMessageContent.find(
			(item: any) => item.type === "tool_result" && item.tool_use_id === badId,
		)
		expect(badResult).toBeDefined()
		expect(badResult.is_error).toBe(true)

		// Good tool was dispatched (tool_result may or may not exist depending on approval)
		expect(mockTask.consecutiveMistakeCount).toBe(1)
	})

	// -----------------------------------------------------------------------
	// ERROR MESSAGE QUALITY: the error message must be actionable for the LLM.
	// It should include the tool name, the parse error, a snippet of the
	// malformed arguments, and explicit retry guidance — not just "missing
	// nativeArgs" which is an internal implementation detail.
	// -----------------------------------------------------------------------
	it("should produce an actionable error message with retry guidance", async () => {
		const toolCallId = "toolu_actionable_msg"

		// Set a parse error as if JSON.parse failed on malformed arguments
		NativeToolCallParser.lastParseError =
			"The arguments for tool 'write_to_file' are not valid JSON: " +
			"Expected ':' after property name in JSON at position 7. " +
			'Received 50 character(s) of arguments: "{\\"path\\" \\"s3-proxy/go.mod\\"...". ' +
			"Re-emit the tool call with properly formatted JSON arguments..."

		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: toolCallId,
				name: "write_to_file",
				params: { path: "s3-proxy/go.mod" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask)

		const errorCall = (mockTask.say as ReturnType<typeof vi.fn>).mock.calls.find(
			([askType]: any[]) => askType === "error",
		)
		expect(errorCall).toBeDefined()
		const msg = errorCall![1] as string

		// Must start with the tool name for quick identification
		expect(msg).toContain("Tool call 'write_to_file' failed")
		// Must include the parse error so the LLM knows what's wrong
		expect(msg).toContain("not valid JSON")
		// Must include retry guidance
		expect(msg).toContain("Re-emit")
		// Must include partial params if available
		expect(msg).toContain("Partial params")
	})
})
