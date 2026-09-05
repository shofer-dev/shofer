/**
 * Unit tests for `shofer plugin pack` (`pluginPack` in
 * `src/commands/plugin/index.ts`).
 *
 * Everything happens against real temp directories — packing is a filesystem
 * operation with no network and no credentials — and the cwd is moved into a
 * temp directory for the default-output-name case, because `pluginPack`
 * resolves the derived archive name against the cwd.
 */

import * as nodeFs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { pluginPack } from "../index.js"

/** Write a minimal valid plugin directory under `root/<name>-src`. */
async function writePluginDir(root: string, manifest: Record<string, unknown>): Promise<string> {
	const dir = path.join(root, `${manifest.name ?? "anon"}-src`)
	await nodeFs.mkdir(path.join(dir, "skills"), { recursive: true })
	await nodeFs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2))
	await nodeFs.writeFile(path.join(dir, "skills", "s.md"), "# skill\n")
	return dir
}

describe("pluginPack", () => {
	let tmp: string
	let lines: string[]

	beforeEach(async () => {
		tmp = await nodeFs.mkdtemp(path.join(os.tmpdir(), "shofer-plugin-pack-"))
		lines = []
	})

	afterEach(async () => {
		await nodeFs.rm(tmp, { recursive: true, force: true })
	})

	it("packs into an explicit output file and reports name and version", async () => {
		const src = await writePluginDir(tmp, { name: "alpha", version: "1.2.3", description: "A" })
		const out = path.join(tmp, "alpha.shofer-plugin")

		await pluginPack(src, out, { log: (line) => lines.push(line) })

		await expect(nodeFs.stat(out)).resolves.toBeTruthy()
		expect(lines[0]).toBe(`Packed "alpha" v1.2.3 → ${out}`)
	})

	it("derives the archive name from the manifest when no output is given", async () => {
		const src = await writePluginDir(tmp, { name: "beta", version: "0.9.0" })
		const previousCwd = process.cwd()
		process.chdir(tmp)

		try {
			await pluginPack(src, undefined, { log: (line) => lines.push(line) })
			await expect(nodeFs.stat(path.join(tmp, "beta-0.9.0.shofer-plugin"))).resolves.toBeTruthy()
		} finally {
			process.chdir(previousCwd)
		}
	})

	it("logs through console.log when no sink is supplied", async () => {
		const src = await writePluginDir(tmp, { name: "gamma", version: "2.0.0" })
		const out = path.join(tmp, "gamma.shofer-plugin")
		const logged: string[] = []
		const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "))
		})

		try {
			await pluginPack(src, out)
			expect(logged.join("\n")).toContain('Packed "gamma" v2.0.0')
		} finally {
			spy.mockRestore()
		}
	})

	it("fails on a directory with no manifest", async () => {
		const empty = path.join(tmp, "empty")
		await nodeFs.mkdir(empty, { recursive: true })

		await expect(pluginPack(empty, path.join(tmp, "out.shofer-plugin"), { log: () => {} })).rejects.toThrow()
	})
})
