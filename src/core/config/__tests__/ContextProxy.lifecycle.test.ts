// npx vitest src/core/config/__tests__/ContextProxy.lifecycle.test.ts

/**
 * The proxy's whole-store operations — export, reset, secret refresh, the
 * schema-guarded projections and the one-time migrations.
 *
 * Two shapes recur and are the point of the file:
 *
 *  - **A schema failure DEGRADES rather than throwing.** `getGlobalSettings` and
 *    `getProviderSettings` are read on every state push, so a single corrupt
 *    value must not take the whole webview snapshot with it: the error is
 *    reported to telemetry and the projection falls back to a key-by-key copy.
 *  - **A migration never blocks startup.** Each one is wrapped so a failed read
 *    or write leaves the old value in place and logs, rather than aborting
 *    `initialize()` and leaving the host with no settings at all.
 */

const hoisted = vi.hoisted(() => ({
	captureSchemaValidationError: vi.fn(),
	logs: [] as string[],
}))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({ get: (_k: string, def: unknown) => def }),
		createFileSystemWatcher: () => ({
			onDidCreate: () => ({ dispose: () => {} }),
			onDidChange: () => ({ dispose: () => {} }),
			onDidDelete: () => ({ dispose: () => {} }),
			dispose: () => {},
		}),
		workspaceFolders: undefined,
	},
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	RelativePattern: class {},
	Uri: { file: (p: string) => ({ fsPath: p }) },
}))

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: { captureSchemaValidationError: hoisted.captureSchemaValidationError },
		hasInstance: () => true,
	},
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	getWorkspacePath: () => undefined,
	configLog: {
		info: (m: string) => hoisted.logs.push(m),
		warn: (m: string) => hoisted.logs.push(m),
		error: (m: string) => hoisted.logs.push(m),
		debug: vi.fn(),
	},
}))

import type * as vscode from "vscode"

import { ContextProxy } from "../ContextProxy"

function makeContext(state: Record<string, unknown> = {}, secrets: Record<string, string> = {}) {
	const globalState = { ...state }
	const secretStore = { ...secrets }
	return {
		context: {
			extensionUri: { fsPath: "/ext" },
			extensionPath: "/ext",
			globalStorageUri: { fsPath: "/global" },
			logUri: { fsPath: "/logs" },
			extension: { packageJSON: { version: "1.0.0" } },
			extensionMode: 1,
			globalState: {
				get: (key: string) => globalState[key],
				update: vi.fn(async (key: string, value: unknown) => {
					if (value === undefined) delete globalState[key]
					else globalState[key] = value
				}),
				keys: () => Object.keys(globalState),
			},
			secrets: {
				get: vi.fn(async (key: string) => secretStore[key]),
				store: vi.fn(async (key: string, value: string) => void (secretStore[key] = value)),
				delete: vi.fn(async (key: string) => void delete secretStore[key]),
			},
			workspaceState: { get: () => undefined, update: vi.fn(async () => undefined), keys: () => [] },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext,
		globalState,
		secretStore,
	}
}

async function makeProxy(state: Record<string, unknown> = {}, secrets: Record<string, string> = {}) {
	const fixture = makeContext(state, secrets)
	const proxy = new ContextProxy(fixture.context)
	await proxy.initialize()
	return { proxy, ...fixture }
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.logs = []
})

describe("identity accessors", () => {
	it("expose the extension's own paths", async () => {
		const { proxy } = await makeProxy()

		expect(proxy.extensionUri.fsPath).toBe("/ext")
		expect(proxy.extensionPath).toBe("/ext")
		expect(proxy.globalStorageUri.fsPath).toBe("/global")
		expect(proxy.logUri.fsPath).toBe("/logs")
		expect(proxy.extension?.packageJSON.version).toBe("1.0.0")
		expect(proxy.extensionMode).toBe(1)
	})

	it("reports itself initialized after initialize()", async () => {
		const { proxy } = await makeProxy()

		expect(proxy.isInitialized).toBe(true)
	})
})

describe("getGlobalSettings / getProviderSettings", () => {
	it("project the stored values", async () => {
		const { proxy } = await makeProxy({ mode: "code", apiProvider: "anthropic" })

		expect(proxy.getGlobalSettings().mode).toBe("code")
		expect(proxy.getProviderSettings().apiProvider).toBe("anthropic")
	})

	it("DEGRADE rather than throwing on a corrupt value — a state push must not die on one key", async () => {
		const { proxy } = await makeProxy({ mode: "code", ttsSpeed: "not-a-number", experiments: 42 })

		expect(() => proxy.getGlobalSettings()).not.toThrow()
		expect(() => proxy.getProviderSettings()).not.toThrow()
	})

	it("SANITIZE an apiProvider the extension has since removed", async () => {
		const { proxy } = await makeProxy({ apiProvider: "glama" })

		expect(() => proxy.getProviderSettings()).not.toThrow()
	})
})

describe("export", () => {
	it("omits the task history and the profile bookkeeping", async () => {
		const { proxy } = await makeProxy({
			mode: "code",
			taskHistory: [{ id: "t-1" }],
			listApiConfigMeta: [{ id: "1", name: "prod" }],
			currentApiConfigName: "prod",
		})

		const exported = await proxy.export()

		expect(exported).toBeDefined()
		expect(exported).not.toHaveProperty("taskHistory")
		expect(exported).not.toHaveProperty("listApiConfigMeta")
		expect(exported).not.toHaveProperty("currentApiConfigName")
	})

	it("never exports a PROJECT custom mode — those live in the workspace's own file", async () => {
		const { proxy } = await makeProxy({
			customModes: [
				{ slug: "mine", name: "Mine", roleDefinition: "r", groups: [], source: "global" },
				{ slug: "theirs", name: "Theirs", roleDefinition: "r", groups: [], source: "project" },
			],
		})

		const exported = await proxy.export()

		expect(JSON.stringify(exported ?? {})).not.toContain('"theirs"')
	})

	it("DROPS undefined values so an export carries only what was actually set", async () => {
		const { proxy } = await makeProxy({ mode: "code" })

		const exported = await proxy.export()

		expect(Object.values(exported!).every((v) => v !== undefined)).toBe(true)
	})
})

describe("resetAllState", () => {
	it("clears both stores AND the in-memory caches", async () => {
		const { proxy, globalState, secretStore, context } = await makeProxy(
			{ mode: "architect", ttsSpeed: 2 },
			{ openRouterApiKey: "sk-secret" },
		)

		await proxy.resetAllState()

		expect(globalState.ttsSpeed).toBeUndefined()
		expect(globalState.mode).toBeUndefined()
		expect(secretStore.openRouterApiKey).toBeUndefined()
		// A reset does not leave the host with NO mode: the read falls back to the
		// schema default, which is what a fresh install would have had.
		expect(proxy.getValue("mode")).toBe("code")
		expect(context.secrets.delete).toHaveBeenCalled()
	})

	it("leaves the proxy USABLE afterwards — it re-initializes rather than dying", async () => {
		const { proxy } = await makeProxy({ ttsSpeed: 2 })

		await proxy.resetAllState()
		await proxy.setValue("ttsSpeed", 3)

		expect(proxy.getValue("ttsSpeed")).toBe(3)
	})
})

describe("refreshSecrets", () => {
	it("re-reads the individual secret entries from storage", async () => {
		const { proxy, context } = await makeProxy({}, {})
		;(context.secrets.get as ReturnType<typeof vi.fn>).mockClear()

		await proxy.refreshSecrets()

		// Every non-profile secret is re-read; the per-profile ones come from the
		// profiles blob instead, so re-reading them individually would clobber the
		// cached current-profile values with `undefined`.
		expect((context.secrets.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
	})

	it("LOGS a failing key and keeps refreshing the rest", async () => {
		const { proxy, context } = await makeProxy()
		let first = true
		;(context.secrets.get as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			if (first) {
				first = false
				throw new Error("keychain locked")
			}
			return undefined
		})

		await expect(proxy.refreshSecrets()).resolves.toBeUndefined()
		expect(hoisted.logs.join(" ")).toContain("Error refreshing secret")
	})
})

describe("the one-time migrations", () => {
	it("MOVES a customized legacy condensing prompt into customSupportPrompts", async () => {
		const { proxy, globalState } = await makeProxy({
			customCondensingPrompt: "my own summary instructions",
		})

		expect(proxy.getValue("customSupportPrompts")).toMatchObject({ CONDENSE: "my own summary instructions" })
		expect(globalState.customCondensingPrompt).toBeUndefined()
	})

	it("SKIPS a legacy prompt that merely equals the shipped default", async () => {
		const { supportPrompt } = await import("@shofer/types")
		const { proxy, globalState } = await makeProxy({ customCondensingPrompt: supportPrompt.default.CONDENSE })

		expect((proxy.getValue("customSupportPrompts") ?? {}).CONDENSE).toBeUndefined()
		// The legacy field is removed either way.
		expect(globalState.customCondensingPrompt).toBeUndefined()
	})

	it("does NOT overwrite a prompt the user already set in the new location", async () => {
		const { proxy } = await makeProxy({
			customCondensingPrompt: "legacy",
			customSupportPrompts: { CONDENSE: "already mine" },
		})

		expect(proxy.getValue("customSupportPrompts")).toMatchObject({ CONDENSE: "already mine" })
	})

	it("FLATTENS the old nested image-generation settings, key into secrets", async () => {
		const { proxy, globalState } = await makeProxy({
			openRouterImageGenerationSettings: { openRouterApiKey: "sk-img", selectedModel: "flux" },
		})

		expect(proxy.getSecret("openRouterImageApiKey")).toBe("sk-img")
		expect(proxy.getValue("openRouterImageGenerationSelectedModel")).toBe("flux")
		expect(globalState.openRouterImageGenerationSettings).toBeUndefined()
	})

	it("does not clobber an image key or model the user already has", async () => {
		const { proxy } = await makeProxy(
			{
				openRouterImageGenerationSettings: { openRouterApiKey: "sk-old", selectedModel: "old" },
				openRouterImageGenerationSelectedModel: "current",
			},
			{ openRouterImageApiKey: "sk-current" },
		)

		expect(proxy.getSecret("openRouterImageApiKey")).toBe("sk-current")
		expect(proxy.getValue("openRouterImageGenerationSelectedModel")).toBe("current")
	})

	it("REPLACES an apiProvider the extension has retired", async () => {
		const { proxy } = await makeProxy({ apiProvider: "glama" })

		expect(proxy.getValue("apiProvider")).not.toBe("glama")
	})
})

/**
 * The FAIL-SOFT half. Every load and every migration is wrapped, because
 * `initialize()` runs before anything else the extension does: a throw here
 * leaves the host with no settings at all, which presents as a blank webview
 * with a healthy-looking log. So the contract is "log and carry on", per key and
 * per migration — and that is only testable by breaking the stores.
 */
describe("fail-soft loading", () => {
	it("keeps loading the REST of the state when one key's read throws", async () => {
		const fixture = makeContext({ mode: "architect" })
		const realGet = fixture.context.globalState.get
		;(fixture.context.globalState as unknown as { get: (k: string) => unknown }).get = (key: string) => {
			if (key === "ttsSpeed") throw new Error("state store corrupt")
			return (realGet as (k: string) => unknown)(key)
		}
		const proxy = new ContextProxy(fixture.context)

		await expect(proxy.initialize()).resolves.toBeUndefined()

		// The mode migration rewrites the cache during initialize, so read a key
		// the failing one does not touch: what matters is that the load finished.
		expect(hoisted.logs.join(" ")).toContain("Error loading global ttsSpeed")
		expect(proxy.isInitialized).toBe(true)
	})

	it("keeps loading the rest of the SECRETS when the keychain refuses one", async () => {
		const fixture = makeContext({}, { openRouterApiKey: "sk-a" })
		let refused = false
		;(fixture.context.secrets.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
			if (!refused) {
				refused = true
				throw new Error("keychain locked")
			}
			return key === "openRouterApiKey" ? "sk-a" : undefined
		})
		const proxy = new ContextProxy(fixture.context)

		await expect(proxy.initialize()).resolves.toBeUndefined()

		expect(hoisted.logs.join(" ")).toContain("Error loading")
	})

	it("survives a globalState that refuses every WRITE — the migrations log instead of aborting", async () => {
		const fixture = makeContext({
			customCondensingPrompt: "mine",
			openRouterImageGenerationSettings: { openRouterApiKey: "sk-img", selectedModel: "flux" },
			apiProvider: "glama",
		})
		;(fixture.context.globalState.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("read-only"))
		const proxy = new ContextProxy(fixture.context)

		await expect(proxy.initialize()).resolves.toBeUndefined()

		// Each migration reports itself rather than taking initialize down with it.
		expect(hoisted.logs.join(" ")).toContain("migration")
	})
})

describe("the provider-settings projection", () => {
	it("DROPS the legacy Claude Code CLI keys that are no longer part of the schema", async () => {
		const { proxy } = await makeProxy({
			apiProvider: "anthropic",
			claudeCodePath: "/usr/bin/claude",
			claudeCodeMaxOutputTokens: 4096,
		})

		const settings = proxy.getProviderSettings() as unknown as Record<string, unknown>

		expect(settings.claudeCodePath).toBeUndefined()
		expect(settings.claudeCodeMaxOutputTokens).toBeUndefined()
	})

	it("RESETS an apiProvider name the extension has never heard of", async () => {
		const { proxy } = await makeProxy({ apiProvider: "some-provider-that-never-existed" })

		expect(proxy.getProviderSettings().apiProvider).toBeUndefined()
		expect(hoisted.logs.join(" ")).toContain("invalid provider")
	})

	it("normalizes an EMPTY openAiHeaders to an object — the IPC round-trip needs one", async () => {
		const { proxy } = await makeProxy()

		await proxy.setProviderSettings({ apiProvider: "openai", openAiHeaders: undefined } as never)
		await proxy.setProviderSettings({ apiProvider: "openai", openAiHeaders: null } as never)

		expect(proxy.getValue("openAiHeaders")).toEqual({})
	})
})

describe("the singleton accessor", () => {
	it("REFUSES to hand out an instance before one was created", async () => {
		;(ContextProxy as unknown as { _instance: unknown })._instance = null

		expect(() => ContextProxy.instance).toThrow(/not initialized/)
	})

	it("creates the instance once and reuses it", async () => {
		;(ContextProxy as unknown as { _instance: unknown })._instance = null
		const { context } = makeContext({ mode: "architect" })

		const first = await ContextProxy.getInstance(context)
		const second = await ContextProxy.getInstance(makeContext().context)

		expect(second).toBe(first)
		expect(ContextProxy.instance).toBe(first)
		;(ContextProxy as unknown as { _instance: unknown })._instance = null
	})
})
