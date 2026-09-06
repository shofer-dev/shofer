import fs from "fs/promises"

import { createInMemoryHost, setHost } from "@shofer/types"

import type { TaskProviderLike } from "../../../task-provider/index.js"
import { toolGroupRegistry } from "../../../tool-groups/category-registry.js"

vi.mock("fs/promises", () => {
	const impl = {
		access: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("{}"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
		lstat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
	}
	return { ...impl, default: impl }
})

vi.mock("../../../utils/safeWriteJson.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/safeWriteJson.js")>()),
	safeWriteJson: vi.fn(async () => undefined),
}))

vi.mock("../../../fs/fs.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../fs/fs.js")>()),
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn(),
	getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}))
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: vi.fn() }))
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: vi.fn() }))
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: vi.fn() }))
vi.mock("chokidar", () => ({
	default: { watch: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), close: vi.fn() }) },
}))

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import { pluginRegistry } from "../../../plugins/plugin-registry.js"
import { currentMcpCallHeaders, RESOLVE_MCP_CALL_HEADERS } from "../call-headers.js"
import { MCP_META_TASK_ID, MCP_META_TOOL_CALL_ID, McpHub } from "../McpHub.js"

/**
 * `McpHub.callTool` / `readResource` — the one canonical call site into a
 * server, and the two seams that ride on it.
 *
 * The **MCP Per-Call Header Rule** is what this file mostly exists for: a
 * header belonging to the RUN reaches a server through exactly ONE path — the
 * `"resolve-mcp-call-headers"` plugin broadcast, carried to the transport's
 * `fetch` by an `AsyncLocalStorage`. Not by mutating the connection's headers
 * (one hub-scoped connection serves every task, so that races), and not by
 * putting a credential in `_meta` (which is request metadata the server logs
 * and forwards). The answer is always optional: with no plugin answering, the
 * request must be byte-for-byte what it was.
 *
 * `_meta` carries identity rather than authority — the task id, and the RAW
 * provider tool-call id, deliberately unsanitized so the broker's record and
 * the transcript stay joinable.
 */

const SERVER = "srv"

let hub: McpHub
let request: ReturnType<typeof vi.fn>

function stubTransports() {
	vi.mocked(StdioClientTransport).mockImplementation(
		() =>
			({
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: { on: vi.fn() },
				onerror: null,
				onclose: null,
			}) as never,
	)
	vi.mocked(StreamableHTTPClientTransport).mockImplementation(
		() => ({ close: vi.fn().mockResolvedValue(undefined), onerror: null, onclose: null }) as never,
	)
}

beforeEach(async () => {
	vi.clearAllMocks()
	toolGroupRegistry.reset()
	setHost(createInMemoryHost())
	stubTransports()

	request = vi.fn(async (req: { method: string }) => {
		if (req.method === "tools/list") return { tools: [{ name: "do_thing", inputSchema: {} }] }
		if (req.method === "resources/list") return { resources: [] }
		if (req.method === "resources/templates/list") return { resourceTemplates: [] }
		if (req.method === "resources/read") return { contents: [{ text: "the resource" }] }
		return { content: [{ type: "text", text: "tool output" }] }
	})

	vi.mocked(Client).mockImplementation(
		() =>
			({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue(undefined),
				request,
			}) as never,
	)

	vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: {} }))

	hub = new McpHub({
		ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings"),
		ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/servers"),
		postMessageToWebview: vi.fn(),
		getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
		context: { globalStorageUri: { fsPath: "/mock" } },
	} as unknown as TaskProviderLike)
	await hub.waitUntilReady()
})

afterEach(async () => {
	await hub.dispose()
})

async function connect(config: Record<string, unknown> = { type: "stdio", command: "node", args: ["s.js"] }) {
	await hub.updateServerConnections({ [SERVER]: config } as never, "global")
}

/** The params of the most recent `tools/call`. */
function lastCallParams(): Record<string, any> {
	const call = request.mock.calls.filter((c) => (c[0] as { method: string }).method === "tools/call").at(-1)
	return (call![0] as { params: Record<string, any> }).params
}

describe("callTool — refusals", () => {
	it("names the server when there is no connection to it", async () => {
		await expect(hub.callTool("nope", "do_thing")).rejects.toThrow(/No connection found for server: nope/)
	})

	it("refuses a server disabled while it was connected", async () => {
		// A server disabled in the CONFIG never connects at all (it is tracked as a
		// placeholder, and the no-connection refusal covers it). This is the other
		// case: the toggle flipped on a live connection.
		await connect()
		hub.connections.find((c) => c.server.name === SERVER)!.server.disabled = true

		await expect(hub.callTool(SERVER, "do_thing", {}, "global")).rejects.toThrow(/disabled and cannot be used/)
	})

	it("refuses a server that is only tracked as a placeholder", async () => {
		await connect({ type: "stdio", command: "node", args: ["s.js"], disabled: true })

		await expect(hub.callTool(SERVER, "do_thing", {}, "global")).rejects.toThrow(/No connection found/)
	})
})

describe("callTool — what goes on the wire", () => {
	it("sends the tool name and arguments, and returns the server's result", async () => {
		await connect()

		const result = await hub.callTool(SERVER, "do_thing", { a: 1 }, "global")

		expect(lastCallParams()).toMatchObject({ name: "do_thing", arguments: { a: 1 } })
		expect(result).toEqual({ content: [{ type: "text", text: "tool output" }] })
	})

	it("carries the task id and the RAW tool-call id in _meta", async () => {
		await connect()

		// The provider's id is deliberately NOT sanitized here: the broker's
		// record and the transcript are only joinable while both hold the string
		// the model emitted.
		await hub.callTool(SERVER, "do_thing", {}, "global", "task-1", "call/with:odd.chars")

		expect(lastCallParams()._meta).toEqual({
			[MCP_META_TASK_ID]: "task-1",
			[MCP_META_TOOL_CALL_ID]: "call/with:odd.chars",
		})
	})

	it("omits _meta entirely when there is nothing to identify", async () => {
		await connect()

		await hub.callTool(SERVER, "do_thing", {}, "global")

		expect(lastCallParams()._meta).toBeUndefined()
	})

	it("applies the server's configured timeout, in milliseconds", async () => {
		await connect({ type: "stdio", command: "node", args: ["s.js"], timeout: 5 })

		await hub.callTool(SERVER, "do_thing", {}, "global")

		const call = request.mock.calls.filter((c) => (c[0] as { method: string }).method === "tools/call").at(-1)
		expect((call![2] as { timeout: number }).timeout).toBe(5000)
	})

	it("falls back to sixty seconds when the stored config cannot be parsed", async () => {
		await connect()
		hub.connections.find((c) => c.server.name === SERVER)!.server.config = "{ not json"

		await hub.callTool(SERVER, "do_thing", {}, "global")

		const call = request.mock.calls.filter((c) => (c[0] as { method: string }).method === "tools/call").at(-1)
		expect((call![2] as { timeout: number }).timeout).toBe(60_000)
	})

	it("threads the caller's abort signal down to the SDK", async () => {
		await connect()
		const signal = new AbortController().signal

		await hub.callTool(SERVER, "do_thing", {}, "global", undefined, undefined, signal)

		const call = request.mock.calls.filter((c) => (c[0] as { method: string }).method === "tools/call").at(-1)
		expect((call![2] as { signal?: AbortSignal }).signal).toBe(signal)
	})

	it("re-throws an upstream failure rather than swallowing it", async () => {
		await connect()
		request.mockImplementation(async (req: { method: string }) => {
			if (req.method === "tools/call") throw new Error("the server exploded")
			return { tools: [] }
		})

		await expect(hub.callTool(SERVER, "do_thing", {}, "global")).rejects.toThrow("the server exploded")
	})
})

describe("the per-call header seam", () => {
	it("sends nothing extra when no plugin answers", async () => {
		await connect({ type: "streamable-http", url: "https://mcp.example/mcp" })
		let seen: Record<string, string> | undefined
		request.mockImplementation(async (req: { method: string }) => {
			if (req.method === "tools/call") {
				seen = currentMcpCallHeaders()
				return { content: [] }
			}
			if (req.method === "tools/list") return { tools: [] }
			return {}
		})

		await hub.callTool(SERVER, "do_thing", {}, "global", "task-1")

		// Absent headers must leave the call byte-for-byte what it was.
		expect(seen === undefined || Object.keys(seen).length === 0).toBe(true)
	})

	it("asks the resolver about THIS server and carries its answer into the request", async () => {
		await connect({ type: "streamable-http", url: "https://mcp.example/mcp" })
		const asked: unknown[] = []
		// The broadcast is the ONE path; spying on it is the narrowest way to
		// stand in for a plugin that answers it.
		vi.spyOn(pluginRegistry, "requestAll").mockImplementation(async (method, question) => {
			if (method !== RESOLVE_MCP_CALL_HEADERS) return []
			asked.push(question)
			return [{ headers: { "X-Run": "run-1" } }]
		})

		let seen: Record<string, string> | undefined
		request.mockImplementation(async (req: { method: string }) => {
			if (req.method === "tools/call") {
				seen = currentMcpCallHeaders()
				return { content: [] }
			}
			if (req.method === "tools/list") return { tools: [] }
			return {}
		})

		await hub.callTool(SERVER, "do_thing", {}, "global", "task-1")

		// The question names the server and the RUN, which is what makes the
		// answer the run's headers rather than the host's.
		expect(asked[0]).toMatchObject({ serverName: SERVER, taskId: "task-1", type: "streamable-http" })
		expect(seen).toEqual({ "X-Run": "run-1" })
	})
})

describe("readResource", () => {
	it("returns the server's contents", async () => {
		await connect()

		const result = await hub.readResource(SERVER, "res://x", "global")

		expect(result.contents[0]).toMatchObject({ text: "the resource" })
	})

	it("names the server when there is no connection", async () => {
		await expect(hub.readResource("nope", "res://x")).rejects.toThrow(/No connection found/)
	})

	it("threads the abort signal", async () => {
		await connect()
		const signal = new AbortController().signal

		await hub.readResource(SERVER, "res://x", "global", signal)

		const call = request.mock.calls.filter((c) => (c[0] as { method: string }).method === "resources/read").at(-1)
		expect((call![2] as { signal?: AbortSignal }).signal).toBe(signal)
	})
})
