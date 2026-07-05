// npx vitest src/assistant-message/__tests__/presentAssistantMessage-lifecycle.spec.ts
//
// Phase 3 (design §6.9): `beforeToolCall` / `afterToolCall` lifecycle hooks are
// wired at the tool-execution boundary in presentAssistantMessage. These tests
// prove: a block short-circuits the tool, param modification reaches the tool,
// the result is transformed in place, and — critically — with NO lifecycle plugin
// the tool path is untouched (the fast-path guard).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import { setHost, createInMemoryHost, type ShoferPlugin } from "@shofer/types"

import { presentAssistantMessage } from "../presentAssistantMessage.js"
import { customToolRegistry } from "../../custom-tools/custom-tool-registry.js"
import { pluginRegistry } from "../../plugins/plugin-registry.js"

vi.mock("../../task/Task")

vi.mock("../../tools/validateToolUse.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../tools/validateToolUse.js")>()),
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => false),
}))

vi.mock("../../custom-tools/custom-tool-registry.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../custom-tools/custom-tool-registry.js")>()),
	customToolRegistry: {
		has: vi.fn(),
		get: vi.fn(),
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
			captureEvent: vi.fn(),
		},
	},
}))

const registered: string[] = []

/** Register a lifecycle plugin into the shared registry (with the grant) for one test. */
async function useLifecyclePlugin(plugin: ShoferPlugin): Promise<void> {
	await pluginRegistry.register(plugin, {}, { lifecycle: true })
	registered.push(plugin.name)
}

function makeMockTask(): any {
	const mockTask: any = {
		taskId: "test-task-id",
		instanceId: "test-instance",
		cwd: "/work",
		_taskMode: "code",
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
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
		providerRef: {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({
					mode: "code",
					customModes: [],
					experiments: { customTools: true },
				}),
			}),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
	}
	mockTask.pushToolResultToUserContent = vi.fn().mockImplementation((toolResult: any) => {
		mockTask.userMessageContent.push(toolResult)
		return true
	})
	return mockTask
}

function toolUseBlock(name: string, args: Record<string, unknown>): any {
	return { type: "tool_use", id: `call_${name}`, name, params: args, nativeArgs: args, partial: false }
}

describe("presentAssistantMessage — lifecycle hooks (design §6.9, Phase 3)", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		vi.clearAllMocks()
	})

	afterEach(() => {
		for (const name of registered.splice(0)) pluginRegistry.unregister(name)
	})

	it("beforeToolCall block short-circuits the tool (execute not called, denial pushed)", async () => {
		const execute = vi.fn().mockResolvedValue("should not run")
		vi.mocked(customToolRegistry.get).mockReturnValue({
			name: "danger",
			description: "d",
			parameters: { parse: (x: unknown) => x } as any,
			execute,
		} as any)

		await useLifecyclePlugin({
			name: "policy",
			lifecycle: { beforeToolCall: () => ({ allow: false, reason: "danger blocked" }) },
		})

		const task = makeMockTask()
		task.assistantMessageContent = [toolUseBlock("danger", { cmd: "rm -rf /" })]
		await presentAssistantMessage(task)

		expect(execute).not.toHaveBeenCalled()
		const result = task.userMessageContent.find((b: any) => b.type === "tool_result")
		expect(result).toBeDefined()
		expect(String(result.content)).toContain("danger blocked")
	})

	it("beforeToolCall modifiedArgs reach the tool", async () => {
		const execute = vi.fn().mockResolvedValue("ok")
		vi.mocked(customToolRegistry.get).mockReturnValue({
			name: "echo",
			description: "d",
			parameters: { parse: (x: unknown) => x } as any,
			execute,
		} as any)

		await useLifecyclePlugin({
			name: "modifier",
			lifecycle: {
				beforeToolCall: (_name, args) => ({ allow: true, modifiedArgs: { ...args, injected: true } }),
			},
		})

		const task = makeMockTask()
		task.assistantMessageContent = [toolUseBlock("echo", { original: 1 })]
		await presentAssistantMessage(task)

		expect(execute).toHaveBeenCalledTimes(1)
		expect(execute.mock.calls[0]![0]).toEqual({ original: 1, injected: true })
	})

	it("afterToolCall transforms the pushed result in place", async () => {
		vi.mocked(customToolRegistry.get).mockReturnValue({
			name: "greet",
			description: "d",
			parameters: { parse: (x: unknown) => x } as any,
			execute: vi.fn().mockResolvedValue("original-result"),
		} as any)

		await useLifecyclePlugin({
			name: "transformer",
			lifecycle: { afterToolCall: (_n, _a, result) => `[wrapped] ${result}` },
		})

		const task = makeMockTask()
		task.assistantMessageContent = [toolUseBlock("greet", {})]
		await presentAssistantMessage(task)

		const result = task.userMessageContent.find((b: any) => b.type === "tool_result")
		expect(result.content).toBe("[wrapped] original-result")
	})

	it("fast-path: with no lifecycle plugin the tool runs and result is untouched", async () => {
		const execute = vi.fn().mockResolvedValue("plain-result")
		vi.mocked(customToolRegistry.get).mockReturnValue({
			name: "plain",
			description: "d",
			parameters: { parse: (x: unknown) => x } as any,
			execute,
		} as any)

		const task = makeMockTask()
		task.assistantMessageContent = [toolUseBlock("plain", { a: 1 })]
		await presentAssistantMessage(task)

		expect(execute).toHaveBeenCalledTimes(1)
		expect(execute.mock.calls[0]![0]).toEqual({ a: 1 })
		const result = task.userMessageContent.find((b: any) => b.type === "tool_result")
		expect(result.content).toBe("plain-result")
	})
})
