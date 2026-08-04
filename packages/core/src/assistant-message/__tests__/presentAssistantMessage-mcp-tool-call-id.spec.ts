// npx vitest src/assistant-message/__tests__/presentAssistantMessage-mcp-tool-call-id.spec.ts

/**
 * The provider's tool-call id has to survive the whole hop from the model's
 * `tool_calls[].id` to the MCP request, unmodified: a broker records the call
 * under it, the transcript records the same id, and the two accounts of one tool
 * use are joinable only while both hold the identical string.
 *
 * The hazard these tests exist for is that the SAME id is deliberately rewritten
 * on the neighbouring leg — `sanitizeToolUseId` maps `[^a-zA-Z0-9_-]` to `_` for
 * the `tool_result` the API validates — so a plausible-looking implementation
 * that reuses the sanitized value breaks the join without breaking anything
 * visible.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

import { presentAssistantMessage } from "../presentAssistantMessage.js"
import { sanitizeToolUseId } from "../../utils/tool-id.js"

vi.mock("../../task/Task")
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

// An id using every character class the sanitizer rewrites, so a sanitized copy
// is unmistakably a different string.
const RAW_TOOL_CALL_ID = "call:abc/1+2=3"

describe("presentAssistantMessage — provider tool-call id reaches the MCP request", () => {
	let mockTask: any
	let callTool: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.clearAllMocks()
		callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] })

		const mcpHub = {
			callTool,
			getAllServers: vi.fn().mockReturnValue([
				{
					name: "arkware",
					tools: [{ name: "gitlab" }],
				},
			]),
			findServerNameBySanitizedName: vi.fn().mockReturnValue("arkware"),
		}

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
			lastMessageTs: 1,
			api: { getModel: () => ({ id: "test-model", info: {} }) },
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [], experiments: {} }),
					getMcpHub: () => mcpHub,
					postMessageToWebview: vi.fn(),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			pushToolResultToUserContent: vi.fn().mockImplementation((toolResult: any) => {
				mockTask.userMessageContent.push(toolResult)
				return true
			}),
		}
	})

	it("forwards the raw id for a native dynamic MCP tool call", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "mcp_tool_use",
				id: RAW_TOOL_CALL_ID,
				name: "mcp_arkware_gitlab",
				serverName: "arkware",
				toolName: "gitlab",
				arguments: { operation: "list" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask)

		expect(callTool).toHaveBeenCalledTimes(1)
		// callTool(serverName, toolName, args, source, taskId, toolCallId, signal)
		const [, , , , taskId, forwardedId] = callTool.mock.calls[0]!
		expect(taskId).toBe("test-task-id")
		expect(forwardedId).toBe(RAW_TOOL_CALL_ID)
		expect(forwardedId).not.toBe(sanitizeToolUseId(RAW_TOOL_CALL_ID))
	})

	it("keeps the sanitized id on the tool_result leg, so the two legs are not the same string", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "mcp_tool_use",
				id: RAW_TOOL_CALL_ID,
				name: "mcp_arkware_gitlab",
				serverName: "arkware",
				toolName: "gitlab",
				arguments: {},
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask)

		const toolResult = mockTask.userMessageContent.find((b: any) => b.type === "tool_result")
		expect(toolResult).toBeDefined()
		// The API leg needs the sanitized form; the broker leg needs the raw one.
		// Asserting both together is what pins down that they are handled apart.
		expect(toolResult.tool_use_id).toBe(sanitizeToolUseId(RAW_TOOL_CALL_ID))
		expect(callTool.mock.calls[0]![5]).toBe(RAW_TOOL_CALL_ID)
	})
})
