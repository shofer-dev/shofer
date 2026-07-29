import type { ModeConfig } from "../mode.js"

import { getAllModes, resolveModeConfig, isCustomMode, defaultModeSlug } from "../modes.js"

/**
 * Modes are **data**, not a constant: Shofer's own six arrive from the bundled
 * `builtin-config` plugin and reach these helpers through the same list as the user's
 * and the project's. So the helpers below know nothing about "built-in" — they merge,
 * de-duplicate and resolve whatever list the host assembled.
 */

const mode = (slug: string, source?: ModeConfig["source"], name = slug): ModeConfig => ({
	slug,
	name,
	roleDefinition: `${name} role`,
	tools: ["read"],
	...(source ? { source } : {}),
})

const pluginModes = [mode("code", "plugin"), mode("architect", "plugin")]

describe("getAllModes", () => {
	it("returns an empty list when nothing defines a mode", () => {
		expect(getAllModes()).toEqual([])
		expect(getAllModes([])).toEqual([])
	})

	it("preserves the order the host merged in", () => {
		const all = getAllModes([mode("mine", "project"), ...pluginModes])
		expect(all.map((m) => m.slug)).toEqual(["mine", "code", "architect"])
	})

	it("keeps the first entry for a repeated slug, so a project mode shadows the plugin's", () => {
		const override = mode("code", "project", "My Code")
		const all = getAllModes([override, ...pluginModes])
		expect(all).toHaveLength(2)
		expect(all.find((m) => m.slug === "code")).toEqual(override)
	})
})

describe("resolveModeConfig", () => {
	it("prefers the requested mode", () => {
		expect(resolveModeConfig("architect", pluginModes).slug).toBe("architect")
	})

	it("falls back to the default mode when the slug is unknown", () => {
		expect(resolveModeConfig("deleted-mode", pluginModes).slug).toBe(defaultModeSlug)
	})

	it("falls back to the first available mode when even the default is gone", () => {
		// An org that suppressed the built-ins and shipped its own set has no `code`.
		const orgModes = [mode("org-one", "global"), mode("org-two", "global")]
		expect(resolveModeConfig("deleted-mode", orgModes).slug).toBe("org-one")
	})

	it("throws rather than inventing a mode when no mode exists at all", () => {
		// Misconfiguration the user has to see — a silent stub mode would produce a
		// system prompt with no role definition and no tool restrictions.
		expect(() => resolveModeConfig("code", [])).toThrow(/No modes are available/)
	})
})

describe("isCustomMode", () => {
	it("is true only for a mode the user or project authored", () => {
		const all = [mode("mine", "project"), ...pluginModes]
		expect(isCustomMode("mine", all)).toBe(true)
		expect(isCustomMode("code", all)).toBe(false)
		expect(isCustomMode("missing", all)).toBe(false)
	})
})
