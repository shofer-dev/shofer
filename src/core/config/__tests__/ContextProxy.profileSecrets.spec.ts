// npx vitest core/config/__tests__/ContextProxy.profileSecrets.spec.ts
//
// Part B — per-profile LLM secrets are de-duplicated: the profiles blob
// (ProviderSettingsManager) is their sole PERSISTED store, and ContextProxy's
// secretCache holds only the CURRENT profile's copy in memory, re-sourced from the
// blob on restart via the live-profile marker. These tests exercise the real
// ContextProxy + real ProviderSettingsManager over a stateful in-memory
// ExtensionContext, so a "restart" is a fresh ContextProxy/PSM pair over the SAME
// storage — the only faithful way to prove the current-vs-default distinction and
// the no-A/B-mix invariant survive a reload.

import type { ExtensionContext } from "vscode"

import { PROFILE_SECRET_KEYS, type ProviderSettings } from "@shofer/types"

import { ContextProxy } from "../ContextProxy"
import { ProviderSettingsManager } from "../ProviderSettingsManager"

vi.mock("vscode", () => ({
	Uri: { file: vi.fn((p) => ({ path: p })) },
	ExtensionMode: { Development: 1, Production: 2, Test: 3 },
	EventEmitter: class {
		event = () => () => {}
		fire = () => {}
		dispose = () => {}
	},
}))

// Keep the layered `.shofer/settings.json` overlay inert by pointing homedir at a
// nonexistent path (mirrors ContextProxy.write.spec.ts).
const hoisted = vi.hoisted(() => ({ home: "/nonexistent-home-profile-secrets" }))
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return {
		...actual,
		default: { ...actual, homedir: () => hoisted.home },
		homedir: () => hoisted.home,
	}
})

/**
 * A stateful in-memory ExtensionContext: globalState and secrets are backed by real
 * Maps that persist across ContextProxy/PSM instances, so a "restart" reuses the
 * same underlying storage.
 */
function createStatefulContext() {
	const globalStore = new Map<string, unknown>()
	const secretStore = new Map<string, string>()

	const globalState = {
		get: (key: string) => globalStore.get(key),
		update: async (key: string, value: unknown) => {
			if (value === undefined) globalStore.delete(key)
			else globalStore.set(key, value)
		},
		keys: () => [...globalStore.keys()],
	}

	const secrets = {
		get: async (key: string) => secretStore.get(key),
		store: async (key: string, value: string) => {
			secretStore.set(key, value)
		},
		delete: async (key: string) => {
			secretStore.delete(key)
		},
	}

	const context = {
		globalState,
		secrets,
		extensionUri: { path: "/ext", fsPath: "/ext" },
		extensionPath: "/ext",
		globalStorageUri: { path: "/storage", fsPath: "/nonexistent-storage-profile-secrets" },
		logUri: { path: "/logs" },
		extension: { packageJSON: { version: "1.0.0" } },
		extensionMode: 1,
	} as unknown as ExtensionContext

	return { context, globalStore, secretStore }
}

/** Build + initialize a ContextProxy and attach a fresh PSM over the given context. */
async function boot(context: ExtensionContext): Promise<{ proxy: ContextProxy; psm: ProviderSettingsManager }> {
	// Defeat the ContextProxy singleton so each "restart" is a genuinely fresh proxy.
	;(ContextProxy as unknown as { _instance: ContextProxy | null })._instance = null
	const proxy = new ContextProxy(context)
	await proxy.initialize()
	const psm = new ProviderSettingsManager(context)
	await psm.initialize()
	await proxy.attachProviderSettingsManager(psm)
	return { proxy, psm }
}

/**
 * Replicate the essential of `ShoferProvider.activateProviderProfile`: activate the
 * named profile in the blob (sets blob.currentApiConfigName), set the ContextProxy
 * default name, and load the profile into the live apiConfiguration + live marker.
 */
async function activate(proxy: ContextProxy, psm: ProviderSettingsManager, name: string): Promise<void> {
	const { name: activated, id: _id, ...settings } = await psm.activateProfile({ name })
	await proxy.setValue("currentApiConfigName", activated)
	await proxy.setProviderSettings(settings as ProviderSettings, activated)
}

const profileA: ProviderSettings = { apiProvider: "openai", openAiApiKey: "key-A", openAiModelId: "model-A" }
const profileB: ProviderSettings = { apiProvider: "openai", openAiApiKey: "key-B", openAiModelId: "model-B" }

describe("ContextProxy per-profile secrets (Part B)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("(a) selecting profile A yields A's key AND A's settings, across a save + reload", async () => {
		const { context, secretStore } = createStatefulContext()

		let { proxy, psm } = await boot(context)
		await psm.saveConfig("A", { ...profileA })
		await psm.saveConfig("B", { ...profileB })
		await activate(proxy, psm, "A")

		// Live: A's secret and A's non-secret settings — no A/B mix.
		expect(proxy.getSecret("openAiApiKey")).toBe("key-A")
		expect(proxy.getProviderSettings().openAiApiKey).toBe("key-A")
		expect(proxy.getProviderSettings().openAiModelId).toBe("model-A")

		// The per-profile secret was NOT written to an individual SecretStorage entry.
		expect(secretStore.has("openAiApiKey")).toBe(false)

		// Reload (restart): fresh proxy + PSM over the same storage.
		;({ proxy, psm } = await boot(context))
		expect(proxy.getSecret("openAiApiKey")).toBe("key-A")
		expect(proxy.getProviderSettings().openAiApiKey).toBe("key-A")
		expect(proxy.getProviderSettings().openAiModelId).toBe("model-A")
	})

	it("(b) switching to profile B yields B's key AND B's settings, across a reload", async () => {
		const { context } = createStatefulContext()

		let { proxy, psm } = await boot(context)
		await psm.saveConfig("A", { ...profileA })
		await psm.saveConfig("B", { ...profileB })
		await activate(proxy, psm, "A")
		await activate(proxy, psm, "B")

		expect(proxy.getSecret("openAiApiKey")).toBe("key-B")
		expect(proxy.getProviderSettings().openAiApiKey).toBe("key-B")
		expect(proxy.getProviderSettings().openAiModelId).toBe("model-B")

		// Reload — still fully B, no A residue.
		;({ proxy, psm } = await boot(context))
		expect(proxy.getSecret("openAiApiKey")).toBe("key-B")
		expect(proxy.getProviderSettings().openAiApiKey).toBe("key-B")
		expect(proxy.getProviderSettings().openAiModelId).toBe("model-B")
	})

	it("(c) a default-name change stays name-only — it does NOT change the live apiConfiguration", async () => {
		const { context } = createStatefulContext()

		let { proxy, psm } = await boot(context)
		await psm.saveConfig("A", { ...profileA })
		await psm.saveConfig("B", { ...profileB })
		await activate(proxy, psm, "A")

		// Emulate `setDefaultApiConfiguration("B")`: name-only, no setProviderSettings.
		await proxy.setValue("currentApiConfigName", "B")

		// Default name is now B, but the live (current) profile is still A.
		expect(proxy.getValue("currentApiConfigName")).toBe("B")
		expect(proxy.getSecret("openAiApiKey")).toBe("key-A")
		expect(proxy.getProviderSettings().openAiApiKey).toBe("key-A")
		expect(proxy.getProviderSettings().openAiModelId).toBe("model-A")

		// The distinction survives a reload: the live-profile marker (A) — not the
		// default name (B) — sources the secrets, so no A-settings/B-key mix appears.
		;({ proxy, psm } = await boot(context))
		expect(proxy.getSecret("openAiApiKey")).toBe("key-A")
		expect(proxy.getProviderSettings().openAiApiKey).toBe("key-A")
		expect(proxy.getProviderSettings().openAiModelId).toBe("model-A")
	})

	it("(d) a global/cross-profile secret still round-trips via individual SecretStorage", async () => {
		const { context, secretStore } = createStatefulContext()

		let { proxy } = await boot(context)
		await proxy.storeSecret("codeIndexQdrantApiKey", "qdrant-key")

		// It IS persisted individually (unaffected by Part B).
		expect(secretStore.get("codeIndexQdrantApiKey")).toBe("qdrant-key")
		expect(proxy.getSecret("codeIndexQdrantApiKey")).toBe("qdrant-key")

		// Survives a reload from its individual entry.
		;({ proxy } = await boot(context))
		expect(proxy.getSecret("codeIndexQdrantApiKey")).toBe("qdrant-key")
	})

	it("(e) import round-trips profiles + keys via the blob, not individual SecretStorage", async () => {
		const { context, secretStore } = createStatefulContext()

		let { proxy, psm } = await boot(context)

		// Emulate importSettingsFromPath's core: write the profiles blob, then load the
		// current profile into the live config + marker.
		const imported = await psm.getProfile({ name: "default" })
		await psm.import({
			currentApiConfigName: "C",
			apiConfigs: {
				default: { id: imported.id },
				C: { id: "id-c", apiProvider: "openai", openAiApiKey: "key-C", openAiModelId: "model-C" },
			},
		})
		await proxy.setValue("currentApiConfigName", "C")
		const current = await psm.getProfile({ name: "C" })
		const { name: _n, id: _i, ...currentSettings } = current
		await proxy.setProviderSettings(currentSettings as ProviderSettings, "C")

		// The imported key is in the blob, not in an individual entry.
		expect(secretStore.has("openAiApiKey")).toBe(false)

		// Reload: the key comes back from the blob.
		;({ proxy, psm } = await boot(context))
		expect(proxy.getSecret("openAiApiKey")).toBe("key-C")
		expect(proxy.getProviderSettings().openAiApiKey).toBe("key-C")
		expect((await psm.getProfile({ name: "C" })).openAiApiKey).toBe("key-C")
	})

	it("(f) no individual SecretStorage entry is written for any PROFILE key after a save", async () => {
		const { context, secretStore } = createStatefulContext()

		const { proxy, psm } = await boot(context)
		await psm.saveConfig("A", { ...profileA })
		await activate(proxy, psm, "A")

		for (const key of PROFILE_SECRET_KEYS) {
			expect(secretStore.has(key)).toBe(false)
		}
	})
})
