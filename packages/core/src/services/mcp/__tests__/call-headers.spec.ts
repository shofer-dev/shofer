/**
 * The per-call MCP header seam (`call-headers.ts`).
 *
 * Two halves, and the second is the one that matters. The first exercises the
 * broadcast — what a plugin may answer, what it may not, and that no plugin
 * means no change. The second runs a REAL `StreamableHTTPClientTransport`
 * against a REAL `node:http` server, because every part of this seam that could
 * quietly not work lives below the SDK's surface: the transport binds its
 * headers at construction, `send()` accepts no per-request ones, and the only
 * hook that survives to the wire is the custom `fetch`. A test that stubs the
 * client would pass with none of that true.
 */

import { createServer, type IncomingMessage, type Server } from "node:http"
import { AddressInfo } from "node:net"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import type { ShoferPlugin } from "@shofer/types"

import { pluginRegistry } from "../../../plugins/plugin-registry.js"
import {
	RESOLVE_MCP_CALL_HEADERS,
	currentMcpCallHeaders,
	fetchWithMcpCallHeaders,
	resolveMcpCallHeaders,
	withMcpCallHeaders,
} from "../call-headers.js"

/** Register a plugin answering the header broadcast, and remove it after the test. */
function usePlugin(name: string, answer: (params: unknown) => unknown): void {
	const plugin: ShoferPlugin = {
		name,
		async handleRequest(method: string, params: unknown) {
			if (method !== RESOLVE_MCP_CALL_HEADERS) throw new Error(`unknown method ${method}`)
			return answer(params)
		},
	}
	beforeEach(async () => {
		await pluginRegistry.register(plugin)
	})
	afterEach(() => {
		pluginRegistry.unregister(name)
	})
}

const httpQuestion = {
	serverName: "justceo",
	source: "global",
	type: "streamable-http",
	url: "http://mcp-server.invalid/mcp",
	toolName: "gitlab",
	taskId: "task-1",
} as const

describe("resolveMcpCallHeaders", () => {
	it("resolves to nothing when no plugin answers — the pre-plugin path", async () => {
		expect(await resolveMcpCallHeaders(httpQuestion)).toEqual({})
	})

	describe("with a plugin answering", () => {
		const seen: unknown[] = []
		usePlugin("headers-1", (params) => {
			seen.push(params)
			return { headers: { Authorization: "Bearer badge-1" } }
		})

		it("hands the plugin everything it needs to decide WHO it is answering for", async () => {
			seen.length = 0
			expect(await resolveMcpCallHeaders(httpQuestion)).toEqual({ Authorization: "Bearer badge-1" })
			// A resolver that cannot see the scope and the URL would be handing a
			// credential to whatever server happens to carry the expected name.
			expect(seen[0]).toEqual(httpQuestion)
		})

		it("never asks about a stdio server — a pipe has no headers to carry", async () => {
			seen.length = 0
			expect(await resolveMcpCallHeaders({ ...httpQuestion, type: "stdio", url: undefined })).toEqual({})
			expect(seen).toHaveLength(0)
		})
	})

	describe("with a plugin that answers badly", () => {
		usePlugin("headers-bad", () => ({
			headers: { "Content-Type": "text/plain", "mcp-session-id": "hijacked", "": "x", "X-Fine": "yes" },
		}))

		it("drops the headers the transport owns and keeps the rest", async () => {
			expect(await resolveMcpCallHeaders(httpQuestion)).toEqual({ "X-Fine": "yes" })
		})
	})

	describe("with two plugins claiming the same header", () => {
		usePlugin("headers-first", () => ({ headers: { Authorization: "Bearer first" } }))
		usePlugin("headers-second", () => ({ headers: { authorization: "Bearer second", "X-Other": "b" } }))

		it("keeps the first answer, case-insensitively, and still takes the rest", async () => {
			expect(await resolveMcpCallHeaders(httpQuestion)).toEqual({
				Authorization: "Bearer first",
				"X-Other": "b",
			})
		})
	})

	describe("with a plugin that throws", () => {
		usePlugin("headers-throws", () => {
			throw new Error("no badge for you")
		})

		it("degrades to no headers rather than failing the call", async () => {
			expect(await resolveMcpCallHeaders(httpQuestion)).toEqual({})
		})
	})
})

describe("withMcpCallHeaders", () => {
	it("is invisible outside its own async context", async () => {
		expect(currentMcpCallHeaders()).toBeUndefined()
		await withMcpCallHeaders({ A: "1" }, async () => {
			expect(currentMcpCallHeaders()).toEqual({ A: "1" })
		})
		expect(currentMcpCallHeaders()).toBeUndefined()
	})

	it("enters no context at all for an empty set", () => {
		withMcpCallHeaders({}, () => expect(currentMcpCallHeaders()).toBeUndefined())
		withMcpCallHeaders(undefined, () => expect(currentMcpCallHeaders()).toBeUndefined())
	})

	it("keeps concurrent calls apart — the reason this is not a shared field", async () => {
		const [a, b] = await Promise.all([
			withMcpCallHeaders({ Authorization: "a" }, async () => {
				await new Promise((r) => setTimeout(r, 10))
				return currentMcpCallHeaders()?.Authorization
			}),
			withMcpCallHeaders({ Authorization: "b" }, async () => currentMcpCallHeaders()?.Authorization),
		])
		expect([a, b]).toEqual(["a", "b"])
	})
})

/**
 * The real seam: an actual MCP server over an actual socket, reached by the
 * actual SDK transport. Everything asserted here is a property of the wire.
 */
describe("the header on the wire (real streamable-http transport, real HTTP)", () => {
	/** Every request the server received: its method (JSON-RPC) and its Authorization. */
	let received: Array<{ rpcMethod: string; authorization: string | undefined }>
	let server: Server
	let url: string

	const readBody = (req: IncomingMessage): Promise<string> =>
		new Promise((resolve) => {
			let body = ""
			req.on("data", (c) => (body += c))
			req.on("end", () => resolve(body))
		})

	beforeEach(async () => {
		received = []
		server = createServer(async (req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405).end()
				return
			}
			const message = JSON.parse(await readBody(req))
			received.push({ rpcMethod: message.method, authorization: req.headers.authorization })

			const result =
				message.method === "initialize"
					? {
							protocolVersion: "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "test", version: "0" },
						}
					: { content: [{ type: "text", text: "ok" }] }
			const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result })
			res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" }).end(body)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
	})

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	})

	/** A client wired exactly the way `McpHub` wires a streamable-http server. */
	async function connect(staticHeaders?: Record<string, string>): Promise<Client> {
		const client = new Client({ name: "test", version: "0" }, { capabilities: {} })
		await client.connect(
			new StreamableHTTPClientTransport(new URL(url), {
				requestInit: { headers: staticHeaders },
				fetch: fetchWithMcpCallHeaders,
			}),
		)
		return client
	}

	const callTool = (client: Client) =>
		client.request({ method: "tools/call", params: { name: "gitlab", arguments: {} } }, CallToolResultSchema)

	it("puts the per-call header on the tool call and on nothing else", async () => {
		const client = await connect()
		await withMcpCallHeaders({ Authorization: "Bearer badge-1" }, () => callTool(client))
		await client.close()

		const initialize = received.find((r) => r.rpcMethod === "initialize")
		const call = received.find((r) => r.rpcMethod === "tools/call")
		// The handshake belongs to the CONNECTION, which no run owns.
		expect(initialize?.authorization).toBeUndefined()
		expect(call?.authorization).toBe("Bearer badge-1")
	})

	it("leaves a call outside the seam exactly as it was", async () => {
		const client = await connect({ Authorization: "Bearer static-key" })
		await callTool(client)
		await client.close()

		// The connection's own header survives untouched — the no-plugin path.
		expect(received.find((r) => r.rpcMethod === "tools/call")?.authorization).toBe("Bearer static-key")
	})

	it("overrides the connection's header for that one call only", async () => {
		const client = await connect({ Authorization: "Bearer static-key" })
		await withMcpCallHeaders({ Authorization: "Bearer badge-1" }, () => callTool(client))
		await callTool(client)
		await client.close()

		const calls = received.filter((r) => r.rpcMethod === "tools/call")
		expect(calls.map((c) => c.authorization)).toEqual(["Bearer badge-1", "Bearer static-key"])
	})

	it("gives two concurrent calls on ONE connection their own header", async () => {
		const client = await connect()
		await Promise.all([
			withMcpCallHeaders({ Authorization: "Bearer run-a" }, () => callTool(client)),
			withMcpCallHeaders({ Authorization: "Bearer run-b" }, () => callTool(client)),
		])
		await client.close()

		const seen = received.filter((r) => r.rpcMethod === "tools/call").map((c) => c.authorization)
		expect(seen).toHaveLength(2)
		expect(new Set(seen)).toEqual(new Set(["Bearer run-a", "Bearer run-b"]))
	})
})
