// npx vitest src/utils/__tests__/networkProxy.transport.test.ts

/**
 * The debug proxy's TRANSPORT wiring — the half of `networkProxy` that the
 * sibling `networkProxy.spec.ts` cannot reach because it fires the module
 * without awaiting it: `global-agent`'s one-shot bootstrap, undici's global
 * dispatcher, and the `globalThis.fetch` patch that makes Node's built-in
 * `fetch()` follow the proxy.
 *
 * Three invariants carry the file:
 *
 *  - **The proxy URL is REDACTED wherever it is logged.** A debug proxy URL may
 *    carry basic-auth credentials, and the output channel is a document users
 *    paste into bug reports. `redactProxyUrl` is the only spelling of the URL
 *    that may reach a log line.
 *  - **Every global this module mutates is RESTORED.** It patches
 *    `globalThis.fetch` and `NODE_TLS_REJECT_UNAUTHORIZED` — process-wide state
 *    that outlives the extension unless the disposables it registers put it
 *    back. A leaked `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate
 *    verification for the whole host.
 *  - **Bootstrapping happens AT MOST ONCE.** `global-agent` cannot be
 *    un-bootstrapped, so a second initialize updates the environment variables
 *    and returns rather than calling it again.
 *
 * The module keeps its state in module-level variables, so every test re-imports
 * it through `vi.resetModules()` to get a clean one.
 */

import type * as vscode from "vscode"

const hoisted = vi.hoisted(() => ({
	bootstrap: vi.fn(() => undefined),
	setGlobalDispatcher: vi.fn((..._args: unknown[]) => undefined),
	proxyAgentArgs: [] as unknown[],
	undiciFetch: vi.fn(async (..._args: unknown[]) => undefined),
	logs: [] as string[],
}))

vi.mock("global-agent", () => ({ bootstrap: hoisted.bootstrap }))

vi.mock("undici", () => ({
	ProxyAgent: class {
		constructor(options: unknown) {
			hoisted.proxyAgentArgs.push(options)
		}
	},
	setGlobalDispatcher: hoisted.setGlobalDispatcher,
	fetch: hoisted.undiciFetch,
}))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({ get: () => undefined })),
		onDidChangeConfiguration: vi.fn((listener: unknown) => {
			configListeners.push(listener as (e: { affectsConfiguration: (k: string) => boolean }) => void)
			return { dispose: vi.fn() }
		}),
	},
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	utilLog: {
		info: (m: string) => hoisted.logs.push(m),
		warn: (m: string) => hoisted.logs.push(m),
		error: (m: string) => hoisted.logs.push(m),
		debug: vi.fn(),
	},
}))

import type { InMemoryConfig } from "@shofer/types"

/** Listeners the mocked `onDidChangeConfiguration` collected, per test. */
let configListeners: Array<(e: { affectsConfiguration: (key: string) => boolean }) => void> = []

const DEVELOPMENT = 2
const PRODUCTION = 1

function makeContext(extensionMode = DEVELOPMENT) {
	return {
		extensionMode,
		subscriptions: [] as Array<{ dispose: () => void }>,
		extensionPath: "/ext",
		globalStorageUri: { fsPath: "/global" },
	} as unknown as vscode.ExtensionContext & { subscriptions: Array<{ dispose: () => void }> }
}

function makeOutputChannel() {
	return { appendLine: vi.fn(), name: "test" } as unknown as vscode.OutputChannel
}

/**
 * A fresh copy of the module — its proxy/patch flags are module-level state.
 *
 * The host must be installed through the SAME `@shofer/types` instance the fresh
 * `networkProxy` will import: `vi.resetModules()` gives the re-imported module a
 * new copy of every dependency, so a `setHost` called on the statically imported
 * one is written into a registry the module under test never reads.
 */
async function freshModule(settings: Record<string, unknown> = {}) {
	vi.resetModules()
	const types = await import("@shofer/types")
	const host = types.createInMemoryHost()
	const config = host.config as InMemoryConfig
	for (const [key, value] of Object.entries(settings)) {
		config.set("shofer", key, value)
	}
	types.setHost(host)
	return { module: await import("../networkProxy"), config }
}

const savedFetch = globalThis.fetch

beforeEach(() => {
	vi.clearAllMocks()
	configListeners = []
	hoisted.logs = []
	hoisted.proxyAgentArgs = []
	delete process.env.GLOBAL_AGENT_HTTP_PROXY
	delete process.env.GLOBAL_AGENT_HTTPS_PROXY
	delete process.env.GLOBAL_AGENT_NO_PROXY
	delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
})

afterEach(() => {
	// Every test in this file may patch the global; put the real one back so a
	// later file is not handed the undici double.
	globalThis.fetch = savedFetch
})

describe("global-agent bootstrap", () => {
	it("bootstraps once and points the GLOBAL_AGENT_* variables at the proxy", async () => {
		const { module } = await freshModule({ "debugProxy.enabled": true, "debugProxy.serverUrl": "http://p:8888" })

		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		expect(hoisted.bootstrap).toHaveBeenCalledTimes(1)
		expect(process.env.GLOBAL_AGENT_HTTP_PROXY).toBe("http://p:8888")
		expect(process.env.GLOBAL_AGENT_HTTPS_PROXY).toBe("http://p:8888")
		// Everything is proxied — an inherited no-proxy list would silently
		// exempt whichever host it names from the debugging session.
		expect(process.env.GLOBAL_AGENT_NO_PROXY).toBe("")
	})

	it("does NOT bootstrap a second time — global-agent cannot be un-bootstrapped", async () => {
		const { module } = await freshModule({ "debugProxy.enabled": true, "debugProxy.serverUrl": "http://p:8888" })

		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())
		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		expect(hoisted.bootstrap).toHaveBeenCalledTimes(1)
		expect(hoisted.logs.join(" ")).toContain("already initialized")
	})

	it("SURVIVES a global-agent that throws — the session continues unproxied", async () => {
		hoisted.bootstrap.mockImplementationOnce(() => {
			throw new Error("no bootstrap here")
		})
		const { module } = await freshModule({ "debugProxy.enabled": true, "debugProxy.serverUrl": "http://p:8888" })

		await expect(module.initializeNetworkProxy(makeContext(), makeOutputChannel())).resolves.toBeUndefined()

		expect(hoisted.logs.join(" ")).toContain("bootstrap() FAILED")
	})

	it("stays out of the way entirely in production, whatever the settings say", async () => {
		const { module } = await freshModule({ "debugProxy.enabled": true, "debugProxy.serverUrl": "http://p:8888" })
		const context = makeContext(PRODUCTION)

		await module.initializeNetworkProxy(context, makeOutputChannel())

		expect(hoisted.bootstrap).not.toHaveBeenCalled()
		expect(hoisted.setGlobalDispatcher).not.toHaveBeenCalled()
		expect(context.subscriptions).toHaveLength(0)
		expect(process.env.GLOBAL_AGENT_HTTP_PROXY).toBeUndefined()
	})
})

describe("undici dispatcher and the fetch patch", () => {
	it("installs a ProxyAgent and patches globalThis.fetch", async () => {
		const { module } = await freshModule({ "debugProxy.enabled": true, "debugProxy.serverUrl": "http://p:8888" })

		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		expect(hoisted.setGlobalDispatcher).toHaveBeenCalledTimes(1)
		expect(hoisted.proxyAgentArgs[0]).toMatchObject({ uri: "http://p:8888" })
		expect(globalThis.fetch).toBe(hoisted.undiciFetch)
	})

	it("leaves TLS verification ALONE unless tlsInsecure was asked for", async () => {
		const { module } = await freshModule({ "debugProxy.enabled": true, "debugProxy.serverUrl": "http://p:8888" })

		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
		expect(hoisted.proxyAgentArgs[0]).toMatchObject({ requestTls: undefined, proxyTls: undefined })
	})

	it("relaxes BOTH legs of the TLS chain when tlsInsecure is on — the proxy hop and the request", async () => {
		const { module } = await freshModule({
			"debugProxy.enabled": true,
			"debugProxy.serverUrl": "https://p:8888",
			"debugProxy.tlsInsecure": true,
		})

		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0")
		expect(hoisted.proxyAgentArgs[0]).toMatchObject({
			requestTls: { rejectUnauthorized: false },
			proxyTls: { rejectUnauthorized: false },
		})
	})

	it("does not touch the dispatcher when the proxy is off", async () => {
		const { module } = await freshModule({ "debugProxy.enabled": false })

		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		expect(hoisted.setGlobalDispatcher).not.toHaveBeenCalled()
		expect(globalThis.fetch).toBe(savedFetch)
	})

	it("RESTORES the original fetch and the TLS variable when the extension unloads", async () => {
		const { module } = await freshModule({
			"debugProxy.enabled": true,
			"debugProxy.serverUrl": "http://p:8888",
			"debugProxy.tlsInsecure": true,
		})
		const context = makeContext()

		await module.initializeNetworkProxy(context, makeOutputChannel())
		expect(globalThis.fetch).toBe(hoisted.undiciFetch)

		for (const subscription of context.subscriptions) {
			subscription.dispose()
		}

		expect(globalThis.fetch).toBe(savedFetch)
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
	})

	it("puts back a PRE-EXISTING NODE_TLS_REJECT_UNAUTHORIZED rather than deleting it", async () => {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1"
		const { module } = await freshModule({
			"debugProxy.enabled": true,
			"debugProxy.serverUrl": "http://p:8888",
			"debugProxy.tlsInsecure": true,
		})
		const context = makeContext()

		await module.initializeNetworkProxy(context, makeOutputChannel())
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0")

		for (const subscription of context.subscriptions) {
			subscription.dispose()
		}

		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
	})

	it("refuses to reconfigure the dispatcher a second time", async () => {
		const { module } = await freshModule({ "debugProxy.enabled": true, "debugProxy.serverUrl": "http://p:8888" })

		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())
		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		expect(hoisted.setGlobalDispatcher).toHaveBeenCalledTimes(1)
		expect(hoisted.logs.join(" ")).toContain("already configured")
	})

	it("survives an undici that refuses to configure", async () => {
		hoisted.setGlobalDispatcher.mockImplementationOnce(() => {
			throw new Error("dispatcher rejected")
		})
		const { module } = await freshModule({ "debugProxy.enabled": true, "debugProxy.serverUrl": "http://p:8888" })

		await expect(module.initializeNetworkProxy(makeContext(), makeOutputChannel())).resolves.toBeUndefined()

		expect(hoisted.logs.join(" ")).toContain("Failed to configure undici proxy dispatcher")
		expect(globalThis.fetch).toBe(savedFetch)
	})
})

describe("credential redaction", () => {
	it("NEVER logs the credentials embedded in a proxy URL", async () => {
		const { module } = await freshModule({
			"debugProxy.enabled": true,
			"debugProxy.serverUrl": "http://alice:hunter2@proxy.example:8888",
		})

		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		const logged = hoisted.logs.join("\n")
		expect(logged).toContain("proxy.example:8888")
		expect(logged).not.toContain("hunter2")
		expect(logged).not.toContain("alice")
	})

	it("redacts a URL the URL parser cannot even parse", async () => {
		const { module } = await freshModule({
			"debugProxy.enabled": true,
			"debugProxy.serverUrl": "not-a-url//alice:hunter2@proxy",
		})

		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		const logged = hoisted.logs.join("\n")
		expect(logged).toContain("REDACTED@")
		expect(logged).not.toContain("hunter2")
	})
})

describe("reacting to a settings change mid-session", () => {
	/** Fire the registered listener as if the named setting had changed. */
	function fireChange(key = "shofer.debugProxy.enabled") {
		for (const listener of configListeners) {
			listener({ affectsConfiguration: (candidate: string) => candidate.endsWith(key.split(".").pop()!) })
		}
	}

	it("configures the proxy when it is switched ON during the session", async () => {
		const { module, config } = await freshModule({ "debugProxy.enabled": false })
		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())
		expect(hoisted.bootstrap).not.toHaveBeenCalled()

		config.set("shofer", "debugProxy.enabled", true)
		config.set("shofer", "debugProxy.serverUrl", "http://late:8888")
		fireChange()
		// The listener kicks off `configureGlobalProxy`/`configureUndiciProxy`
		// without awaiting them (there is nothing to await it from), and both
		// dynamic-`import` their transport, so the work lands a few turns later.
		await new Promise((resolve) => setTimeout(resolve, 20))

		expect(process.env.GLOBAL_AGENT_HTTP_PROXY).toBe("http://late:8888")
		expect(globalThis.fetch).toBe(hoisted.undiciFetch)
	})

	it("UNDOES the fetch patch and the TLS override when it is switched OFF", async () => {
		const { module, config } = await freshModule({
			"debugProxy.enabled": true,
			"debugProxy.serverUrl": "http://p:8888",
			"debugProxy.tlsInsecure": true,
		})
		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())
		expect(globalThis.fetch).toBe(hoisted.undiciFetch)

		config.set("shofer", "debugProxy.enabled", false)
		fireChange()

		expect(globalThis.fetch).toBe(savedFetch)
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
		// The routing itself cannot be undone, and the log says so rather than
		// implying the session is clean again.
		expect(hoisted.logs.join(" ")).toContain("Restart VS Code")
	})

	it("ignores a change to some unrelated setting", async () => {
		const { module } = await freshModule({ "debugProxy.enabled": false })
		await module.initializeNetworkProxy(makeContext(), makeOutputChannel())

		for (const listener of configListeners) {
			listener({ affectsConfiguration: () => false })
		}

		expect(hoisted.bootstrap).not.toHaveBeenCalled()
	})
})
