// npx vitest core/tools/__tests__/waitForMcpCallTool.spec.ts

import { waitForMcpCallTool } from "../WaitForMcpCallTool"
import { Task, type McpAsyncCallHandle } from "../../task/Task"
import { ToolUse } from "../../../shared/tools"

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((result: string) => `Tool result: ${result}`),
		toolError: vi.fn((error: string) => `Tool error: ${error}`),
	},
}))

vi.mock("../../../i18n", () => ({ t: vi.fn((k: string) => k) }))

const captureMcpAsyncCallTimedOut = vi.fn()

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureMcpAsyncCallTimedOut: (...a: unknown[]) => captureMcpAsyncCallTimedOut(...a),
		},
	},
}))

function buildHandle(callId: string, promise: Promise<any>): McpAsyncCallHandle {
	return {
		callId,
		serverName: "srv",
		toolName: "echo",
		status: "running",
		promise,
		abortController: new AbortController(),
		createdAt: Date.now(),
	}
}

function buildTask(handles: McpAsyncCallHandle[]): Partial<Task> {
	return {
		taskId: "task-1",
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
		mcpAsyncCalls: new Map(handles.map((h) => [h.callId, h] as const)),
	}
}

const block = (nativeArgs: {
	call_ids: string[]
	wait?: "all" | "any"
	timeout?: number
}): ToolUse<"wait_for_mcp_call"> =>
	({
		type: "tool_use",
		name: "wait_for_mcp_call",
		params: {},
		nativeArgs,
		partial: false,
	}) as ToolUse<"wait_for_mcp_call">

describe("waitForMcpCallTool", () => {
	beforeEach(() => captureMcpAsyncCallTimedOut.mockClear())

	it("returns error envelope when none of the call_ids are known", async () => {
		const task = buildTask([])
		const pushToolResult = vi.fn()
		await waitForMcpCallTool.handle(task as Task, block({ call_ids: ["nope"] }) as any, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult,
		})
		const payload = JSON.parse((pushToolResult.mock.calls[0][0] as string).replace(/^Tool result: /, ""))
		expect(payload.error).toMatch(/None of the provided call_ids/)
	})

	it("wait='all' returns when all settle, deletes settled handles from the map", async () => {
		const p1 = Promise.resolve({ isError: false, content: [{ type: "text", text: "a" }] })
		const p2 = Promise.resolve({ isError: false, content: [{ type: "text", text: "b" }] })
		const h1 = buildHandle("c1", p1)
		const h2 = buildHandle("c2", p2)
		const task = buildTask([h1, h2])
		const pushToolResult = vi.fn()
		await waitForMcpCallTool.handle(
			task as Task,
			block({ call_ids: ["c1", "c2"], wait: "all", timeout: 5 }) as any,
			{ askApproval: vi.fn(), handleError: vi.fn(), pushToolResult },
		)
		const payload = JSON.parse((pushToolResult.mock.calls[0][0] as string).replace(/^Tool result: /, ""))
		expect(payload).toHaveLength(2)
		expect(payload.every((r: any) => r.status === "completed")).toBe(true)
		expect(task.mcpAsyncCalls!.size).toBe(0)
		expect(captureMcpAsyncCallTimedOut).not.toHaveBeenCalled()
	})

	it("emits structured 'timeout' status per unsettled call, fires telemetry, keeps handle in map", async () => {
		const pendingPromise = new Promise<any>(() => {}) // never resolves
		const h1 = buildHandle("c1", pendingPromise)
		const task = buildTask([h1])
		const pushToolResult = vi.fn()
		// timeout=1 means 1 second; we patch setTimeout to fire synchronously via fake timers.
		vi.useFakeTimers()
		const handlePromise = waitForMcpCallTool.handle(
			task as Task,
			block({ call_ids: ["c1"], wait: "all", timeout: 1 }) as any,
			{ askApproval: vi.fn(), handleError: vi.fn(), pushToolResult },
		)
		await vi.advanceTimersByTimeAsync(1100)
		await handlePromise
		vi.useRealTimers()
		const payload = JSON.parse((pushToolResult.mock.calls[0][0] as string).replace(/^Tool result: /, ""))
		expect(payload[0].status).toBe("timeout")
		expect(captureMcpAsyncCallTimedOut).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ callId: "c1", timeoutSec: 1 }),
		)
		// Unsettled handle stays in the map so a subsequent check/wait can observe it.
		expect(task.mcpAsyncCalls!.has("c1")).toBe(true)
	})

	it("wait='any' returns as soon as the first call settles", async () => {
		const p1 = Promise.resolve({ isError: false, content: [{ type: "text", text: "fast" }] })
		const pendingPromise = new Promise<any>(() => {})
		const h1 = buildHandle("c1", p1)
		const h2 = buildHandle("c2", pendingPromise)
		const task = buildTask([h1, h2])
		const pushToolResult = vi.fn()
		vi.useFakeTimers()
		const handlePromise = waitForMcpCallTool.handle(
			task as Task,
			block({ call_ids: ["c1", "c2"], wait: "any", timeout: 60 }) as any,
			{ askApproval: vi.fn(), handleError: vi.fn(), pushToolResult },
		)
		// Let microtask queue drain so p1 resolves before any timer fires.
		await vi.advanceTimersByTimeAsync(0)
		await handlePromise
		vi.useRealTimers()
		const payload = JSON.parse((pushToolResult.mock.calls[0][0] as string).replace(/^Tool result: /, ""))
		const byId = Object.fromEntries(payload.map((r: any) => [r.call_id, r]))
		expect(byId["c1"].status).toBe("completed")
		expect(byId["c2"].status).toBe("timeout")
		// c1 settled → deleted; c2 unsettled (timeout) → retained.
		expect(task.mcpAsyncCalls!.has("c1")).toBe(false)
		expect(task.mcpAsyncCalls!.has("c2")).toBe(true)
	})
})
