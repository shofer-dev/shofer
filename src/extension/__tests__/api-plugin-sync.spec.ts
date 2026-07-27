import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ShoferProvider } from "../../core/webview/ShoferProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ShoferProvider")

/**
 * The node side of plugin config sync (`AgentApi.applyConfig` → `applySyncedPluginState`).
 *
 * The invariant under test is **merge, never replace**. A node can hold its own config
 * for plugins the controller does not sync at all — and a push that replaced the whole
 * map would erase it silently, which is the same failure `applySyncedSecrets` avoids by
 * iterating its allow-list instead of the payload.
 */
describe("ShoferAPI.applySyncedPluginState", () => {
	let api: API
	let provider: ShoferProvider
	let state: Record<string, unknown>
	let secrets: Record<string, Record<string, string>>
	let reloaded: string[]

	beforeEach(() => {
		state = {
			pluginConfigs: {
				"rag-indexing": { embedderProvider: "ollama", qdrantUrl: "http://node-local:6333" },
				"node-only-plugin": { keep: true },
			},
		}
		secrets = { "rag-indexing": { embedderApiKey: "node-local-key" }, "node-only-plugin": { token: "keep-me" } }
		reloaded = []

		provider = {
			context: {} as vscode.ExtensionContext,
			on: vi.fn(),
			cwd: "/workspace",
			contextProxy: {
				getValue: (key: string) => state[key],
				setValue: async (key: string, value: unknown) => {
					state[key] = value
				},
			},
			readPluginSecretsForSync: () => secrets,
			writePluginSecretsForSync: async (all: Record<string, Record<string, string>>) => {
				secrets = all
			},
			reloadPlugins: async (names: string[]) => {
				reloaded = names
			},
			postInitState: vi.fn().mockResolvedValue(undefined),
		} as unknown as ShoferProvider

		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, provider)
	})

	it("merges the controller's slice into the plugin's config instead of replacing it", async () => {
		await api.applySyncedPluginState({
			"rag-indexing": { config: { embedderProvider: "openai", searchOnly: true } },
		})

		expect((state.pluginConfigs as Record<string, unknown>)["rag-indexing"]).toEqual({
			// Controller-sent values win…
			embedderProvider: "openai",
			searchOnly: true,
			// …and a node-local value the controller said nothing about survives.
			qdrantUrl: "http://node-local:6333",
		})
	})

	it("leaves plugins the controller does not sync completely alone", async () => {
		await api.applySyncedPluginState({ "rag-indexing": { config: { searchOnly: true } } })

		expect((state.pluginConfigs as Record<string, unknown>)["node-only-plugin"]).toEqual({ keep: true })
		expect(secrets["node-only-plugin"]).toEqual({ token: "keep-me" })
	})

	it("merges credentials the same way", async () => {
		await api.applySyncedPluginState({
			"rag-indexing": { secrets: { embedderApiKey: "sk-from-controller", qdrantApiKey: "qk" } },
		})

		expect(secrets["rag-indexing"]).toEqual({ embedderApiKey: "sk-from-controller", qdrantApiKey: "qk" })
	})

	it("reloads exactly the plugins the push touched, so ctx.config is live without a restart", async () => {
		await api.applySyncedPluginState({ "rag-indexing": { config: { searchOnly: true } } })

		expect(reloaded).toEqual(["rag-indexing"])
	})
})
