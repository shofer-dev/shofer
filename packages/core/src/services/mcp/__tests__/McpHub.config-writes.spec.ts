import fs from "fs/promises"

import { createInMemoryHost, getHost, setHost, type RecordingNotifier } from "@shofer/types"

import type { TaskProviderLike } from "../../../task-provider/index.js"
import { toolGroupRegistry } from "../../../tool-groups/category-registry.js"

/**
 * The config-WRITING half of `McpHub`: the operations a user performs from the
 * MCP panel (delete a server, edit its config, assign a tool to a group,
 * enable/disable a tool for the prompt) and the lifecycle around them
 * (debounced file-change handling, MCP master toggle, dispose).
 *
 * Two invariants beyond "the file changed":
 *
 *  - A programmatic write must NOT be read back by the hub's own file watcher
 *    as a user edit, or every group assignment restarts the server it touched.
 *    `isProgrammaticUpdate` is what suppresses that, and `debounceConfigChange`
 *    is where it is honoured.
 *  - Assigning a tool to a group REGISTERS the category (Tool Group Count
 *    Coherence Rule: the vocabulary is open and minted at the declaration
 *    site), so a name typed into the dropdown has a toggle from that moment on
 *    rather than after a reconnect.
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
	safeWriteJson: vi.fn(async (filePath: string, data: unknown) => {
		const promises = await import("fs/promises")
		return promises.writeFile(filePath, JSON.stringify(data), "utf8")
	}),
}))

vi.mock("../../../fs/fs.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../fs/fs.js")>()),
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn(),
	getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: vi.fn() }))

vi.mock("chokidar", () => ({
	default: { watch: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), close: vi.fn() }) },
}))

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import { McpHub } from "../McpHub.js"

const SERVER = "test-server"
const SERVERS = {
	mcpServers: { [SERVER]: { type: "stdio", command: "node", args: ["test.js"] } },
}

let hub: McpHub
let notifier: RecordingNotifier
let listedTools: Array<Record<string, unknown>>

function notices(): string[] {
	return notifier.messages.map((m) => m.message)
}

/** The JSON handed to the most recent write of `path` (or the most recent write). */
function lastWrittenJson(): Record<string, any> {
	const calls = vi.mocked(fs.writeFile).mock.calls
	return JSON.parse(String(calls.at(-1)![1]))
}

beforeEach(async () => {
	vi.clearAllMocks()
	// `clearAllMocks` clears CALLS, not implementations, and several tests below
	// install a rejecting `fs` implementation — re-seed the happy path so a
	// failure injected by one test cannot leak into the next.
	vi.mocked(fs.access).mockResolvedValue(undefined)
	vi.mocked(fs.writeFile).mockResolvedValue(undefined)
	toolGroupRegistry.reset()
	setHost(createInMemoryHost())
	notifier = getHost().notifier as RecordingNotifier
	listedTools = [{ name: "do_thing", description: "d", inputSchema: {} }]

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
	vi.mocked(Client).mockImplementation(
		() =>
			({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue(undefined),
				request: vi.fn(async (req: { method: string }) => {
					if (req.method === "tools/list") return { tools: listedTools }
					if (req.method === "resources/list") return { resources: [] }
					if (req.method === "resources/templates/list") return { resourceTemplates: [] }
					return {}
				}),
			}) as never,
	)

	vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(SERVERS))

	const provider = {
		ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings"),
		ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/servers"),
		postMessageToWebview: vi.fn(),
		getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
		context: { globalStorageUri: { fsPath: "/mock" } },
	} as unknown as TaskProviderLike

	hub = new McpHub(provider)
	// The constructor kicks off its own global AND project initialization
	// asynchronously; wait for both so a later `findConnection(name)` without a
	// source cannot pick up a connection that appeared mid-test.
	await hub.waitUntilReady()
	await hub.updateServerConnections(SERVERS.mcpServers as never, "global")
})

afterEach(async () => {
	await hub.dispose()
})

describe("McpHub — tool metadata", () => {
	it("flattens every connected server's tools with its server name", () => {
		const metadata = hub.getMcpToolMetadata()

		expect(metadata).toEqual([expect.objectContaining({ name: "do_thing", serverName: SERVER })])
	})
})

describe("McpHub — deleteServer", () => {
	it("removes the server from the config file and says so", async () => {
		await hub.deleteServer(SERVER, "global")

		expect(lastWrittenJson()).toEqual({ mcpServers: {} })
		// i18n resolves to the key in the test locale; the notice fired is what
		// matters, not its rendered text.
		expect(notices()).toContain("info.server_deleted")
		// Scoped to the source that was deleted: the mocked config file feeds both
		// the global and the project scope here, and only the global one was asked
		// to go.
		expect(hub.getServers().find((s) => s.name === SERVER && (s.source ?? "global") === "global")).toBeUndefined()
	})

	it("warns rather than writing when the config no longer lists the server", async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: {} }))

		await hub.deleteServer(SERVER, "global")

		expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled()
		expect(notifier.messages.some((m) => m.level === "warn")).toBe(true)
	})

	it("creates the servers map when the config file has none", async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}))

		await hub.deleteServer(SERVER, "global")

		expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled()
	})

	it("refuses an unknown server by name", async () => {
		await expect(hub.deleteServer("nope")).rejects.toThrow(/not found/)
	})

	it("refuses when the settings file cannot be reached", async () => {
		vi.mocked(fs.access).mockRejectedValue(new Error("EACCES"))

		await expect(hub.deleteServer(SERVER, "global")).rejects.toThrow(/Settings file not accessible/)
	})

	it("refuses a config whose top level is not an object", async () => {
		vi.mocked(fs.readFile).mockResolvedValue("null")

		await expect(hub.deleteServer(SERVER, "global")).rejects.toThrow(/Invalid config structure/)
	})
})

describe("McpHub — updateServerConfigFromUI", () => {
	it("validates the MERGED config before writing anything", async () => {
		// `timeout` is bounded by the schema; the merge must be rejected whole
		// rather than written and then discovered at reconnect.
		await expect(hub.updateServerConfigFromUI(SERVER, { timeout: 99_999 }, "global")).rejects.toThrow()
		expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled()
	})

	it("writes a valid update and reconnects the server", async () => {
		await hub.updateServerConfigFromUI(SERVER, { timeout: 120 }, "global")

		expect(lastWrittenJson().mcpServers[SERVER].timeout).toBe(120)
		expect(hub.getServers().find((s) => s.name === SERVER)).toBeDefined()
	})

	it("drops a key whose update value is undefined", async () => {
		await hub.updateServerConfigFromUI(SERVER, { args: undefined }, "global")

		expect(lastWrittenJson().mcpServers[SERVER].args).toBeUndefined()
	})

	it("refuses an unknown server", async () => {
		await expect(hub.updateServerConfigFromUI("nope", {}, "global")).rejects.toThrow(/not found/)
	})
})

describe("McpHub — updateServerTimeout", () => {
	it("persists a new timeout", async () => {
		await hub.updateServerTimeout(SERVER, 90, "global")

		expect(lastWrittenJson().mcpServers[SERVER].timeout).toBe(90)
	})
})

describe("McpHub — tool group assignment", () => {
	it("writes the override and MINTS the category so a toggle exists immediately", async () => {
		await hub.setToolGroup(SERVER, "global", "do_thing", "salesforce")

		expect(lastWrittenJson().mcpServers[SERVER].toolGroups).toEqual({ do_thing: "salesforce" })
		expect(toolGroupRegistry.getDynamicGroups()).toContain("salesforce")
	})

	it("removes the override, and the empty map with it, when the group is cleared", async () => {
		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({
				mcpServers: { [SERVER]: { ...SERVERS.mcpServers[SERVER], toolGroups: { do_thing: "salesforce" } } },
			}),
		)

		await hub.setToolGroup(SERVER, "global", "do_thing", null)

		expect(lastWrittenJson().mcpServers[SERVER].toolGroups).toBeUndefined()
	})

	it("refuses a group name that is not a valid slug, before touching the file", async () => {
		await expect(hub.setToolGroup(SERVER, "global", "do_thing", "Not A Slug")).rejects.toThrow()
		expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled()
	})

	it("refuses an unknown server", async () => {
		await expect(hub.setToolGroup("nope", "global", "do_thing", "x")).rejects.toThrow(/not found/)
	})

	it("refuses when the file no longer carries the server", async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: {} }))

		await expect(hub.setToolGroup(SERVER, "global", "do_thing", "x")).rejects.toThrow(/not found in config/)
	})
})

describe("McpHub — per-tool prompt visibility", () => {
	it("adds a tool to the disabled list when it is switched off, and removes it when back on", async () => {
		await hub.toggleToolEnabledForPrompt(SERVER, "global", "do_thing", false)
		expect(lastWrittenJson().mcpServers[SERVER].disabledTools).toEqual(["do_thing"])

		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({
				mcpServers: { [SERVER]: { ...SERVERS.mcpServers[SERVER], disabledTools: ["do_thing"] } },
			}),
		)
		await hub.toggleToolEnabledForPrompt(SERVER, "global", "do_thing", true)
		expect(lastWrittenJson().mcpServers[SERVER].disabledTools).toEqual([])
	})

	it("re-throws so the caller can report a failed write", async () => {
		vi.mocked(fs.readFile).mockRejectedValue(new Error("disk gone"))

		await expect(hub.toggleToolEnabledForPrompt(SERVER, "global", "do_thing", false)).rejects.toThrow("disk gone")
	})
})

describe("McpHub — the MCP master toggle", () => {
	it("drops every connection when MCP is switched off, then re-tracks the servers", async () => {
		// `refreshAllConnections` consults the provider, so the state must agree
		// with the toggle or the servers are simply reconnected.
		vi.mocked(hub["providerRef"].deref()!.getState as never as () => Promise<unknown>).mockResolvedValue({
			mcpEnabled: false,
		} as never)

		await hub.handleMcpEnabledChange(false)

		// The servers stay listed (so the panel can still show them) but nothing
		// is connected.
		expect(hub.getAllServers().every((s) => s.status !== "connected")).toBe(true)
	})

	it("reconnects when MCP is switched back on", async () => {
		await hub.handleMcpEnabledChange(false)
		await hub.handleMcpEnabledChange(true)

		expect(hub.getServers().find((s) => s.name === SERVER)).toBeDefined()
	})
})

describe("McpHub — config-file change handling", () => {
	it("ignores a change the hub itself just wrote", async () => {
		vi.useFakeTimers()
		try {
			const handle = vi.spyOn(
				hub as never as { handleConfigFileChange: () => Promise<void> },
				"handleConfigFileChange",
			)
			;(hub as never as { isProgrammaticUpdate: boolean }).isProgrammaticUpdate = true
			;(hub as never as { debounceConfigChange: (p: string, s: string) => void }).debounceConfigChange(
				"/mock/settings/mcp_settings.json",
				"global",
			)

			await vi.advanceTimersByTimeAsync(1000)
			expect(handle).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("coalesces repeated edits of the same file into one handling", async () => {
		vi.useFakeTimers()
		try {
			const handle = vi
				.spyOn(hub as never as { handleConfigFileChange: () => Promise<void> }, "handleConfigFileChange")
				.mockResolvedValue(undefined)
			const debounce = (
				hub as never as { debounceConfigChange: (p: string, s: string) => void }
			).debounceConfigChange.bind(hub)

			debounce("/mock/project/.shofer/mcp.json", "project")
			debounce("/mock/project/.shofer/mcp.json", "project")
			debounce("/mock/project/.shofer/mcp.json", "project")

			await vi.advanceTimersByTimeAsync(1000)
			expect(handle).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("reports invalid JSON in a project config without throwing", async () => {
		vi.mocked(fs.readFile).mockResolvedValue("{ not json")

		await (
			hub as never as { handleConfigFileChange: (p: string, s: string) => Promise<void> }
		).handleConfigFileChange("/mock/project/.shofer/mcp.json", "project")

		expect(notifier.messages.some((m) => m.level === "error")).toBe(true)
	})

	it("reports a project config that fails the schema", async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: { bad: { type: "carrier-pigeon" } } }))

		await (
			hub as never as { handleConfigFileChange: (p: string, s: string) => Promise<void> }
		).handleConfigFileChange("/mock/project/.shofer/mcp.json", "project")

		expect(notifier.messages.some((m) => m.level === "error")).toBe(true)
	})

	it("treats a DELETED project config as 'drop the project servers'", async () => {
		const enoent = Object.assign(new Error("gone"), { code: "ENOENT" })
		// Only the config read fails; the cleanup path that follows reads again.
		vi.mocked(fs.readFile).mockRejectedValueOnce(enoent)

		await (
			hub as never as { handleConfigFileChange: (p: string, s: string) => Promise<void> }
		).handleConfigFileChange("/mock/project/.shofer/mcp.json", "project")

		expect(notifier.messages.some((m) => m.level === "info")).toBe(true)
	})
})

describe("McpHub — dispose", () => {
	it("closes every connection and is idempotent", async () => {
		await hub.dispose()
		expect(hub.getAllServers()).toEqual([])

		// A second dispose returns immediately rather than double-closing.
		await expect(hub.dispose()).resolves.toBeUndefined()
	})
})
