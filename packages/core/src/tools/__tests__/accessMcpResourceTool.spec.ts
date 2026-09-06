import { AccessMcpResourceTool } from "../accessMcpResourceTool.js"
import { makeToolCallbacks, toolResults } from "./helpers/fakeEditTask.js"

/**
 * `access_mcp_resource` reads a resource through the hub and renders it back.
 *
 * Two things are load-bearing beyond the happy path: the abort signal reaches
 * `readResource` (the Cooperative Cancellation Rule — a long read must be
 * cancellable), and image contents are turned into data URIs exactly once,
 * whether or not the server already sent one.
 */

function buildTask(readResource: unknown, overrides: Record<string, any> = {}) {
	const abortSignal = new AbortController().signal
	return {
		taskId: "task-1",
		consecutiveMistakeCount: 0,
		abortSignal,
		say: vi.fn().mockResolvedValue(undefined),
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn(async (tool: string, param: string) => `Missing ${param} for ${tool}`),
		providerRef: { deref: () => ({ getMcpHub: () => ({ readResource }) }) },
		...overrides,
	} as any
}

describe("AccessMcpResourceTool", () => {
	it("joins text contents and threads the task's abort signal to the hub", async () => {
		const readResource = vi.fn().mockResolvedValue({
			contents: [{ text: "first" }, { text: "" }, { text: "second" }],
		})
		const task = buildTask(readResource)
		const cbs = makeToolCallbacks()

		await new AccessMcpResourceTool().execute({ server_name: "srv", uri: "res://x" }, task, cbs)

		expect(readResource).toHaveBeenCalledWith("srv", "res://x", undefined, task.abortSignal)
		expect(task.say).toHaveBeenCalledWith("mcp_server_request_started")
		expect(toolResults(cbs)).toContain("first\n\nsecond")
	})

	it("reports an empty response rather than an empty string", async () => {
		const task = buildTask(vi.fn().mockResolvedValue({ contents: [] }))
		const cbs = makeToolCallbacks()

		await new AccessMcpResourceTool().execute({ server_name: "srv", uri: "res://x" }, task, cbs)

		expect(toolResults(cbs)).toContain("(Empty response)")
	})

	it("wraps a raw image blob in a data URI and passes an existing one through", async () => {
		const task = buildTask(
			vi.fn().mockResolvedValue({
				contents: [
					{ mimeType: "image/png", blob: "AAAA" },
					{ mimeType: "image/png", blob: "data:image/png;base64,BBBB" },
					// Not an image: contributes no entry.
					{ mimeType: "application/json", blob: "CCCC" },
				],
			}),
		)
		const cbs = makeToolCallbacks()

		await new AccessMcpResourceTool().execute({ server_name: "srv", uri: "res://x" }, task, cbs)

		const [, , images] = task.say.mock.calls.at(-1)!
		expect(images).toEqual(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"])
	})

	it("returns the denial response when the user rejects", async () => {
		const readResource = vi.fn()
		const cbs = makeToolCallbacks(false)

		await new AccessMcpResourceTool().execute({ server_name: "srv", uri: "res://x" }, buildTask(readResource), cbs)

		expect(readResource).not.toHaveBeenCalled()
		expect(toolResults(cbs)).toContain("denied")
	})

	it.each([
		["server_name", { server_name: "", uri: "res://x" }],
		["uri", { server_name: "srv", uri: "" }],
	])("reports a missing %s as a usage mistake", async (param, params) => {
		const task = buildTask(vi.fn())
		const cbs = makeToolCallbacks()

		await new AccessMcpResourceTool().execute(params as any, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain(`Missing ${param} for access_mcp_resource`)
	})

	it("routes a hub failure through handleError", async () => {
		const task = buildTask(vi.fn().mockRejectedValue(new Error("server down")))
		const cbs = makeToolCallbacks()

		await new AccessMcpResourceTool().execute({ server_name: "srv", uri: "res://x" }, task, cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("accessing MCP resource", expect.any(Error))
	})

	it("renders the streamed call as a use_mcp_server ask", async () => {
		const task = buildTask(vi.fn(), { ask: vi.fn().mockResolvedValue(undefined) })
		const block = {
			type: "tool_use",
			name: "access_mcp_resource",
			params: { server_name: "srv", uri: "res://x" },
			partial: true,
		} as any

		await new AccessMcpResourceTool().handlePartial(task, block)

		expect(task.ask).toHaveBeenCalledWith("use_mcp_server", expect.any(String), true)
		expect(JSON.parse(task.ask.mock.calls[0]![1])).toEqual({
			type: "access_mcp_resource",
			serverName: "srv",
			uri: "res://x",
		})
	})
})
