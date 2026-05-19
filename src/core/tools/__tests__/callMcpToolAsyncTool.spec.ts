// npx vitest core/tools/__tests__/callMcpToolAsyncTool.spec.ts

import { callMcpToolAsyncTool } from "../CallMcpToolAsyncTool"
import { Task, type McpAsyncCallHandle } from "../../task/Task"
import { ToolUse } from "../../../shared/tools"

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((result: string) => `Tool result: ${result}`),
		toolError: vi.fn((error: string) => `Tool error: ${error}`),
		unknownMcpToolError: vi.fn((s: string, t: string) => `unknown tool ${s}:${t}`),
		unknownMcpServerError: vi.fn((s: string) => `unknown server ${s}`),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

const captureMcpAsyncCallStarted = vi.fn()
const captureMcpAsyncCallCompleted = vi.fn()

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureMcpAsyncCallStarted: (...a: unknown[]) => captureMcpAsyncCallStarted(...a),
			captureMcpAsyncCallCompleted: (...a: unknown[]) => captureMcpAsyncCallCompleted(...a),
		},
	},
}))

// Forwards source through to callTool; resolves with provided result.
const mockCallTool = vi.fn()

function buildMockTask(): Partial<Task> {
	const mcpHub = {
		callTool: mockCallTool,
		getAllServers: vi.fn().mockReturnValue([
			{
				name: "srv",
				tools: [{ name: "echo", enabledForPrompt: true }],
			},
		]),
	}
	return {
		taskId: "task-1",
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn(),
		say: vi.fn(),
		ask: vi.fn(),
		lastMessageTs: 1,
		mcpAsyncCalls: new Map<string, McpAsyncCallHandle>(),
		providerRef: { deref: () => ({ getMcpHub: () => mcpHub, postMessageToWebview: vi.fn() }) } as any,
		abortSignal: new AbortController().signal,
	}
}

describe("callMcpToolAsyncTool", () => {
	beforeEach(() => {
		captureMcpAsyncCallStarted.mockClear()
		captureMcpAsyncCallCompleted.mockClear()
		mockCallTool.mockReset()
	})

	const baseBlock = (overrides: Record<string, unknown> = {}): ToolUse<"call_mcp_tool_async"> =>
		({
			type: "tool_use",
			name: "call_mcp_tool_async",
			params: {},
			nativeArgs: { server_name: "srv", tool_name: "echo", arguments: { x: 1 }, ...overrides },
			partial: false,
		}) as ToolUse<"call_mcp_tool_async">

	it("rejects missing server_name", async () => {
		const task = buildMockTask()
		task.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("missing server")
		const pushToolResult = vi.fn()
		await callMcpToolAsyncTool.handle(task as Task, baseBlock({ server_name: "" }) as any, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult,
		})
		expect(task.consecutiveMistakeCount).toBe(1)
		expect(pushToolResult).toHaveBeenCalledWith("missing server")
		expect(task.mcpAsyncCalls!.size).toBe(0)
	})

	it("stores handle, fires Started telemetry, and forwards source to callTool", async () => {
		const task = buildMockTask()
		let resolveCall!: (v: any) => void
		mockCallTool.mockImplementation(
			() =>
				new Promise((res) => {
					resolveCall = res
				}),
		)
		const pushToolResult = vi.fn()
		await callMcpToolAsyncTool.handle(task as Task, baseBlock({ source: "project" }) as any, {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult,
		})
		expect(mockCallTool).toHaveBeenCalledWith("srv", "echo", { x: 1 }, "project", "task-1", expect.anything())
		expect(task.mcpAsyncCalls!.size).toBe(1)
		const handle = [...task.mcpAsyncCalls!.values()][0]
		expect(handle.status).toBe("running")
		expect(captureMcpAsyncCallStarted).toHaveBeenCalledWith("task-1", {
			callId: handle.callId,
			serverName: "srv",
			toolName: "echo",
		})
		// Resolve and verify finalizer fires Completed telemetry.
		resolveCall({ isError: false, content: [{ type: "text", text: "ok" }] })
		await handle.promise
		await new Promise((r) => setImmediate(r))
		expect(handle.status).toBe("completed")
		expect(captureMcpAsyncCallCompleted).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ callId: handle.callId, isError: false }),
		)
	})

	it("finalizer sets error message when MCP server returns undefined", async () => {
		const task = buildMockTask()
		mockCallTool.mockResolvedValue(undefined)
		await callMcpToolAsyncTool.handle(task as Task, baseBlock() as any, {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		})
		const handle = [...task.mcpAsyncCalls!.values()][0]
		await handle.promise
		await new Promise((r) => setImmediate(r))
		expect(handle.status).toBe("error")
		expect(handle.error).toBe("MCP server returned no response")
		expect(captureMcpAsyncCallCompleted).toHaveBeenCalledWith("task-1", expect.objectContaining({ isError: true }))
	})

	it("finalizer is guarded by status === 'running' (does not overwrite cancelled)", async () => {
		const task = buildMockTask()
		let resolveCall!: (v: any) => void
		mockCallTool.mockImplementation(
			() =>
				new Promise((res) => {
					resolveCall = res
				}),
		)
		await callMcpToolAsyncTool.handle(task as Task, baseBlock() as any, {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		})
		const handle = [...task.mcpAsyncCalls!.values()][0]
		// External code cancels the handle before the underlying promise settles.
		handle.status = "cancelled"
		resolveCall({ isError: false, content: [] })
		await handle.promise
		await new Promise((r) => setImmediate(r))
		expect(handle.status).toBe("cancelled")
	})
})
