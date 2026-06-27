/**
 * Unit tests for navigator-shim.js — the esbuild banner that shadows VS Code's
 * throwing, non-configurable `navigator` global in the Node extension host.
 *
 * The shim works by *lexical shadowing*: declared at the top of the CJS bundle,
 * its module-scoped `navigator` binding is what every bundled dependency's bare
 * `navigator` reference resolves to. We reproduce that by evaluating
 * `shim + dependency-access` inside a single function scope (via `new Function`)
 * while a throwing `navigator` sits on the global — exactly the runtime shape.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const shimSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "navigator-shim.js"), "utf8")

const installThrowingGlobalNavigator = () =>
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		get() {
			throw new Error("PendingMigrationError: navigator is now a global in nodejs")
		},
	})

describe("navigator-shim", () => {
	it("shadows a throwing global navigator so bundled deps read a benign value", () => {
		installThrowingGlobalNavigator()
		// Sanity: the global getter throws, like VS Code's migration proxy.
		expect(() => (globalThis as { navigator: { userAgent: string } }).navigator.userAgent).toThrow()

		// Simulate the bundle: shim banner + a dependency's feature-detect, all in
		// one lexical scope (mirrors esbuild's CJS module scope).
		const depAccess = '\n;return (typeof navigator !== "undefined" && navigator.userAgent);'
		const ua = new Function(shimSrc + depAccess)()
		expect(ua).toBe("Shofer/node")
	})

	it("never touches the throwing global (no error even when access throws)", () => {
		installThrowingGlobalNavigator()
		// Running the shim alone must not throw or access the global getter.
		expect(() => new Function(shimSrc)()).not.toThrow()
	})

	it("exposes the common UA-sniffing fields deps expect", () => {
		const nav = new Function(shimSrc + "\n;return navigator;")()
		expect(typeof nav.userAgent).toBe("string")
		expect(typeof nav.platform).toBe("string")
		expect(nav.language).toBe("en-US")
		expect(typeof nav.hardwareConcurrency).toBe("number")
	})
})
