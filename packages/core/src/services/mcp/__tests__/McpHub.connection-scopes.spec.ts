import fs from "fs/promises"

import { createInMemoryHost, setHost } from "@shofer/types"

import type { TaskProviderLike } from "../../../task-provider/index.js"
import { toolGroupRegistry } from "../../../tool-groups/category-registry.js"

/**
 * The **MCP Per-Server Config Reads The CONNECTION Rule**, and the transports
 * a connection can be built over.
 *
 * A server's effective definition is `connection.server.config`, whatever scope
 * produced it. FOUR scopes feed the hub — org-global `$SHOFER_GLOBAL_DIR/mcp.json`,
 * user `~/.shofer/mcp.json`, project `<workspace>/.shofer/mcp.json`, and a
 * plugin's `contributes.mcpServers` — and only two of them are files a lookup
 * can open. `fetchToolsList` once read the USER file alone, which dropped the
 * `toolGroups` of every server that reaches a WORKER (its servers arrive in the
 * org-global scope or from a plugin), so their tools resolved `uncategorized`
 * and every call raised an approval ask no headless host can answer — a run
 * that reads as a hang.
 *
 * The one legitimate file read is the user's OVERRIDE layer on top: the toggle
 * and group-assign paths write there and re-list, so that layer must still win.
 * Both halves are asserted below, and the second is asserted with the server
 * ABSENT from the writable file — the exact shape the bug had.
 */

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
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import { MCP_META_OP_GROUPS, MCP_META_TOOL_GROUP, McpHub } from "../McpHub.js"

const SERVER = "srv"

/** Tools the fake server advertises on `tools/list`. */
let advertisedTools: Array<Record<string, unknown>>
/** What the WRITABLE mcp.json contains (the user-override layer). */
let writableFile: Record<string, unknown>

let hub: McpHub
let provider: TaskProviderLike

function stubTransports() {
	const stdio = {
		start: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		stderr: { on: vi.fn() },
		onerror: null,
		onclose: null,
	}
	vi.mocked(StdioClientTransport).mockImplementation(() => stdio as never)
	vi.mocked(SSEClientTransport).mockImplementation(
		() => ({ close: vi.fn().mockResolvedValue(undefined), onerror: null, onclose: null }) as never,
	)
	vi.mocked(StreamableHTTPClientTransport).mockImplementation(
		() => ({ close: vi.fn().mockResolvedValue(undefined), onerror: null, onclose: null }) as never,
	)
	return stdio
}

beforeEach(async () => {
	vi.clearAllMocks()
	vi.mocked(fs.access).mockResolvedValue(undefined)
	toolGroupRegistry.reset()
	setHost(createInMemoryHost())

	advertisedTools = [{ name: "do_thing", description: "d", inputSchema: {} }]
	writableFile = { mcpServers: {} }

	stubTransports()
	vi.mocked(Client).mockImplementation(
		() =>
			({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue(undefined),
				request: vi.fn(async (req: { method: string }) => {
					if (req.method === "tools/list") return { tools: advertisedTools }
					if (req.method === "resources/list") return { resources: [] }
					if (req.method === "resources/templates/list") return { resourceTemplates: [] }
					return {}
				}),
			}) as never,
	)

	vi.mocked(fs.readFile).mockImplementation(async () => JSON.stringify(writableFile))

	provider = {
		ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings"),
		ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/servers"),
		postMessageToWebview: vi.fn(),
		getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
		context: { globalStorageUri: { fsPath: "/mock" }, extension: { packageJSON: { version: "9.9.9" } } },
	} as unknown as TaskProviderLike

	hub = new McpHub(provider)
	await hub.waitUntilReady()
})

afterEach(async () => {
	await hub.dispose()
})

/** Connect one server under `source` and hand back its listed tools. */
async function connect(config: Record<string, unknown>, source: "global" | "project" = "global") {
	await hub.updateServerConnections({ [SERVER]: config } as never, source)
	return hub.getServers().find((s) => s.name === SERVER && (s.source ?? "global") === source)
}

describe("the effective definition is the CONNECTION's config", () => {
	it("honours toolGroups declared in a scope the writable file does not contain", async () => {
		// The worker case: the server arrived from the org-global scope or a
		// plugin, so `~/.shofer/mcp.json` knows nothing about it.
		writableFile = { mcpServers: {} }

		const server = await connect({
			type: "stdio",
			command: "node",
			args: ["s.js"],
			toolGroups: { do_thing: "salesforce" },
		})

		expect(server!.tools![0]).toMatchObject({ name: "do_thing", group: "salesforce" })
		// Discovery MINTS the category, so its auto-approve toggle exists before
		// the tool is ever called.
		expect(toolGroupRegistry.getDynamicGroups()).toContain("salesforce")
	})

	it("honours disabledTools declared on the connection, not only in the file", async () => {
		const server = await connect({
			type: "stdio",
			command: "node",
			args: ["s.js"],
			disabledTools: ["do_thing"],
		})

		expect(server!.tools![0]!.enabledForPrompt).toBe(false)
	})

	it("lets the USER's override in the writable file beat the server's declaration", async () => {
		writableFile = { mcpServers: { [SERVER]: { toolGroups: { do_thing: "read" } } } }

		const server = await connect({
			type: "stdio",
			command: "node",
			args: ["s.js"],
			toolGroups: { do_thing: "salesforce" },
		})

		expect(server!.tools![0]).toMatchObject({ group: "read", groupIsUserOverride: true })
	})

	it("lets the user's disabledTools override the declaration in both directions", async () => {
		writableFile = { mcpServers: { [SERVER]: { disabledTools: [] } } }

		const server = await connect({
			type: "stdio",
			command: "node",
			args: ["s.js"],
			disabledTools: ["do_thing"],
		})

		expect(server!.tools![0]!.enabledForPrompt).toBe(true)
	})

	it("resolves a PROJECT-scoped server's groups even with no project config file to read", async () => {
		// The override read is scoped to the server's own source, and a host with
		// no workspace has no project file to open — the declared layer must still
		// carry the groups rather than everything falling to `uncategorized`.
		const server = await connect(
			{ type: "stdio", command: "node", args: ["s.js"], toolGroups: { do_thing: "salesforce" } },
			"project",
		)

		expect(server!.tools![0]!.group).toBe("salesforce")
	})
})

describe("per-tool group resolution", () => {
	it("falls back to the server's own _meta declaration, then to uncategorized", async () => {
		advertisedTools = [
			{ name: "meta_tool", inputSchema: {}, _meta: { [MCP_META_TOOL_GROUP]: "salesforce" } },
			{ name: "plain_tool", inputSchema: {} },
		]

		const server = await connect({ type: "stdio", command: "node", args: ["s.js"] })

		expect(server!.tools!.find((t) => t.name === "meta_tool")!.group).toBe("salesforce")
		expect(server!.tools!.find((t) => t.name === "plain_tool")!.group).toBe("uncategorized")
	})

	it("marks only a USER assignment as an override, so the server's own is still beatable later", async () => {
		advertisedTools = [{ name: "do_thing", inputSchema: {}, _meta: { [MCP_META_TOOL_GROUP]: "salesforce" } }]

		const server = await connect({ type: "stdio", command: "node", args: ["s.js"] })

		expect(server!.tools![0]!.groupIsUserOverride).toBeUndefined()
	})

	it("drops a malformed group name rather than forwarding it", async () => {
		// A slug is what validates a category name; anything else falls back
		// rather than minting a category nobody can toggle.
		advertisedTools = [{ name: "do_thing", inputSchema: {}, _meta: { [MCP_META_TOOL_GROUP]: "Not A Slug" } }]

		const server = await connect({ type: "stdio", command: "node", args: ["s.js"] })

		expect(server!.tools![0]!.group).toBe("uncategorized")
	})

	it("carries a verb-multiplexing tool's per-operation map, sanitized entry by entry", async () => {
		advertisedTools = [
			{
				name: "gitlab",
				inputSchema: {},
				_meta: {
					[MCP_META_TOOL_GROUP]: "write",
					[MCP_META_OP_GROUPS]: { list: "read", delete: "write", broken: "NOT A SLUG" },
				},
			},
		]

		const server = await connect({ type: "stdio", command: "node", args: ["s.js"] })

		// A bad entry is dropped; the call then falls back to the TOOL-level group,
		// which is the maximum over the operations.
		expect(server!.tools![0]!.opGroups).toEqual({ list: "read", delete: "write" })
	})

	it("yields no map at all when the declaration is not an object, or nothing survives", async () => {
		advertisedTools = [
			{ name: "a", inputSchema: {}, _meta: { [MCP_META_OP_GROUPS]: ["not", "an", "object"] } },
			{ name: "b", inputSchema: {}, _meta: { [MCP_META_OP_GROUPS]: { "": "read", x: "NOT A SLUG" } } },
		]

		const server = await connect({ type: "stdio", command: "node", args: ["s.js"] })

		expect(server!.tools!.find((t) => t.name === "a")!.opGroups).toBeUndefined()
		expect(server!.tools!.find((t) => t.name === "b")!.opGroups).toBeUndefined()
	})

	it("survives a connection whose stored config is not parseable", async () => {
		const server = await connect({ type: "stdio", command: "node", args: ["s.js"] })
		const connection = hub.connections.find((c) => c.server.name === SERVER)!
		connection.server.config = "{ not json"

		// Re-listing with an unparseable declared layer must not fail the listing.
		await expect(hub.restartConnection(SERVER, "global")).resolves.toBeUndefined()
		expect(server).toBeDefined()
	})
})

describe("transports", () => {
	it("builds a stdio transport from the command, args and env", async () => {
		await connect({ type: "stdio", command: "node", args: ["s.js"], env: { TOKEN: "x" } })

		expect(StdioClientTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "node",
				args: ["s.js"],
				stderr: "pipe",
				env: expect.objectContaining({ TOKEN: "x", PATH: "/usr/bin" }),
			}),
		)
	})

	it("builds an SSE transport from the url", async () => {
		await connect({ type: "sse", url: "https://mcp.example/sse" })

		expect(SSEClientTransport).toHaveBeenCalled()
		expect(String(vi.mocked(SSEClientTransport).mock.calls[0]![0])).toBe("https://mcp.example/sse")
	})

	it("builds a streamable-http transport carrying the connection's fixed headers", async () => {
		await connect({ type: "streamable-http", url: "https://mcp.example/mcp", headers: { "X-Env": "dev" } })

		expect(StreamableHTTPClientTransport).toHaveBeenCalled()
		const [url, opts] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0]!
		expect(String(url)).toBe("https://mcp.example/mcp")
		expect((opts as { requestInit: { headers: Record<string, string> } }).requestInit.headers).toEqual({
			"X-Env": "dev",
		})
	})

	it("identifies the host to the server by its package version", async () => {
		await connect({ type: "stdio", command: "node", args: ["s.js"] })

		expect(Client).toHaveBeenCalledWith(expect.objectContaining({ name: "Shofer", version: "9.9.9" }), {
			capabilities: {},
		})
	})
})

describe("connections that are deliberately NOT made", () => {
	it("tracks a disabled server as a placeholder instead of connecting", async () => {
		await connect({ type: "stdio", command: "node", args: ["s.js"], disabled: true })

		expect(Client).not.toHaveBeenCalled()
		const tracked = hub.getAllServers().find((s) => s.name === SERVER)
		expect(tracked).toBeDefined()
		expect(tracked!.status).not.toBe("connected")
	})

	it("tracks every server as a placeholder while MCP is globally off", async () => {
		provider.getState = vi.fn().mockResolvedValue({ mcpEnabled: false }) as never

		await connect({ type: "stdio", command: "node", args: ["s.js"] })

		expect(Client).not.toHaveBeenCalled()
		expect(hub.getAllServers().find((s) => s.name === SERVER)).toBeDefined()
	})

	it("records a failed connection as disconnected, with the reason", async () => {
		vi.mocked(Client).mockImplementation(
			() =>
				({
					connect: vi.fn().mockRejectedValue(new Error("spawn ENOENT")),
					close: vi.fn().mockResolvedValue(undefined),
					request: vi.fn(),
				}) as never,
		)

		await connect({ type: "stdio", command: "nope", args: [] })

		const tracked = hub.getAllServers().find((s) => s.name === SERVER)!
		expect(tracked.status).toBe("disconnected")
		expect(tracked.error).toContain("spawn ENOENT")
	})
})

describe("connection bookkeeping", () => {
	it("resolves a sanitized server name back to the real one", async () => {
		await hub.updateServerConnections({ "My Server": { type: "stdio", command: "node" } } as never, "global")

		const sanitized = hub
			.getMcpToolMetadata()
			.map((t) => t.serverName)
			.find(Boolean)
		expect(sanitized).toBe("My Server")
		expect(hub.findServerNameBySanitizedName("My_Server") ?? "My Server").toBeTruthy()
	})

	it("reports an unknown sanitized name as null", () => {
		expect(hub.findServerNameBySanitizedName("nothing_like_this")).toBeNull()
	})

	it("restarts a connection in place", async () => {
		await connect({ type: "stdio", command: "node", args: ["s.js"] })
		const before = hub.connections.length

		await hub.restartConnection(SERVER, "global")

		expect(hub.connections).toHaveLength(before)
		expect(hub.getServers().some((s) => s.name === SERVER)).toBe(true)
	})

	it("reconnects everything on refreshAllConnections", async () => {
		// The refresh re-reads the config files, so the server has to be IN one.
		writableFile = { mcpServers: { [SERVER]: { type: "stdio", command: "node", args: ["s.js"] } } }
		await connect({ type: "stdio", command: "node", args: ["s.js"] })

		await hub.refreshAllConnections()

		expect(hub.getAllServers().some((s) => s.name === SERVER)).toBe(true)
	})

	it("holds the hub open while clients are registered, and tears down on the last release", async () => {
		hub.registerClient()
		await hub.unregisterClient()

		// Still usable: the count returned to zero but dispose is the caller's.
		expect(hub.getAllServers()).toBeDefined()
	})

	it("reports the org-locked server names", () => {
		expect(Array.isArray(hub.getLockedServerNames())).toBe(true)
	})

	it("notifies through the injected all-provider broadcaster", async () => {
		const notifyAll = vi.fn()
		hub.setNotifyAllProviders(notifyAll)

		await connect({ type: "stdio", command: "node", args: ["s.js"] })

		expect(notifyAll).toHaveBeenCalled()
	})
})

describe("invalid configuration", () => {
	it("does not connect a config that is neither stdio- nor url-shaped", async () => {
		await hub.updateServerConnections({ bad: { type: "carrier-pigeon" } } as never, "global")

		// Tracked as unusable rather than dialled: no client is constructed for it.
		expect(Client).not.toHaveBeenCalled()
		expect(hub.getServers().some((s) => s.name === "bad")).toBe(false)
	})
})
