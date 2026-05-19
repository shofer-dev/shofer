// npx vitest core/tools/__tests__/checkMcpCallStatusTool.spec.ts

import { checkMcpCallStatusTool } from "../CheckMcpCallStatusTool"
import { Task, type McpAsyncCallHandle } from "../../task/Task"
import { ToolUse } from "../../../shared/tools"

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((result: string) => `Tool result: ${result}`),
		toolError: vi.fn((error: string) => `Tool error: ${error}`),
	},
}))

vi.mock("../../../i18n", () => ({ t: vi.fn((k: string) => k) }))

function buildHandle(overrides: Partial<McpAsyncCallHandle> = {}): McpAsyncCallHandle {
	return {
		callId: "mcp-1",
		serverName: "srv",
		toolName: "echo",
		status: "running",
		promise: Promise.resolve(undefined),
		abortController: new AbortController(),
		createdAt: Date.now(),
		...overrides,
	}
}

function buildTask(handles: McpAsyncCallHandle[] = []): Partial<Task> {
	const map = new Map(handles.map((h) => [h.callId, h] as const))
	return {
		taskId: "task-1",
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
		mcpAsyncCalls: map,
	}
}

const block = (call_id: string): ToolUse<"check_mcp_call_status"> =>
	({
		type: "tool_use",
		name: "check_mcp_call_status",
		params: {},
		nativeArgs: { call_id },
		partial: false,
	}) as ToolUse<"check_mcp_call_status">

describe("checkMcpCallStatusTool", () => {
	it("returns 'not_found' for unknown call_id and does not throw", async () => {
		const task = buildTask()
		const pushToolResult = vi.fn()
		await checkMcpCallStatusTool.handle(task as Task, block("missing-id") as any, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult,
		})
		const payload = JSON.parse((pushToolResult.mock.calls[0][0] as string).replace(/^Tool result: /, ""))
		expect(payload.status).toBe("not_found")
	})

	it("returns running status without deleting the handle", async () => {
		const handle = buildHandle({ status: "running" })
		const task = buildTask([handle])
		const pushToolResult = vi.fn()
		await checkMcpCallStatusTool.handle(task as Task, block(handle.callId) as any, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult,
		})
		const payload = JSON.parse((pushToolResult.mock.calls[0][0] as string).replace(/^Tool result: /, ""))
		expect(payload.status).toBe("running")
		expect(task.mcpAsyncCalls!.has(handle.callId)).toBe(true)
	})

	it("deletes handle on read when settled (completed)", async () => {
		const handle = buildHandle({
			status: "completed",
			result: { isError: false, content: [{ type: "text", text: "ok" }] } as any,
		})
		const task = buildTask([handle])
		const pushToolResult = vi.fn()
		await checkMcpCallStatusTool.handle(task as Task, block(handle.callId) as any, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult,
		})
		const payload = JSON.parse((pushToolResult.mock.calls[0][0] as string).replace(/^Tool result: /, ""))
		expect(payload.status).toBe("completed")
		expect(payload.result).toContain("ok")
		expect(task.mcpAsyncCalls!.has(handle.callId)).toBe(false)
	})

	it("deletes handle on read when settled (error)", async () => {
		const handle = buildHandle({ status: "error", error: "boom" })
		const task = buildTask([handle])
		const pushToolResult = vi.fn()
		await checkMcpCallStatusTool.handle(task as Task, block(handle.callId) as any, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult,
		})
		expect(task.mcpAsyncCalls!.has(handle.callId)).toBe(false)
	})

	it("deletes handle on read when cancelled", async () => {
		const handle = buildHandle({ status: "cancelled" })
		const task = buildTask([handle])
		const pushToolResult = vi.fn()
		await checkMcpCallStatusTool.handle(task as Task, block(handle.callId) as any, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult,
		})
		expect(task.mcpAsyncCalls!.has(handle.callId)).toBe(false)
	})
})
