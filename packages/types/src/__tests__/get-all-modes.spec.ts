import type { ModeConfig } from "../mode.js"

import { getAllModes, modes } from "../modes.js"

const bundleMode = (slug: string, name = slug): ModeConfig => ({
	slug,
	name,
	roleDefinition: `${name} role`,
	tools: ["read"],
})

describe("getAllModes governance flag (disableBuiltIn)", () => {
	it("returns all built-in modes when no flag and no custom modes", () => {
		expect(getAllModes()).toEqual([...modes])
		expect(getAllModes([])).toEqual([...modes])
	})

	it("layers custom modes on top of built-ins when the flag is absent", () => {
		const custom = [bundleMode("my-bundle-mode")]
		const result = getAllModes(custom)
		expect(result.length).toBe(modes.length + 1)
		// built-ins preserved, custom appended
		expect(result.slice(0, modes.length)).toEqual([...modes])
		expect(result[result.length - 1]).toEqual(custom[0])
	})

	it("overrides a built-in mode by slug when the flag is absent (unchanged behavior)", () => {
		const override = bundleMode(modes[0]!.slug, "Overridden")
		const result = getAllModes([override])
		expect(result.length).toBe(modes.length)
		expect(result.find((m) => m.slug === modes[0]!.slug)).toEqual(override)
	})

	it("suppresses built-ins and returns ONLY custom modes when the flag is on", () => {
		const custom = [bundleMode("only-a"), bundleMode("only-b")]
		const result = getAllModes(custom, { disableBuiltIn: true })
		expect(result).toEqual(custom)
		// none of the built-in slugs leak through
		for (const builtIn of modes) {
			expect(result.some((m) => m.slug === builtIn.slug)).toBe(false)
		}
	})

	it("returns an empty array with the flag on and no custom modes — built-ins are NOT re-added", () => {
		expect(getAllModes(undefined, { disableBuiltIn: true })).toEqual([])
		expect(getAllModes([], { disableBuiltIn: true })).toEqual([])
	})

	it("with the flag on, a custom mode sharing a built-in slug is kept as-is (no duplicate built-in)", () => {
		// A bundle may deliberately reuse the "code" slug; with built-ins off it
		// must resolve to the bundle's version, and only once.
		const override = bundleMode("code", "Bundle Code")
		const result = getAllModes([override], { disableBuiltIn: true })
		expect(result).toEqual([override])
	})

	it("is a no-op difference when disableBuiltIn is false vs absent", () => {
		const custom = [bundleMode("x")]
		expect(getAllModes(custom, { disableBuiltIn: false })).toEqual(getAllModes(custom))
	})
})
