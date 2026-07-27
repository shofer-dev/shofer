import fs from "fs"
import path from "path"

import * as kit from "../index"

/**
 * `public/plugin-host/plugin-ui.js` is hand-written plain ESM (it is served verbatim,
 * never transformed), so nothing type-checks it against the module it mirrors. A name
 * that is added here but not there simply does not exist for plugins; a name that is
 * misspelled there resolves to `undefined` and fails as "Button is not a function" deep
 * inside a plugin's bundle, far from the cause.
 *
 * These specs make that drift a test failure instead.
 */

// The webview runs under jsdom, where `import.meta.url` is not a file URL — resolve
// from the vitest root (webview-ui) instead.
const SHIM = path.resolve(process.cwd(), "public/plugin-host/plugin-ui.js")
/** The declaration plugins typecheck against (they live outside every tsc root). */
const DECLARATION = path.resolve(process.cwd(), "../plugins/plugin-ui.d.ts")

/** `export const X = NS.X` / `export const X = NS.Y` → the exported names and their sources. */
function shimExports(): { name: string; source: string }[] {
	const source = fs.readFileSync(SHIM, "utf8")
	return [...source.matchAll(/export const (\w+) = NS\.(\w+)/g)].map((m) => ({ name: m[1]!, source: m[2]! }))
}

describe("@shofer/plugin-ui shim", () => {
	it("exports exactly what the kit module exports", () => {
		const exported = shimExports().map((e) => e.name)
		// Types erase at build time, so only runtime values can be (or need to be) shimmed.
		const kitValues = Object.keys(kit).filter((key) => kit[key as keyof typeof kit] !== undefined)

		expect(new Set(exported)).toEqual(new Set(kitValues))
	})

	it("reads each export off the global under its own name", () => {
		// `export const Button = NS.Dialog` would be a silent, very confusing bug.
		for (const { name, source } of shimExports()) {
			expect(source).toBe(name)
		}
	})

	it("reads the global the host publishes", () => {
		expect(fs.readFileSync(SHIM, "utf8")).toContain("globalThis.__shoferPluginUi")
	})

	it("declares every export for the plugins that typecheck against it", () => {
		// `plugins/plugin-ui.d.ts` is hand-written (a plugin cannot compile the webview's
		// source), so an export added here without a declaration there is invisible to
		// every plugin — it fails as "has no exported member" in their build, not ours.
		const declared = fs.readFileSync(DECLARATION, "utf8")
		const undeclared = shimExports()
			.map((e) => e.name)
			.filter((name) => !new RegExp(`\\b(const|function) ${name}\\b`).test(declared))

		// A non-empty list here names exactly what to add to `plugins/plugin-ui.d.ts`.
		expect(undeclared).toEqual([])
	})
})
