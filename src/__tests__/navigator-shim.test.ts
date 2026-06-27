/**
 * Unit tests for navigator-shim.js — the esbuild banner that neutralizes VS
 * Code's throwing `navigator` migration proxy in the Node extension host (see
 * navigator-shim.js / docs reference). The shim runs as an IIFE against
 * `globalThis`, so each test installs a simulated host `navigator`, evals the
 * shim, and asserts the outcome.
 *
 * Tests are ordered so the non-configurable case (which leaves an unrestorable
 * global) runs last; pollution is contained to this file (vitest isolates files).
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const shimSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "navigator-shim.js"), "utf8")

const setNavigator = (descriptor: PropertyDescriptor) =>
	Object.defineProperty(globalThis, "navigator", { configurable: true, ...descriptor })

const runShim = () => {
	;(0, eval)(shimSrc)
}

describe("navigator-shim", () => {
	it("replaces a throwing (configurable) navigator so property reads succeed", () => {
		setNavigator({
			get() {
				throw new Error("PendingMigrationError: navigator is now a global in nodejs")
			},
		})
		// Reproduce the dependency pattern that crashed before the shim.
		expect(() => (typeof navigator !== "undefined" ? navigator.userAgent : "")).toThrow()
		runShim()
		expect(typeof navigator !== "undefined" && navigator.userAgent).toBe("Shofer/node")
	})

	it("leaves a real, working navigator untouched", () => {
		setNavigator({ value: { userAgent: "Mozilla/5.0 real" } })
		runShim()
		expect(navigator.userAgent).toBe("Mozilla/5.0 real")
	})

	it("does not throw when navigator is non-configurable (degrades gracefully)", () => {
		Object.defineProperty(globalThis, "navigator", {
			configurable: false,
			get() {
				throw new Error("PendingMigrationError")
			},
		})
		expect(() => runShim()).not.toThrow()
	})
})
