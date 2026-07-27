import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

import { createInMemoryHost, type HostBridge } from "@shofer/types"

import { PluginManager, createNodePluginFs, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import { createNodePluginCodeLoader } from "../plugin-loader.js"

/**
 * Integration test for the first-party **RAG Indexing plugin**
 * (`<repo>/plugins/rag-indexing`) — the codebase and git-history indexes that used to be
 * `src/services/code-index` + `src/services/git-index`.
 *
 * It loads the *real* plugin off disk through the *real* {@link PluginManager} and asks it
 * what core asks: are the search tools contributed, does `ctx.host.search` reach it, and
 * what does a Shofer Node get told. Nothing here needs an embedder or a vector store —
 * with no credentials the index is unconfigured, which is exactly the state the assertions
 * are about (a tool that cannot answer is not offered).
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../plugins/rag-indexing")
const PLUGINS_PARENT = path.dirname(PLUGIN_DIR)

class MemoryStore implements PluginStateStore {
	constructor(
		public names: string[] = [],
		public disabled: string[] = [],
	) {}
	getEnabledPlugins(): string[] {
		return [...this.names]
	}
	setEnabledPlugins(names: string[]): void {
		this.names = [...names]
	}
	getDisabledPlugins(): string[] {
		return [...this.disabled]
	}
	setDisabledPlugins(names: string[]): void {
		this.disabled = [...names]
	}
}

const tmpRoots: string[] = []

function makeWorkspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-indexing-ws-"))
	tmpRoots.push(dir)
	fs.writeFileSync(path.join(dir, "file.ts"), "export const answer = 42\n")
	return dir
}

describe("RAG Indexing plugin (first-party, loaded off disk)", () => {
	let host: HostBridge

	beforeEach(() => {
		host = createInMemoryHost()
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	afterEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	afterAll(() => {
		for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
	})

	async function build(opts: { workspacePath: string; store?: PluginStateStore }) {
		const storageBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-indexing-storage-"))
		tmpRoots.push(storageBaseDir)

		const manager = new PluginManager({
			fs: createNodePluginFs(),
			pluginDirs: [{ dir: PLUGINS_PARENT, scope: "bundled" }],
			// Enabled explicitly: unlike every other bundled plugin this one is opt-in,
			// because it needs an embedder, a credential and a running vector store.
			stateStore: opts.store ?? new MemoryStore(["rag-indexing"]),
			codeLoader: createNodePluginCodeLoader({ nodePaths: [path.join(process.cwd(), "node_modules")] }),
			host,
			workspacePath: opts.workspacePath,
			storageBaseDir,
		})

		await manager.discover()
		await manager.activateCodePlugins()
		return { manager }
	}

	it("is off until the user enables it (it needs infrastructure, unlike the other bundled plugins)", async () => {
		const { manager } = await build({ workspacePath: makeWorkspace(), store: new MemoryStore([]) })
		expect(manager.isEnabled("rag-indexing")).toBe(false)
		expect(pluginRegistry.has("rag-indexing")).toBe(false)
	}, 60_000)

	it("loads once enabled", async () => {
		const { manager } = await build({ workspacePath: makeWorkspace() })
		expect(manager.isEnabled("rag-indexing")).toBe(true)
		expect(pluginRegistry.has("rag-indexing")).toBe(true)
	}, 60_000)

	it("declares its credentials as secrets, so they never reach plain state", async () => {
		const { manager } = await build({ workspacePath: makeWorkspace() })
		const plugin = manager.listPlugins().find((p) => p.name === "rag-indexing")
		const properties = (plugin?.manifest.config as { properties?: Record<string, { secret?: boolean }> })
			?.properties
		for (const key of [
			"qdrantApiKey",
			"openAiApiKey",
			"openAiCompatibleApiKey",
			"geminiApiKey",
			"mistralApiKey",
			"vercelAiGatewayApiKey",
			"openRouterApiKey",
		]) {
			expect(properties?.[key]?.secret, `${key} must be declared secret`).toBe(true)
		}
	}, 60_000)

	it("contributes no search tool while the index cannot answer", async () => {
		const cwd = makeWorkspace()
		await build({ workspacePath: cwd })

		// Nothing is configured (no embedder, no store), so offering `rag_search` would
		// put a tool in every system prompt that can only fail.
		const tools = await pluginRegistry.collectTools({ workspacePath: cwd, cwd })
		expect(tools.map((t) => t.name)).not.toContain("rag_search")
		expect(tools.map((t) => t.name)).not.toContain("git_search")
	}, 60_000)

	it("answers the host's search question with nothing rather than throwing", async () => {
		const cwd = makeWorkspace()
		await build({ workspacePath: cwd })

		// This is the path `ctx.host.search.ragSearch` takes: Live Memory must keep working
		// whether or not the indexer is configured.
		await expect(
			pluginRegistry.request("rag-indexing", "search", { query: "anything" }, { workspacePath: cwd, cwd }),
		).resolves.toEqual([])
		await expect(
			pluginRegistry.request("rag-indexing", "git-search", { query: "anything" }, { workspacePath: cwd, cwd }),
		).resolves.toEqual([])
	}, 60_000)

	it("pins a Shofer Node to search-only against the controller's index", async () => {
		const cwd = makeWorkspace()
		await build({ workspacePath: cwd })

		// The Sole-Indexer rule, now the plugin's to enforce: the controller asks what a
		// node should receive and the plugin adds the constraint.
		const slice = (await pluginRegistry.request(
			"rag-indexing",
			"node-config",
			{ config: { enabled: true, qdrantUrl: "http://qdrant:6333" }, secrets: { qdrantApiKey: "k" } },
			{ workspacePath: cwd, cwd },
		)) as { config: Record<string, unknown>; secrets: Record<string, string> }

		expect(slice.config).toMatchObject({ enabled: true, qdrantUrl: "http://qdrant:6333", searchOnly: true })
		expect(slice.secrets).toEqual({ qdrantApiKey: "k" })
	}, 60_000)

	it("refuses to embed for another plugin when nothing is configured", async () => {
		const cwd = makeWorkspace()
		await build({ workspacePath: cwd })

		// `ctx.ai.embed` forwards here; an empty array would let the caller store garbage.
		await expect(
			pluginRegistry.request("rag-indexing", "embed", { texts: ["hello"] }, { workspacePath: cwd, cwd }),
		).rejects.toThrow(/not configured/)
	}, 60_000)
})
