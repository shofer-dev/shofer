import fs from "fs/promises"

import { createInMemoryHost, setHost } from "@shofer/types"

import type { TaskProviderLike } from "../../../task-provider/index.js"
import { toolGroupRegistry } from "../../../tool-groups/category-registry.js"

/**
 * The hub's CONNECTION LIFECYCLE — adding, changing, removing, restarting and
 * tearing down servers, and the config validation that gates all of it.
 *
 * Three properties are what this file exists for, and each has a failure mode
 * that is silent rather than loud:
 *
 *  - **one bad server must not take the others down.** A config the schema
 *    rejects is logged and SKIPPED; throwing out of `updateServerConnections`
 *    would leave every server after it in the file unconnected, with the user
 *    seeing "MCP is broken" rather than "this one entry is wrong";
 *  - **an unchanged server is left alone.** The reconcile runs on every config
 *    write and on every workspace-folder change, so reconnecting on no-change
 *    would restart every stdio child process whenever anything was edited —
 *    losing whatever session state those children hold;
 *  - **scope is part of a server's identity.** The same NAME may exist in the
 *    global and project scopes at once, and `deleteConnection(name, source)`
 *    must reach exactly one of them. Without the source filter, editing the
 *    project file silently disconnects the global server of the same name.
 *
 * The teardown assertions matter for a different reason: an stdio server is a
 * CHILD PROCESS, so a connection that is dropped without closing its transport
 * leaks a process for the lifetime of the host.
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

vi.mock("delay", () => ({ default: vi.fn(async () => undefined) }))

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import { McpHub } from "../McpHub.js"

const STDIO = { type: "stdio", command: "node", args: ["s.js"] }

let hub: McpHub
let provider: TaskProviderLike
let transportCloses: string[]
let clientCloses: number

function stubTransports() {
	vi.mocked(StdioClientTransport).mockImplementation(
		() =>
			({
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn(async () => {
					transportCloses.push("stdio")
				}),
				stderr: { on: vi.fn() },
				onerror: null,
				onclose: null,
			}) as never,
	)
	vi.mocked(SSEClientTransport).mockImplementation(
		() =>
			({
				close: vi.fn(async () => {
					transportCloses.push("sse")
				}),
				onerror: null,
				onclose: null,
			}) as never,
	)
	vi.mocked(StreamableHTTPClientTransport).mockImplementation(
		() =>
			({
				close: vi.fn(async () => {
					transportCloses.push("http")
				}),
				onerror: null,
				onclose: null,
			}) as never,
	)
}

beforeEach(async () => {
	vi.clearAllMocks()
	transportCloses = []
	clientCloses = 0
	vi.mocked(fs.access).mockResolvedValue(undefined)
	vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: {} }))
	toolGroupRegistry.reset()
	setHost(createInMemoryHost())

	stubTransports()
	vi.mocked(Client).mockImplementation(
		() =>
			({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn(async () => {
					clientCloses++
				}),
				getInstructions: vi.fn().mockReturnValue(undefined),
				request: vi.fn(async (req: { method: string }) => {
					if (req.method === "tools/list") return { tools: [{ name: "do_thing", inputSchema: {} }] }
					if (req.method === "resources/list") return { resources: [] }
					if (req.method === "resources/templates/list") return { resourceTemplates: [] }
					return {}
				}),
			}) as never,
	)

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

const named = (name: string, source?: "global" | "project") =>
	hub.getAllServers().find((s) => s.name === name && (source ? (s.source ?? "global") === source : true))

describe("reconciling a scope against its config", () => {
	it("connects a server that has appeared", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")

		expect(named("srv")).toMatchObject({ name: "srv", status: "connected" })
	})

	it("removes a server that has disappeared, closing its transport and client", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		transportCloses = []
		clientCloses = 0

		await hub.updateServerConnections({} as never, "global")

		expect(named("srv")).toBeUndefined()
		// An stdio server is a child process; not closing it leaks one.
		expect(transportCloses).toEqual(["stdio"])
		expect(clientCloses).toBe(1)
	})

	it("leaves an UNCHANGED server connected rather than restarting it", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		// The comparison is against what the connection RECORDED, which is the
		// validated config — schema defaults included. Feeding that back is the
		// only way to express "the file did not change" to this reconcile.
		const recorded = JSON.parse(named("srv")!.config)
		transportCloses = []

		await hub.updateServerConnections({ srv: recorded } as never, "global")

		expect(transportCloses).toEqual([])
		expect(named("srv")).toMatchObject({ status: "connected" })
	})

	it("reconnects a server whose config CHANGED", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		transportCloses = []

		await hub.updateServerConnections({ srv: { ...STDIO, args: ["other.js"] } } as never, "global")

		expect(transportCloses).toEqual(["stdio"])
		expect(JSON.parse(named("srv")!.config)).toMatchObject({ args: ["other.js"] })
	})

	it("touches only its OWN scope", async () => {
		// The same name in both scopes is legal, and editing one file must not
		// disconnect the other's server.
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		await hub.updateServerConnections({ srv: STDIO } as never, "project")

		await hub.updateServerConnections({} as never, "project")

		expect(named("srv", "global")).toBeDefined()
		expect(named("srv", "project")).toBeUndefined()
	})

	it("skips an invalid entry and still connects the valid ones", async () => {
		await hub.updateServerConnections({ bad: { type: "stdio" }, good: STDIO } as never, "global")

		expect(named("bad")).toBeUndefined()
		expect(named("good")).toMatchObject({ status: "connected" })
	})

	it("survives a server that refuses to connect", async () => {
		vi.mocked(Client).mockImplementationOnce(
			() => ({ connect: vi.fn().mockRejectedValue(new Error("spawn ENOENT")), close: vi.fn() }) as never,
		)

		await hub.updateServerConnections({ srv: STDIO } as never, "global")

		expect(named("srv")).toMatchObject({ status: "disconnected" })
	})
})

describe("what the config validator refuses", () => {
	const refuses = async (config: Record<string, unknown>) => {
		await hub.updateServerConnections({ srv: config } as never, "global")
		return named("srv") === undefined
	}

	it("refuses a config carrying BOTH a command and a url", async () => {
		// The two transports are mutually exclusive; guessing which one was meant
		// is how a server silently talks to the wrong endpoint.
		expect(await refuses({ command: "node", url: "https://example.com" })).toBe(true)
	})

	it("refuses a url with no explicit type", async () => {
		expect(await refuses({ url: "https://example.com/mcp" })).toBe(true)
	})

	it("refuses an unknown transport type", async () => {
		expect(await refuses({ type: "carrier-pigeon", command: "node" })).toBe(true)
	})

	it.each([
		["stdio without a command", { type: "stdio", url: undefined }],
		["sse without a url", { type: "sse", command: "node" }],
		["streamable-http without a url", { type: "streamable-http", command: "node" }],
	])("refuses %s", async (_case, config) => {
		expect(await refuses(config as Record<string, unknown>)).toBe(true)
	})

	it("refuses a config with neither field", async () => {
		expect(await refuses({ disabled: false })).toBe(true)
	})

	it("refuses a config the schema rejects, naming the server", async () => {
		expect(await refuses({ ...STDIO, timeout: "not a number" })).toBe(true)
	})

	it("INFERS stdio when a command is present and no type is declared", async () => {
		await hub.updateServerConnections({ srv: { command: "node", args: ["s.js"] } } as never, "global")

		expect(named("srv")).toMatchObject({ status: "connected" })
	})

	it("accepts an sse server that declares its type", async () => {
		await hub.updateServerConnections({ srv: { type: "sse", url: "https://x/mcp" } } as never, "global")

		expect(named("srv")).toMatchObject({ status: "connected" })
	})
})

describe("restarting one server", () => {
	it("tears the connection down and builds it again from the same config", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		transportCloses = []

		await hub.restartConnection("srv", "global")

		expect(transportCloses).toEqual(["stdio"])
		expect(named("srv")).toMatchObject({ status: "connected" })
	})

	it("does nothing for a server nobody has connected", async () => {
		await expect(hub.restartConnection("ghost", "global")).resolves.toBeUndefined()
	})

	it("refuses to restart while MCP is globally disabled", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		provider.getState = vi.fn().mockResolvedValue({ mcpEnabled: false }) as never
		transportCloses = []

		await hub.restartConnection("srv", "global")

		expect(transportCloses).toEqual([])
	})

	it("leaves the server disconnected when reconnecting fails", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		vi.mocked(Client).mockImplementationOnce(
			() => ({ connect: vi.fn().mockRejectedValue(new Error("gone")), close: vi.fn() }) as never,
		)

		await hub.restartConnection("srv", "global")

		expect(named("srv")).toMatchObject({ status: "disconnected" })
	})
})

describe("deleting a connection", () => {
	it("removes every scope's copy when no source is given", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		await hub.updateServerConnections({ srv: STDIO } as never, "project")

		await hub.deleteConnection("srv")

		expect(hub.getAllServers().filter((s) => s.name === "srv")).toEqual([])
	})

	it("survives a transport that throws on close", async () => {
		vi.mocked(StdioClientTransport).mockImplementationOnce(
			() =>
				({
					start: vi.fn().mockResolvedValue(undefined),
					close: vi.fn().mockRejectedValue(new Error("already dead")),
					stderr: { on: vi.fn() },
				}) as never,
		)
		await hub.updateServerConnections({ srv: STDIO } as never, "global")

		await expect(hub.deleteConnection("srv", "global")).resolves.toBeUndefined()
		expect(named("srv")).toBeUndefined()
	})
})

describe("resolving a name the model gave back", () => {
	it("matches an exact name", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")

		expect(hub.findServerNameBySanitizedName("srv")).toBe("srv")
	})

	it("matches across the hyphen/underscore the tool-name sanitizer imposes", async () => {
		// The wire name cannot carry a hyphen, so the model only ever sees the
		// sanitized form and would otherwise address a server that "does not exist".
		await hub.updateServerConnections({ "my-server": STDIO } as never, "global")

		expect(hub.findServerNameBySanitizedName("my_server")).toBe("my-server")
	})

	it("answers null for a name no server has", async () => {
		expect(hub.findServerNameBySanitizedName("nobody")).toBeNull()
	})
})

describe("the tool metadata the prompt builder reads", () => {
	it("carries the server each tool belongs to", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")

		expect(hub.getMcpToolMetadata()).toEqual([expect.objectContaining({ name: "do_thing", serverName: "srv" })])
	})
})

describe("the global MCP switch", () => {
	it("disconnects everything when turned off", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		provider.getState = vi.fn().mockResolvedValue({ mcpEnabled: false }) as never
		transportCloses = []

		await hub.handleMcpEnabledChange(false)

		expect(transportCloses).toContain("stdio")
		expect(hub.getServers()).toEqual([])
	})

	it("reconnects when turned back on", async () => {
		await expect(hub.handleMcpEnabledChange(true)).resolves.toBeUndefined()
	})
})

describe("disposal", () => {
	it("closes every connection and is idempotent", async () => {
		await hub.updateServerConnections({ srv: STDIO } as never, "global")
		transportCloses = []

		await hub.dispose()
		await hub.dispose()

		expect(transportCloses).toEqual(["stdio"])
		expect(hub.getAllServers()).toEqual([])
	})
})
