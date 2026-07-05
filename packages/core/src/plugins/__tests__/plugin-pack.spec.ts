import * as nodeFs from "fs/promises"
import * as os from "os"
import * as path from "path"

import * as tar from "tar"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	PluginPackError,
	installPlugin,
	installPluginFromDirectory,
	installPluginFromUrl,
	isPluginUrl,
	packPlugin,
	packPluginToFile,
	unpackPlugin,
} from "../plugin-pack.js"

/** A minimal valid plugin directory under `root`. */
async function writePlugin(
	root: string,
	manifest: Record<string, unknown>,
	extraFiles: Record<string, string> = {},
): Promise<string> {
	const dir = path.join(root, "src-plugin")
	await nodeFs.mkdir(path.join(dir, "skills"), { recursive: true })
	await nodeFs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2))
	await nodeFs.writeFile(path.join(dir, "index.js"), "export default { name: 'x' }\n")
	await nodeFs.writeFile(path.join(dir, "skills", "hello.md"), "# hello skill\n")
	for (const [rel, content] of Object.entries(extraFiles)) {
		const p = path.join(dir, rel)
		await nodeFs.mkdir(path.dirname(p), { recursive: true })
		await nodeFs.writeFile(p, content)
	}
	return dir
}

describe("plugin-pack (Phase 5.1)", () => {
	let tmp: string

	beforeEach(async () => {
		tmp = await nodeFs.mkdtemp(path.join(os.tmpdir(), "shofer-plugin-pack-"))
	})

	afterEach(async () => {
		await nodeFs.rm(tmp, { recursive: true, force: true })
	})

	const validManifest = { name: "demo-plugin", version: "1.2.3", description: "Demo" }

	it("packs a plugin dir into a gzip tarball and unpacks it round-trip", async () => {
		const src = await writePlugin(tmp, validManifest, { "commands/run.md": "run me\n" })
		const archive = await packPlugin(src)

		// gzip magic bytes.
		expect(archive[0]).toBe(0x1f)
		expect(archive[1]).toBe(0x8b)

		const destPlugins = path.join(tmp, "plugins")
		const installed = await unpackPlugin(archive, destPlugins)

		expect(installed.name).toBe("demo-plugin")
		expect(installed.version).toBe("1.2.3")
		expect(installed.dir).toBe(path.join(destPlugins, "demo-plugin"))

		// Every file survived the round-trip at its original relative path.
		expect(JSON.parse(await nodeFs.readFile(path.join(installed.dir, "plugin.json"), "utf-8")).name).toBe(
			"demo-plugin",
		)
		expect(await nodeFs.readFile(path.join(installed.dir, "index.js"), "utf-8")).toContain("export default")
		expect(await nodeFs.readFile(path.join(installed.dir, "skills", "hello.md"), "utf-8")).toContain("hello skill")
		expect(await nodeFs.readFile(path.join(installed.dir, "commands", "run.md"), "utf-8")).toContain("run me")
	})

	it("packs to a file and unpacks from that path", async () => {
		const src = await writePlugin(tmp, validManifest)
		const out = path.join(tmp, "demo-plugin-1.2.3.shofer-plugin")
		const meta = await packPluginToFile(src, out)
		expect(meta).toEqual({ name: "demo-plugin", version: "1.2.3", path: out })

		const installed = await unpackPlugin(out, path.join(tmp, "plugins"))
		expect(installed.name).toBe("demo-plugin")
	})

	it("rejects an archive whose entry escapes via a path-traversal (zip-slip)", async () => {
		// Craft a malicious tarball with a `../escape.txt` entry using tar's preservePaths.
		const evilDir = path.join(tmp, "evil")
		await nodeFs.mkdir(evilDir, { recursive: true })
		await nodeFs.writeFile(path.join(evilDir, "plugin.json"), JSON.stringify(validManifest))
		const outsideMarker = path.join(tmp, "escape.txt")
		await nodeFs.writeFile(outsideMarker, "pwned")

		const malicious = path.join(tmp, "evil.shofer-plugin")
		await tar.create({ gzip: true, file: malicious, cwd: evilDir, preservePaths: true }, [
			"plugin.json",
			"../escape.txt",
		])

		await expect(unpackPlugin(malicious, path.join(tmp, "plugins"))).rejects.toBeInstanceOf(PluginPackError)
	})

	it("rejects an archive with an absolute-path entry", async () => {
		// Build a tarball that contains a rooted `/etc/evil` entry alongside a valid
		// manifest, using a synthetic absolute source path + preservePaths.
		const evilDir = path.join(tmp, "abs")
		await nodeFs.mkdir(evilDir, { recursive: true })
		await nodeFs.writeFile(path.join(evilDir, "plugin.json"), JSON.stringify(validManifest))
		const absTarget = path.join(tmp, "absentry")
		await nodeFs.writeFile(absTarget, "x")

		const malicious = path.join(tmp, "abs.shofer-plugin")
		await tar.create({ gzip: true, file: malicious, preservePaths: true, cwd: evilDir }, [
			"plugin.json",
			absTarget, // absolute path → stored as a rooted entry under preservePaths
		])

		await expect(unpackPlugin(malicious, path.join(tmp, "plugins"))).rejects.toBeInstanceOf(PluginPackError)
	})

	it("rejects an archive with no plugin.json", async () => {
		const noManifest = path.join(tmp, "nom")
		await nodeFs.mkdir(noManifest, { recursive: true })
		await nodeFs.writeFile(path.join(noManifest, "index.js"), "// nothing\n")
		const archive = path.join(tmp, "nom.shofer-plugin")
		await tar.create({ gzip: true, file: archive, cwd: noManifest }, ["index.js"])

		await expect(unpackPlugin(archive, path.join(tmp, "plugins"))).rejects.toThrow(/plugin\.json/)
	})

	it("rejects an archive with an invalid manifest", async () => {
		// Missing required `version` → schema failure.
		const src = await writePlugin(tmp, { name: "demo-plugin" })
		// packPlugin validates the manifest itself, so packing an invalid one throws.
		await expect(packPlugin(src)).rejects.toBeInstanceOf(PluginPackError)

		// And unpacking a hand-built archive with a bad manifest is rejected too.
		const badDir = path.join(tmp, "bad")
		await nodeFs.mkdir(badDir, { recursive: true })
		await nodeFs.writeFile(path.join(badDir, "plugin.json"), JSON.stringify({ name: "no-version" }))
		const badArchive = path.join(tmp, "bad.shofer-plugin")
		await tar.create({ gzip: true, file: badArchive, cwd: badDir }, ["plugin.json"])
		await expect(unpackPlugin(badArchive, path.join(tmp, "plugins"))).rejects.toBeInstanceOf(PluginPackError)
	})

	it("refuses to overwrite an existing plugin unless overwrite is set", async () => {
		const src = await writePlugin(tmp, validManifest)
		const archive = await packPlugin(src)
		const destPlugins = path.join(tmp, "plugins")

		await unpackPlugin(archive, destPlugins)
		await expect(unpackPlugin(archive, destPlugins)).rejects.toBeInstanceOf(PluginPackError)

		// With overwrite the second install replaces the first.
		const v2 = await writePlugin(path.join(tmp, "v2"), { ...validManifest, version: "2.0.0" })
		const archive2 = await packPlugin(v2)
		const upgraded = await unpackPlugin(archive2, destPlugins, { overwrite: true })
		expect(upgraded.version).toBe("2.0.0")
		expect(JSON.parse(await nodeFs.readFile(path.join(upgraded.dir, "plugin.json"), "utf-8")).version).toBe("2.0.0")
	})

	it("installs from a plugin directory (copy) with the same collision policy", async () => {
		const src = await writePlugin(tmp, validManifest)
		const destPlugins = path.join(tmp, "plugins")

		const installed = await installPluginFromDirectory(src, destPlugins)
		expect(installed.dir).toBe(path.join(destPlugins, "demo-plugin"))
		expect(await nodeFs.readFile(path.join(installed.dir, "skills", "hello.md"), "utf-8")).toContain("hello skill")

		await expect(installPluginFromDirectory(src, destPlugins)).rejects.toBeInstanceOf(PluginPackError)
	})

	it("installPlugin dispatches on directory vs archive source", async () => {
		const src = await writePlugin(tmp, validManifest)
		const destA = path.join(tmp, "a")
		const fromDir = await installPlugin(src, destA)
		expect(fromDir.name).toBe("demo-plugin")

		const out = path.join(tmp, "demo.shofer-plugin")
		await packPluginToFile(src, out)
		const destB = path.join(tmp, "b")
		const fromArchive = await installPlugin(out, destB)
		expect(fromArchive.name).toBe("demo-plugin")

		await expect(installPlugin(path.join(tmp, "missing"), destA)).rejects.toBeInstanceOf(PluginPackError)
	})

	describe("installPluginFromUrl (direct-URL install)", () => {
		/** A `fetch` stub that returns `bytes` as a 200 archive response. */
		function okFetch(bytes: Buffer): typeof fetch {
			return (async () =>
				new Response(bytes, {
					status: 200,
					headers: { "content-length": String(bytes.byteLength) },
				})) as unknown as typeof fetch
		}

		it("isPluginUrl distinguishes http(s) URLs from local paths", () => {
			expect(isPluginUrl("https://example.com/p.shofer-plugin")).toBe(true)
			expect(isPluginUrl("http://localhost:8080/p.shofer-plugin")).toBe(true)
			expect(isPluginUrl("./p.shofer-plugin")).toBe(false)
			expect(isPluginUrl("/abs/p.shofer-plugin")).toBe(false)
			expect(isPluginUrl("C:\\plugins\\p.shofer-plugin")).toBe(false)
		})

		it("downloads an https archive and installs it (happy path)", async () => {
			const src = await writePlugin(tmp, validManifest)
			const archive = await packPlugin(src)
			const destPlugins = path.join(tmp, "plugins")

			const installed = await installPluginFromUrl("https://example.com/demo.shofer-plugin", destPlugins, {
				fetchImpl: okFetch(archive),
			})

			expect(installed.name).toBe("demo-plugin")
			expect(installed.version).toBe("1.2.3")
			expect(JSON.parse(await nodeFs.readFile(path.join(installed.dir, "plugin.json"), "utf-8")).name).toBe(
				"demo-plugin",
			)
		})

		it("honors overwrite on a URL install", async () => {
			const destPlugins = path.join(tmp, "plugins")
			const v1 = await packPlugin(await writePlugin(tmp, validManifest))
			await installPluginFromUrl("https://example.com/demo.shofer-plugin", destPlugins, { fetchImpl: okFetch(v1) })

			const v2 = await packPlugin(await writePlugin(path.join(tmp, "v2"), { ...validManifest, version: "2.0.0" }))
			await expect(
				installPluginFromUrl("https://example.com/demo.shofer-plugin", destPlugins, { fetchImpl: okFetch(v2) }),
			).rejects.toBeInstanceOf(PluginPackError)

			const upgraded = await installPluginFromUrl("https://example.com/demo.shofer-plugin", destPlugins, {
				fetchImpl: okFetch(v2),
				overwrite: true,
			})
			expect(upgraded.version).toBe("2.0.0")
		})

		it("rejects a non-2xx response with a clear error", async () => {
			const fetchImpl = (async () =>
				new Response("not found", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch
			await expect(
				installPluginFromUrl("https://example.com/missing.shofer-plugin", path.join(tmp, "plugins"), {
					fetchImpl,
				}),
			).rejects.toThrow(/HTTP 404/)
		})

		it("surfaces a network failure as a PluginPackError", async () => {
			const fetchImpl = (async () => {
				throw new Error("ECONNREFUSED")
			}) as unknown as typeof fetch
			await expect(
				installPluginFromUrl("https://example.com/p.shofer-plugin", path.join(tmp, "plugins"), { fetchImpl }),
			).rejects.toThrow(/Failed to download plugin.*ECONNREFUSED/)
		})

		it("rejects an oversize archive (declared Content-Length over the cap)", async () => {
			const src = await writePlugin(tmp, validManifest)
			const archive = await packPlugin(src)
			await expect(
				installPluginFromUrl("https://example.com/demo.shofer-plugin", path.join(tmp, "plugins"), {
					fetchImpl: okFetch(archive),
					maxBytes: 1,
				}),
			).rejects.toThrow(/too large|download limit/)
		})

		it("rejects an oversize streamed body when Content-Length is absent", async () => {
			const src = await writePlugin(tmp, validManifest)
			const archive = await packPlugin(src)
			// No content-length header → the cap must be enforced while streaming the body.
			const fetchImpl = (async () => new Response(archive, { status: 200 })) as unknown as typeof fetch
			await expect(
				installPluginFromUrl("https://example.com/demo.shofer-plugin", path.join(tmp, "plugins"), {
					fetchImpl,
					maxBytes: 1,
				}),
			).rejects.toThrow(/download limit/)
		})

		it("refuses a plain http:// URL from a non-loopback host by default", async () => {
			const src = await writePlugin(tmp, validManifest)
			const archive = await packPlugin(src)
			await expect(
				installPluginFromUrl("http://example.com/demo.shofer-plugin", path.join(tmp, "plugins"), {
					fetchImpl: okFetch(archive),
				}),
			).rejects.toThrow(/insecure http/)
		})

		it("allows http:// for localhost, and for any host with allowInsecureHttp", async () => {
			const src = await writePlugin(tmp, validManifest)
			const archive = await packPlugin(src)

			const local = await installPluginFromUrl(
				"http://localhost:8080/demo.shofer-plugin",
				path.join(tmp, "plugins-local"),
				{ fetchImpl: okFetch(archive) },
			)
			expect(local.name).toBe("demo-plugin")

			const opted = await installPluginFromUrl(
				"http://example.com/demo.shofer-plugin",
				path.join(tmp, "plugins-opt"),
				{ fetchImpl: okFetch(archive), allowInsecureHttp: true },
			)
			expect(opted.name).toBe("demo-plugin")
		})
	})
})
