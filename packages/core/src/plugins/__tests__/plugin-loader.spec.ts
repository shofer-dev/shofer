import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"

import { PluginRegistry } from "../plugin-registry.js"
import { loadPluginFromEntry, createNodePluginCodeLoader } from "../plugin-loader.js"

/**
 * These specs drive the REAL loader: an esbuild transpile plus a dynamic ESM import
 * of a just-written fixture. That work does not fit the registry's 500ms default
 * hook budget (`PLUGIN_HOOK_TIMEOUT_MS`) on a loaded machine — and `collectTools`
 * turns an exceeded budget into an EMPTY tool list rather than an error, so the
 * symptom is a baffling `Cannot read properties of undefined (reading 'execute')`
 * instead of a timeout. These tests are about the loader, not the budget, so they
 * grant one large enough that it cannot be what fails.
 */
const LOADER_HOOK_BUDGET_MS = 30_000

/**
 * Loader tests exercise the *real* esbuild transpile + dynamic-import path (same
 * as the custom-tools loader), so they write TypeScript/JS fixtures to a temp dir
 * and load them. A unique cacheDir per suite avoids cross-run bundle reuse.
 */
describe("plugin-loader (§7 code loading, step 2.1)", () => {
	let dir: string
	let cacheDir: string

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "shofer-plugin-loader-"))
		cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "shofer-plugin-loader-cache-"))
	})
	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true })
		fs.rmSync(cacheDir, { recursive: true, force: true })
	})

	/** Write a plugin root with a `main` entry file, returning the root. */
	function writePlugin(name: string, entryFile: string, source: string): string {
		const root = path.join(dir, name)
		fs.mkdirSync(root, { recursive: true })
		fs.writeFileSync(path.join(root, entryFile), source)
		return root
	}

	it("transpiles a .ts entry and its hooks fire through pluginRegistry", async () => {
		const root = writePlugin(
			"ts-plugin",
			"index.ts",
			`
			interface Ctx { mode?: string }
			const plugin = {
				name: "ts-plugin",
				registerTools(_ctx: Ctx) {
					return [{ name: "hello", description: "hi", execute: async () => "world" }]
				},
				transformSystemPrompt(prompt: string, _ctx: Ctx): string {
					return prompt + " [ts-plugin]"
				},
				onEvent(event: { name: string }) {
					seen.push(event.name)
				},
			}
			const seen: string[] = []
			;(globalThis as any).__tsPluginSeen = seen
			export default plugin
			`,
		)

		const plugin = await loadPluginFromEntry({ name: "ts-plugin", root, main: "index.ts" }, { cacheDir })
		expect(plugin.name).toBe("ts-plugin")

		const reg = new PluginRegistry()
		await reg.register(plugin, {}, { hookTimeoutMs: LOADER_HOOK_BUDGET_MS })

		const tools = await reg.collectTools()
		expect(tools.map((t) => t.name)).toEqual(["hello"])

		const prompt = await reg.applySystemPromptTransforms("base")
		expect(prompt).toBe("base [ts-plugin]")

		reg.dispatchEvent({ name: "task.created" })
		expect((globalThis as unknown as { __tsPluginSeen: string[] }).__tsPluginSeen).toEqual(["task.created"])
	})

	it("externalizes an installed runtime dependency instead of bundling it", async () => {
		// A plugin that declares + installs a dep whose code is deliberately UNBUNDLABLE (it
		// requires a native `.node` file — esbuild has no loader for those). If the loader tried
		// to bundle the dep, the transpile would fail and loadPluginFromEntry would throw. With the
		// dep externalized, esbuild never descends into it, and the plugin `import()`s it at runtime.
		const root = writePlugin(
			"ext-plugin",
			"index.ts",
			`
			const plugin = {
				name: "ext-plugin",
				async registerTools() {
					const m = await import("native-dep")
					return [{ name: "probe", description: "", execute: async () => m.value }]
				},
			}
			export default plugin
			`,
		)
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "native-dep": "1.0.0" } }))
		const depDir = path.join(root, "node_modules", "native-dep")
		fs.mkdirSync(depDir, { recursive: true })
		fs.writeFileSync(path.join(depDir, "package.json"), JSON.stringify({ name: "native-dep", main: "index.js" }))
		// `value` is bundle-safe; `native()` (never called here) forces a `.node` require that only
		// esbuild-bundling would choke on — proving the dep was left external.
		fs.writeFileSync(
			path.join(depDir, "index.js"),
			`exports.value = "EXTERNAL"; exports.native = () => require("./addon.node")`,
		)
		fs.writeFileSync(path.join(depDir, "addon.node"), "not a real addon")

		const plugin = await loadPluginFromEntry({ name: "ext-plugin", root, main: "index.ts" }, { cacheDir })
		const reg = new PluginRegistry()
		await reg.register(plugin, {}, { hookTimeoutMs: LOADER_HOOK_BUDGET_MS })
		const tools = await reg.collectTools()
		expect(tools.map((t) => t.name)).toEqual(["probe"])
		expect(await tools[0]!.execute!({}, {} as never)).toBe("EXTERNAL")
	})

	it("uses baked deps as-is when the arch marker matches (no reinstall)", async () => {
		// Deps present + a marker for THIS platform-arch → ensurePluginDeps must be a no-op (it must
		// not shell out to npm). We assert by making the dep unbundlable and its resolution work via
		// the existing baked node_modules; if it tried to reinstall, there's no registry in the test.
		const root = writePlugin(
			"baked-plugin",
			"index.ts",
			`
			const plugin = {
				name: "baked-plugin",
				async registerTools() {
					const m = await import("baked-dep")
					return [{ name: "probe", description: "", execute: async () => m.value }]
				},
			}
			export default plugin
			`,
		)
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "baked-dep": "1.0.0" } }))
		fs.writeFileSync(path.join(root, ".shofer-baked-arch"), `${process.platform}-${process.arch}`)
		const depDir = path.join(root, "node_modules", "baked-dep")
		fs.mkdirSync(depDir, { recursive: true })
		fs.writeFileSync(path.join(depDir, "package.json"), JSON.stringify({ name: "baked-dep", main: "index.js" }))
		fs.writeFileSync(
			path.join(depDir, "index.js"),
			`exports.value = "BAKED"; exports.n = () => require("./x.node")`,
		)
		fs.writeFileSync(path.join(depDir, "x.node"), "stub")

		const plugin = await loadPluginFromEntry({ name: "baked-plugin", root, main: "index.ts" }, { cacheDir })
		const reg = new PluginRegistry()
		await reg.register(plugin, {}, { hookTimeoutMs: LOADER_HOOK_BUDGET_MS })
		const tools = await reg.collectTools()
		expect(await tools[0]!.execute!({}, {} as never)).toBe("BAKED")
	})

	it("loads a plain .js entry directly (no transpile)", async () => {
		const root = writePlugin(
			"js-plugin",
			"index.mjs",
			`export default { name: "js-plugin", transformSystemPrompt: (p) => p + "!" }`,
		)
		const plugin = await loadPluginFromEntry({ name: "js-plugin", root, main: "index.mjs" }, { cacheDir })
		expect(plugin.transformSystemPrompt?.("x", {})).toBe("x!")
	})

	it("uses the createNodePluginCodeLoader seam", async () => {
		const root = writePlugin("seam-plugin", "e.mjs", `export default { name: "seam-plugin" }`)
		const loader = createNodePluginCodeLoader({ cacheDir })
		const plugin = await loader.load({ name: "seam-plugin", root, main: "e.mjs" })
		expect(plugin.name).toBe("seam-plugin")
	})

	it("rejects an API-version mismatch before running code (owner decision)", async () => {
		const root = writePlugin("v-plugin", "e.mjs", `export default { name: "v-plugin" }`)
		await expect(
			loadPluginFromEntry(
				{ name: "v-plugin", root, main: "e.mjs", apiVersion: "2.0.0" },
				{ cacheDir, hostApiVersion: "1.0.0" },
			),
		).rejects.toThrow(/incompatible/)
	})

	it("accepts a compatible declared API version", async () => {
		const root = writePlugin("v-ok", "e.mjs", `export default { name: "v-ok" }`)
		const plugin = await loadPluginFromEntry(
			{ name: "v-ok", root, main: "e.mjs", apiVersion: "1.0.0" },
			{ cacheDir, hostApiVersion: "1.2.0" },
		)
		expect(plugin.name).toBe("v-ok")
	})

	it("rejects a manifest/module name mismatch", async () => {
		const root = writePlugin("named-a", "e.mjs", `export default { name: "actually-b" }`)
		await expect(loadPluginFromEntry({ name: "named-a", root, main: "e.mjs" }, { cacheDir })).rejects.toThrow(
			/name mismatch/,
		)
	})

	it("rejects a module that is not a ShoferPlugin", async () => {
		const root = writePlugin("no-plugin", "e.mjs", `export const notAPlugin = 42`)
		await expect(loadPluginFromEntry({ name: "no-plugin", root, main: "e.mjs" }, { cacheDir })).rejects.toThrow(
			/does not export a ShoferPlugin/,
		)
	})

	it("rejects an entry that escapes the plugin directory", async () => {
		const root = writePlugin("escape", "e.mjs", `export default { name: "escape" }`)
		await expect(loadPluginFromEntry({ name: "escape", root, main: "../evil.mjs" }, { cacheDir })).rejects.toThrow(
			/escapes the plugin directory/,
		)
	})
})
