// npx vitest src/__tests__/navigator-shim-module.test.ts

/**
 * The shim as a MODULE, rather than as the string the sibling spec evaluates.
 *
 * The sibling test reproduces the production shape — the banner's lexical
 * shadowing — by evaluating the source inside `new Function`, which is the only
 * way to prove the shadowing works. That form runs no instrumented code, so this
 * file loads the file itself: the values it publishes (a userAgent bundled deps
 * feature-detect on, a non-zero `hardwareConcurrency` several of them divide by)
 * are what the shim exists to supply, and a change to them is a change to what
 * every bundled dependency sees at activation.
 */

import { createRequire } from "module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const shimPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "navigator-shim.js")

/**
 * `var navigator` at the top of a CJS module is module-scoped, so the value is
 * only observable from inside the file. Loading it through Node's own CJS loader
 * with the module wrapper's `exports` object handed back lets the test read it.
 */
function loadShimValue(): Record<string, unknown> {
	const nodeRequire = createRequire(import.meta.url)
	const fs = nodeRequire("fs") as typeof import("fs")
	const source = fs.readFileSync(shimPath, "utf8")
	const factory = new Function("require", "process", `${source}; return navigator`) as (
		r: NodeRequire,
		p: NodeJS.Process,
	) => Record<string, unknown>
	return factory(nodeRequire, process)
}

describe("navigator-shim loads as a module", () => {
	it("evaluates without touching the throwing global", async () => {
		// The banner declares `var navigator` at file scope, so importing it is
		// inert: nothing is exported and the global is never read.
		await expect(import(/* @vite-ignore */ shimPath)).resolves.toBeDefined()
	})
})

describe("navigator-shim's published values", () => {
	it("publishes a userAgent, which is what bundled deps feature-detect on", () => {
		expect(loadShimValue().userAgent).toBe("Shofer/node")
	})

	it("reports the host platform", () => {
		expect(loadShimValue().platform).toBe(process.platform)
	})

	it("reports a NON-ZERO hardwareConcurrency — several deps divide by it", () => {
		expect(loadShimValue().hardwareConcurrency).toBeGreaterThanOrEqual(1)
	})

	it("declares the host online, and one language", () => {
		const value = loadShimValue()

		expect(value.onLine).toBe(true)
		expect(value.language).toBe("en-US")
		expect(value.languages).toEqual(["en-US"])
	})

	it("falls back to ONE core when `os` is unavailable", () => {
		const nodeRequire = createRequire(import.meta.url)
		const fs = nodeRequire("fs") as typeof import("fs")
		const source = fs.readFileSync(shimPath, "utf8")
		const factory = new Function("require", "process", `${source}; return navigator`) as (
			r: (id: string) => unknown,
			p: NodeJS.Process,
		) => Record<string, unknown>

		const value = factory(() => {
			throw new Error("os unavailable")
		}, process)

		expect(value.hardwareConcurrency).toBe(1)
	})

	it("falls back to an EMPTY platform when process carries none", () => {
		const nodeRequire = createRequire(import.meta.url)
		const fs = nodeRequire("fs") as typeof import("fs")
		const source = fs.readFileSync(shimPath, "utf8")
		const factory = new Function("require", "process", `${source}; return navigator`) as (
			r: NodeRequire,
			p: unknown,
		) => Record<string, unknown>

		expect(factory(nodeRequire, {}).platform).toBe("")
	})
})
