import * as nodeFs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { packPlugin, packPluginToFile } from "@shofer/core/cli"

import { pluginInstall, pluginList, pluginRemove, type PluginCommandOptions } from "../index.js"

/** Write a minimal valid plugin directory under `root/name-src`. */
async function writePluginDir(root: string, manifest: Record<string, unknown>): Promise<string> {
	const dir = path.join(root, `${manifest.name}-src`)
	await nodeFs.mkdir(path.join(dir, "skills"), { recursive: true })
	await nodeFs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2))
	await nodeFs.writeFile(path.join(dir, "skills", "s.md"), "# skill\n")
	return dir
}

describe("shofer plugin CLI (Phase 5.2)", () => {
	let tmp: string
	let pluginsDir: string
	let stateFile: string
	let lines: string[]
	let ctx: PluginCommandOptions

	beforeEach(async () => {
		tmp = await nodeFs.mkdtemp(path.join(os.tmpdir(), "shofer-plugin-cli-"))
		pluginsDir = path.join(tmp, "plugins")
		stateFile = path.join(tmp, "global-state.json")
		lines = []
		ctx = { pluginsDir, stateFile, log: (l) => lines.push(l) }
	})

	afterEach(async () => {
		await nodeFs.rm(tmp, { recursive: true, force: true })
	})

	async function readEnabled(): Promise<string[]> {
		try {
			const data = JSON.parse(await nodeFs.readFile(stateFile, "utf-8"))
			return data["shofer.plugins.enabledPlugins"] ?? []
		} catch {
			return []
		}
	}

	it("installs from a plugin directory into the global plugins dir", async () => {
		const src = await writePluginDir(tmp, { name: "alpha", version: "1.0.0", description: "A" })
		await pluginInstall(src, ctx)

		expect(await nodeFs.readFile(path.join(pluginsDir, "alpha", "plugin.json"), "utf-8")).toContain("alpha")
		expect(lines.join("\n")).toContain('Installed plugin "alpha" v1.0.0')
		// Not enabled by default (consent gate).
		expect(await readEnabled()).toEqual([])
	})

	it("installs from a .shofer-plugin archive", async () => {
		const src = await writePluginDir(tmp, { name: "beta", version: "2.1.0" })
		const archive = path.join(tmp, "beta.shofer-plugin")
		await packPluginToFile(src, archive)

		await pluginInstall(archive, ctx)
		expect(await nodeFs.readFile(path.join(pluginsDir, "beta", "plugin.json"), "utf-8")).toContain("beta")
	})

	it("installs from an http(s) URL by downloading the archive (mocked fetch)", async () => {
		const src = await writePluginDir(tmp, { name: "zeta", version: "1.0.0" })
		const archivePath = path.join(tmp, "zeta.shofer-plugin")
		await packPluginToFile(src, archivePath)
		const bytes = await nodeFs.readFile(archivePath)
		const fetchImpl = (async () =>
			new Response(new Uint8Array(bytes), {
				status: 200,
				headers: { "content-length": String(bytes.byteLength) },
			})) as unknown as typeof fetch

		await pluginInstall("https://example.com/zeta.shofer-plugin", { ...ctx, fetchImpl })
		expect(await nodeFs.readFile(path.join(pluginsDir, "zeta", "plugin.json"), "utf-8")).toContain("zeta")
		expect(lines.join("\n")).toContain('Installed plugin "zeta" v1.0.0')
	})

	it("errors on a non-2xx URL response", async () => {
		const fetchImpl = (async () =>
			new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch
		await expect(pluginInstall("https://example.com/x.shofer-plugin", { ...ctx, fetchImpl })).rejects.toThrow(
			/HTTP 500/,
		)
	})

	it("rejects an oversize URL download", async () => {
		const src = await writePluginDir(tmp, { name: "big", version: "1.0.0" })
		const bytes = await packPlugin(src)
		const fetchImpl = (async () =>
			new Response(new Uint8Array(bytes), {
				status: 200,
				headers: { "content-length": String(bytes.byteLength) },
			})) as unknown as typeof fetch
		await expect(
			pluginInstall("https://example.com/big.shofer-plugin", { ...ctx, fetchImpl, maxDownloadBytes: 1 }),
		).rejects.toThrow(/too large|download limit/)
	})

	it("refuses to overwrite unless --overwrite is set", async () => {
		const src = await writePluginDir(tmp, { name: "gamma", version: "1.0.0" })
		await pluginInstall(src, ctx)
		await expect(pluginInstall(src, ctx)).rejects.toThrow(/already installed/)

		const v2 = await writePluginDir(path.join(tmp, "v2"), { name: "gamma", version: "3.0.0" })
		await pluginInstall(v2, { ...ctx, overwrite: true })
		expect(JSON.parse(await nodeFs.readFile(path.join(pluginsDir, "gamma", "plugin.json"), "utf-8")).version).toBe(
			"3.0.0",
		)
	})

	it("enables on install with --enable and persists to the allow-list", async () => {
		const src = await writePluginDir(tmp, { name: "delta", version: "1.0.0" })
		await pluginInstall(src, { ...ctx, enable: true })
		expect(await readEnabled()).toEqual(["delta"])
	})

	it("lists installed plugins with enabled state (text and json)", async () => {
		await pluginInstall(await writePluginDir(tmp, { name: "one", version: "1.0.0" }), ctx)
		await pluginInstall(await writePluginDir(tmp, { name: "two", version: "2.0.0" }), { ...ctx, enable: true })

		await pluginList(ctx)
		const text = lines.join("\n")
		expect(text).toContain("one  v1.0.0  [disabled")
		expect(text).toContain("two  v2.0.0  [enabled")

		lines.length = 0
		await pluginList({ ...ctx, json: true })
		const parsed = JSON.parse(lines.join("\n")) as Array<{ name: string; enabled: boolean }>
		expect(parsed.map((p) => p.name).sort()).toEqual(["one", "two"])
		expect(parsed.find((p) => p.name === "two")?.enabled).toBe(true)
		expect(parsed.find((p) => p.name === "one")?.enabled).toBe(false)
	})

	it("reports an empty list when no plugins are installed", async () => {
		await pluginList(ctx)
		expect(lines.join("\n")).toContain("No plugins installed")
	})

	it("removes a plugin: deletes its dir and drops it from the allow-list", async () => {
		const src = await writePluginDir(tmp, { name: "epsilon", version: "1.0.0" })
		await pluginInstall(src, { ...ctx, enable: true })
		expect(await readEnabled()).toEqual(["epsilon"])

		await pluginRemove("epsilon", ctx)
		expect(lines.join("\n")).toContain('Removed plugin "epsilon"')
		await expect(nodeFs.access(path.join(pluginsDir, "epsilon"))).rejects.toThrow()
		expect(await readEnabled()).toEqual([])
	})

	it("errors when removing an unknown plugin", async () => {
		await expect(pluginRemove("nope", ctx)).rejects.toThrow(/No plugin named "nope"/)
	})
})
