import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"

import { hostNodePaths } from "../plugin-loader.js"

/**
 * `hostNodePaths` — where esbuild looks for the plugin SDK when transpiling a plugin entry.
 *
 * This is the difference between a plugin loading and not loading on a deployed node. A
 * plugin's TS entry imports `@shofer/types`; a plugin installed at a standalone path (the
 * deployed shape — `/opt/shofer-plugins/<name>` symlinked into the global scope) has nothing
 * above it to resolve that from, so the SDK must come from the HOST's installation. The
 * regression this pins is a path built for one host shape: `<extensionPath>/dist/plugin-sdk`
 * is right in VS Code (extensionPath = extension root) and resolves to nothing headless
 * (extensionPath = the bundle itself), where every TS plugin then failed to load.
 */
describe("hostNodePaths", () => {
	let tmp: string

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shofer-nodepaths-"))
	})

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true })
	})

	const mk = (...segments: string[]) => {
		const dir = path.join(tmp, ...segments)
		fs.mkdirSync(dir, { recursive: true })
		return dir
	}

	it("finds the SDK when extensionPath is the extension root (VS Code)", () => {
		const root = mk("ext")
		const sdk = mk("ext", "dist", "plugin-sdk", "node_modules")

		expect(hostNodePaths(root)).toContain(sdk)
	})

	it("finds the SDK when extensionPath IS the bundle (headless `shofer serve`)", () => {
		const bundle = mk("ext", "dist")
		const sdk = mk("ext", "dist", "plugin-sdk", "node_modules")

		expect(hostNodePaths(bundle)).toContain(sdk)
	})

	it("also offers the host's own node_modules, for a source checkout", () => {
		const bundle = mk("pkg", "dist")
		const hostModules = mk("pkg", "node_modules")

		expect(hostNodePaths(bundle)).toContain(hostModules)
	})

	it("returns only paths that exist, so a root can never mask a resolution failure", () => {
		const bundle = mk("ext", "dist")

		for (const dir of hostNodePaths(bundle)) {
			expect(fs.existsSync(dir)).toBe(true)
		}
	})

	it("never yields duplicates when the shapes overlap", () => {
		const bundle = mk("ext", "dist")
		mk("ext", "dist", "plugin-sdk", "node_modules")
		mk("ext", "dist", "node_modules")

		const paths = hostNodePaths(bundle)
		expect(paths).toEqual([...new Set(paths)])
	})
})
