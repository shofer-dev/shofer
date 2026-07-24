import * as nodeFs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { LockedManifest } from "../../config/layered-config.js"
import { packPluginToFile } from "../plugin-pack.js"
import {
	EMPTY_PLUGIN_DECLARATION,
	mergePluginDeclarations,
	parsePluginDeclaration,
	type PluginDeclaration,
	PLUGIN_DECLARATION_VERSION,
	PluginResolveError,
	resolvePluginDeclaration,
} from "../plugin-declaration.js"

/** A LockedManifest locking the given `plugins/<name>` paths. */
function locked(...paths: string[]): LockedManifest {
	return { version: 1, locked: paths }
}

/** A one-plugin declaration. */
function decl(name: string, entry: PluginDeclaration["plugins"][string]): PluginDeclaration {
	return { version: PLUGIN_DECLARATION_VERSION, plugins: { [name]: entry } }
}

/** Write a minimal valid plugin directory at `dir` with the given manifest. */
async function writePluginDir(dir: string, manifest: Record<string, unknown>): Promise<string> {
	await nodeFs.mkdir(path.join(dir, "skills"), { recursive: true })
	await nodeFs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2))
	await nodeFs.writeFile(path.join(dir, "index.js"), "export default { name: 'x' }\n")
	await nodeFs.writeFile(path.join(dir, "skills", "hello.md"), "# hello skill\n")
	return dir
}

describe("parsePluginDeclaration", () => {
	it("parses a valid declaration", () => {
		const raw = JSON.stringify({
			version: 1,
			plugins: {
				foo: { source: "./foo", version: "1.0.0", enabled: true, config: { a: 1 } },
			},
		})
		const parsed = parsePluginDeclaration(raw)
		expect(parsed.version).toBe(1)
		expect(parsed.plugins.foo).toEqual({ source: "./foo", version: "1.0.0", enabled: true, config: { a: 1 } })
	})

	it("accepts an already-parsed object", () => {
		const parsed = parsePluginDeclaration({ version: 1, plugins: { foo: { source: "./foo", version: "1.0.0" } } })
		expect(parsed.plugins.foo!.source).toBe("./foo")
	})

	it("fails closed to empty on corrupt JSON", () => {
		expect(parsePluginDeclaration("{ not valid json")).toEqual(EMPTY_PLUGIN_DECLARATION)
	})

	it("fails closed to empty on a version mismatch", () => {
		const raw = JSON.stringify({ version: 999, plugins: { foo: { source: "./foo", version: "1.0.0" } } })
		expect(parsePluginDeclaration(raw)).toEqual(EMPTY_PLUGIN_DECLARATION)
	})

	it("fails closed to empty on an unknown key (strict)", () => {
		const raw = JSON.stringify({ version: 1, plugins: {}, extra: true })
		expect(parsePluginDeclaration(raw)).toEqual(EMPTY_PLUGIN_DECLARATION)
	})
})

describe("mergePluginDeclarations", () => {
	it("locked plugins/<name> → global's entry wins over user and project", () => {
		const global = decl("foo", { source: "org/foo", version: "1.0.0" })
		const user = decl("foo", { source: "user/foo", version: "2.0.0" })
		const project = decl("foo", { source: "proj/foo", version: "3.0.0" })

		const merged = mergePluginDeclarations({ global, user, project }, locked("plugins/foo"))
		expect(merged.plugins.foo).toEqual({ source: "org/foo", version: "1.0.0" })
	})

	it("unlocked plugins/<name> → project's entry wins (more-specific)", () => {
		const global = decl("bar", { source: "org/bar", version: "1.0.0" })
		const user = decl("bar", { source: "user/bar", version: "2.0.0" })
		const project = decl("bar", { source: "proj/bar", version: "3.0.0" })

		const merged = mergePluginDeclarations({ global, user, project })
		expect(merged.plugins.bar).toEqual({ source: "proj/bar", version: "3.0.0" })
	})

	it("unlocked with only user+global → user wins over global", () => {
		const global = decl("bar", { source: "org/bar", version: "1.0.0" })
		const user = decl("bar", { source: "user/bar", version: "2.0.0" })

		const merged = mergePluginDeclarations({ global, user })
		expect(merged.plugins.bar).toEqual({ source: "user/bar", version: "2.0.0" })
	})

	it("a user may add a plugin the global scope did not declare", () => {
		const global = decl("foo", { source: "org/foo", version: "1.0.0" })
		const user = decl("baz", { source: "user/baz", version: "1.2.3" })

		const merged = mergePluginDeclarations({ global, user }, locked("plugins/foo"))
		expect(merged.plugins.baz).toEqual({ source: "user/baz", version: "1.2.3" })
		expect(merged.plugins.foo).toEqual({ source: "org/foo", version: "1.0.0" })
	})

	it("locking a name global never declared falls back to the unlocked merge", () => {
		const user = decl("baz", { source: "user/baz", version: "1.2.3" })
		// `plugins/baz` is locked but global doesn't declare it → user still wins.
		const merged = mergePluginDeclarations({ user }, locked("plugins/baz"))
		expect(merged.plugins.baz).toEqual({ source: "user/baz", version: "1.2.3" })
	})

	it("does not mutate its inputs", () => {
		const global = decl("foo", { source: "org/foo", version: "1.0.0" })
		const project = decl("foo", { source: "proj/foo", version: "3.0.0" })
		const snapshot = JSON.stringify({ global, project })
		mergePluginDeclarations({ global, project })
		expect(JSON.stringify({ global, project })).toBe(snapshot)
	})
})

describe("resolvePluginDeclaration", () => {
	let tmp: string
	let cacheDir: string

	beforeEach(async () => {
		tmp = await nodeFs.mkdtemp(path.join(os.tmpdir(), "plugin-decl-"))
		cacheDir = path.join(tmp, "cache")
	})

	afterEach(async () => {
		await nodeFs.rm(tmp, { recursive: true, force: true })
	})

	it("materializes a local directory source into <cache>/<name>@<version>/", async () => {
		const src = await writePluginDir(path.join(tmp, "src"), { name: "my-plugin", version: "1.0.0" })

		const result = await resolvePluginDeclaration(decl("my-plugin", { source: src, version: "1.0.0" }), cacheDir)

		expect(result.errors).toEqual([])
		expect(result.resolved).toHaveLength(1)
		const plugin = result.resolved[0]!
		expect(plugin.name).toBe("my-plugin")
		expect(plugin.dir).toBe(path.join(cacheDir, "my-plugin@1.0.0"))
		expect(plugin.enabled).toBe(true)
		// Its files landed in the cache dir.
		expect(await nodeFs.readFile(path.join(plugin.dir, "plugin.json"), "utf-8")).toContain("my-plugin")
		expect(await nodeFs.readFile(path.join(plugin.dir, "skills", "hello.md"), "utf-8")).toContain("hello skill")
	})

	it("carries declaration config + enabled through to the resolved plugin", async () => {
		const src = await writePluginDir(path.join(tmp, "src"), { name: "cfg-plugin", version: "2.1.0" })

		const result = await resolvePluginDeclaration(
			decl("cfg-plugin", { source: src, version: "2.1.0", config: { k: "v" }, enabled: false }),
			cacheDir,
		)

		expect(result.resolved[0]!.config).toEqual({ k: "v" })
		expect(result.resolved[0]!.enabled).toBe(false)
	})

	it("is idempotent — a second call does not re-copy", async () => {
		const src = await writePluginDir(path.join(tmp, "src"), { name: "idem", version: "1.0.0" })
		const declaration = decl("idem", { source: src, version: "1.0.0" })

		const first = await resolvePluginDeclaration(declaration, cacheDir)
		const targetDir = first.resolved[0]!.dir
		// Mark the cache dir; an idempotent re-run must NOT wipe/re-copy it.
		const marker = path.join(targetDir, ".marker")
		await nodeFs.writeFile(marker, "kept")

		const second = await resolvePluginDeclaration(declaration, cacheDir)

		expect(second.resolved).toHaveLength(1)
		expect(second.resolved[0]!.dir).toBe(targetDir)
		expect(await nodeFs.readFile(marker, "utf-8")).toBe("kept")
	})

	it("materializes a .shofer-plugin archive source", async () => {
		const src = await writePluginDir(path.join(tmp, "src-archive"), { name: "arch", version: "3.0.0" })
		const archivePath = path.join(tmp, "arch.shofer-plugin")
		await packPluginToFile(src, archivePath)

		const result = await resolvePluginDeclaration(decl("arch", { source: archivePath, version: "3.0.0" }), cacheDir)

		expect(result.errors).toEqual([])
		expect(result.resolved).toHaveLength(1)
		expect(result.resolved[0]!.dir).toBe(path.join(cacheDir, "arch@3.0.0"))
		expect(await nodeFs.readFile(path.join(result.resolved[0]!.dir, "plugin.json"), "utf-8")).toContain("arch")
	})

	it("throws PluginResolveError for a marketplace: source", async () => {
		await expect(
			resolvePluginDeclaration(decl("mkt", { source: "marketplace:some-id@1.0.0", version: "1.0.0" }), cacheDir),
		).rejects.toBeInstanceOf(PluginResolveError)
	})

	it("throws PluginResolveError for a remote URL source", async () => {
		await expect(
			resolvePluginDeclaration(
				decl("remote", { source: "https://example.com/x.shofer-plugin", version: "1.0.0" }),
				cacheDir,
			),
		).rejects.toBeInstanceOf(PluginResolveError)
	})

	it("skips a name mismatch with an error entry but still resolves the rest", async () => {
		// `bad` declares name "bad" but its manifest says "actually-other".
		const badSrc = await writePluginDir(path.join(tmp, "bad"), { name: "actually-other", version: "1.0.0" })
		const goodSrc = await writePluginDir(path.join(tmp, "good"), { name: "good", version: "1.0.0" })

		const declaration: PluginDeclaration = {
			version: PLUGIN_DECLARATION_VERSION,
			plugins: {
				bad: { source: badSrc, version: "1.0.0" },
				good: { source: goodSrc, version: "1.0.0" },
			},
		}

		const result = await resolvePluginDeclaration(declaration, cacheDir)

		expect(result.resolved.map((p) => p.name)).toEqual(["good"])
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]!.name).toBe("bad")
		expect(result.errors[0]!.message).toContain("does not match")
	})
})
