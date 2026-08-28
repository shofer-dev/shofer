// npx vitest src/assistant-message/__tests__/presentAssistantMessage-custom-tool.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

import { setHost, createInMemoryHost, parametersSchema as z } from "@shofer/types"

import { presentAssistantMessage } from "../presentAssistantMessage.js"
import { validateToolUse } from "../../tools/validateToolUse.js"
import { customToolRegistry } from "../../custom-tools/custom-tool-registry.js"

// Mock dependencies
vi.mock("../../task/Task")

// The subject reaches its custom-tool registry and validator siblings via
// intra-core RELATIVE imports; only relative mocks (not the `@shofer/core`
// barrel) can intercept those calls.
vi.mock("../../tools/validateToolUse.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../tools/validateToolUse.js")>()),
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) =>
		["read_file", "write_to_file", "ask_followup_question", "attempt_completion", "use_mcp_tool"].includes(
			toolName,
		),
	),
}))

vi.mock("../../custom-tools/custom-tool-registry.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../custom-tools/custom-tool-registry.js")>()),
	customToolRegistry: {
		has: vi.fn(),
		get: vi.fn(),
		getDispatchable: vi.fn(),
		isDispatchable: vi.fn(),
		register: vi.fn(),
		getAll: vi.fn().mockReturnValue([]),
		getAllSerialized: vi.fn().mockReturnValue([]),
		loadFromDirectoriesIfStale: vi.fn().mockResolvedValue(undefined),
	},
}))

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

import { TelemetryService } from "@shofer/telemetry"

describe("presentAssistantMessage - Custom Tool Recording", () => {
	let mockTask: any

	beforeEach(() => {
		setHost(createInMemoryHost())
		// Reset all mocks
		vi.clearAllMocks()

		// Create a mock Task with minimal properties needed for testing
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
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: true, // Enable by default
						},
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		}

		// Add pushToolResultToUserContent method after mockTask is created so it can reference mockTask
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

	describe("Custom tool usage recording", () => {
		it("should record custom tool usage as 'custom_tool' when experiment is enabled", async () => {
			const toolCallId = "tool_call_custom_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "my_custom_tool",
					params: { value: "test" },
					partial: false,
				},
			]

			// Mock customToolRegistry to recognize this as a custom tool
			vi.mocked(customToolRegistry.isDispatchable).mockReturnValue(true)
			vi.mocked(customToolRegistry.getDispatchable).mockReturnValue({
				name: "my_custom_tool",
				description: "A custom tool",
				execute: vi.fn().mockResolvedValue("Custom tool result"),
			} as any)

			await presentAssistantMessage(mockTask)

			// Should record as "custom_tool", not "my_custom_tool"
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("custom_tool")
			expect(TelemetryService.instance.captureToolUsage).toHaveBeenCalledWith(mockTask.taskId, "custom_tool")
		})
	})

	/**
	 * Several providers stringify every scalar in a tool call, and a STUBBED
	 * tool's arguments are hand-written JSON the model produced for
	 * `arguments_json` (already unwrapped into `nativeArgs` by the parser). This
	 * is the reported live failure — `events_subscribe` with `"wake": "true"` and
	 * `"ttl_sec": "300"` — reproduced through the real dispatch path.
	 */
	describe("Custom tool argument coercion", () => {
		it("narrows stringified scalars to the types the schema declares", async () => {
			const execute = vi.fn().mockResolvedValue("subscribed")
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_events_subscribe",
					name: "events_subscribe",
					params: {},
					nativeArgs: { selector: "resource:vm-*", wake: "true", ttl_sec: "300" },
					partial: false,
				},
			]

			vi.mocked(customToolRegistry.isDispatchable).mockReturnValue(true)
			vi.mocked(customToolRegistry.getDispatchable).mockReturnValue({
				name: "events_subscribe",
				description: "Subscribe to bus events",
				parameters: z.object({
					selector: z.string(),
					wake: z.boolean().optional(),
					ttl_sec: z.number().optional(),
				}),
				execute,
			} as any)

			await presentAssistantMessage(mockTask)

			// It validated instead of failing, and the handler received real scalars.
			expect(mockTask.say).not.toHaveBeenCalledWith("error", expect.stringContaining("validation failed"))
			expect(execute).toHaveBeenCalledTimes(1)
			expect(execute.mock.calls[0]![0]).toEqual({
				selector: "resource:vm-*",
				wake: true,
				ttl_sec: 300,
			})
		})

		it("still reports a genuinely invalid argument", async () => {
			const execute = vi.fn().mockResolvedValue("never")
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_events_subscribe_bad",
					name: "events_subscribe",
					params: {},
					nativeArgs: { selector: "resource:vm-*", wake: "maybe" },
					partial: false,
				},
			]

			vi.mocked(customToolRegistry.isDispatchable).mockReturnValue(true)
			vi.mocked(customToolRegistry.getDispatchable).mockReturnValue({
				name: "events_subscribe",
				description: "Subscribe to bus events",
				parameters: z.object({ selector: z.string(), wake: z.boolean().optional() }),
				execute,
			} as any)

			await presentAssistantMessage(mockTask)

			expect(execute).not.toHaveBeenCalled()
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("validation failed"))
		})
	})

	describe("Custom tool error recording", () => {
		it("should record custom tool error as 'custom_tool'", async () => {
			const toolCallId = "tool_call_custom_error_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "failing_custom_tool",
					params: {},
					partial: false,
				},
			]

			// Mock customToolRegistry with a tool that throws an error
			vi.mocked(customToolRegistry.isDispatchable).mockReturnValue(true)
			vi.mocked(customToolRegistry.getDispatchable).mockReturnValue({
				name: "failing_custom_tool",
				description: "A failing custom tool",
				execute: vi.fn().mockRejectedValue(new Error("Custom tool execution failed")),
			} as any)

			await presentAssistantMessage(mockTask)

			// Should record error as "custom_tool", not "failing_custom_tool"
			expect(mockTask.recordToolError).toHaveBeenCalledWith("custom_tool", "Custom tool execution failed")
			expect(mockTask.consecutiveMistakeCount).toBe(1)
		})
	})

	describe("Regular tool recording", () => {
		it("should record regular tool usage with actual tool name", async () => {
			const toolCallId = "tool_call_read_file_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "read_file",
					params: { path: "test.txt" },
					partial: false,
				},
			]

			// read_file is not a custom tool
			vi.mocked(customToolRegistry.isDispatchable).mockReturnValue(false)

			await presentAssistantMessage(mockTask)

			// Should record as "read_file", not "custom_tool"
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("read_file")
			expect(TelemetryService.instance.captureToolUsage).toHaveBeenCalledWith(mockTask.taskId, "read_file")
		})

		it("should record MCP tool usage as 'use_mcp_tool' (not custom_tool)", async () => {
			const toolCallId = "tool_call_mcp_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "use_mcp_tool",
					params: {
						server_name: "test-server",
						tool_name: "test-tool",
						arguments: "{}",
					},
					partial: false,
				},
			]

			vi.mocked(customToolRegistry.isDispatchable).mockReturnValue(false)

			// Mock MCP hub for use_mcp_tool
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: true,
						},
					}),
					getMcpHub: () => ({
						findServerNameBySanitizedName: () => "test-server",
						executeToolCall: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] }),
					}),
				}),
			}

			await presentAssistantMessage(mockTask)

			// Should record as "use_mcp_tool", not "custom_tool"
			expect(mockTask.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
			expect(TelemetryService.instance.captureToolUsage).toHaveBeenCalledWith(mockTask.taskId, "use_mcp_tool")
		})
	})

	describe("Custom tool experiment gate", () => {
		it("should treat custom tool as unknown when experiment is disabled", async () => {
			const toolCallId = "tool_call_disabled_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "my_custom_tool",
					params: {},
					partial: false,
				},
			]

			// Mock provider state with customTools experiment DISABLED
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: false, // Disabled
						},
					}),
				}),
			}

			// The experiment gate now lives inside isDispatchable/getDispatchable:
			// with customTools disabled, a (non-plugin) custom tool is not
			// dispatchable, so both report "not a custom tool".
			vi.mocked(customToolRegistry.isDispatchable).mockReturnValue(false)
			vi.mocked(customToolRegistry.getDispatchable).mockReturnValue(undefined)

			await presentAssistantMessage(mockTask)

			// Should be treated as unknown tool (not executed)
			expect(mockTask.say).toHaveBeenCalledWith("error", "unknownToolError")
			expect(mockTask.consecutiveMistakeCount).toBe(1)

			// Custom tool should NOT have been executed
			const getMock = vi.mocked(customToolRegistry.getDispatchable)
			if (getMock.mock.results.length > 0) {
				const customTool = getMock.mock.results[0]!.value
				if (customTool) {
					expect(customTool.execute).not.toHaveBeenCalled()
				}
			}
		})

		it("should not call customToolRegistry.has() when experiment is disabled", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_123",
					name: "some_tool",
					params: {},
					partial: false,
				},
			]

			// Disable experiment
			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: false,
						},
					}),
				}),
			}

			await presentAssistantMessage(mockTask)

			// When experiment is off, shouldn't even check the registry
			// (Code checks stateExperiments?.customTools before calling has())
			expect(customToolRegistry.has).not.toHaveBeenCalled()
		})
	})

	describe("Validation requirements", () => {
		it("normalizes disabledTools aliases before validateToolUse", async () => {
			const toolCallId = "tool_call_validation_alias_123"
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: toolCallId,
					name: "some_unknown_tool",
					params: {},
					partial: false,
				},
			]

			mockTask.providerRef = {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {
							customTools: false,
						},
						disabledTools: ["search_and_replace"],
					}),
				}),
			}

			await presentAssistantMessage(mockTask)

			const validateToolUseMock = vi.mocked(validateToolUse)
			expect(validateToolUseMock).toHaveBeenCalled()
			const toolRequirements = validateToolUseMock.mock.calls[0]![3]
			expect(toolRequirements).toMatchObject({
				search_and_replace: false,
				edit: false,
			})
		})
	})

	describe("Partial blocks", () => {
		it("should not record usage for partial custom tool blocks", async () => {
			mockTask.assistantMessageContent = [
				{
					type: "tool_use",
					id: "tool_call_partial_123",
					name: "my_custom_tool",
					params: { value: "test" },
					partial: true, // Still streaming
				},
			]

			vi.mocked(customToolRegistry.isDispatchable).mockReturnValue(true)

			await presentAssistantMessage(mockTask)

			// Should not record usage for partial blocks
			expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
			expect(TelemetryService.instance.captureToolUsage).not.toHaveBeenCalled()
		})
	})
})
