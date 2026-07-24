import { EMPTY_LOCKED_MANIFEST, type LockedManifest, type ResolvedPlugin } from "@shofer/core"

import { computePluginDeclarationWiring } from "../pluginDeclarationLoader"

/**
 * Unit tests for {@link computePluginDeclarationWiring} — the pure host-side core of
 * Part F wiring (`.shofer/plugins.json` → `PluginManager` discovery inputs). Covers
 * the three invariants the mandate calls out: (a) no declarations → zero additions
 * (byte-for-byte-as-before), (b) a declared plugin → its dir added / config seeded /
 * name enabled, (c) a global-locked declared plugin → its config wins over an
 * existing user `pluginConfigs` entry.
 */

function resolved(overrides: Partial<ResolvedPlugin> & Pick<ResolvedPlugin, "name">): ResolvedPlugin {
	return {
		dir: `/cache/${overrides.name}@1.0.0`,
		version: "1.0.0",
		enabled: true,
		...overrides,
	}
}

/** A lock manifest that locks `plugins/<name>` for each given name. */
function lockManifest(...names: string[]): LockedManifest {
	return { version: EMPTY_LOCKED_MANIFEST.version, locked: names.map((n) => `plugins/${n}`) }
}

describe("computePluginDeclarationWiring", () => {
	it("(a) produces zero additions when nothing is declared", () => {
		const wiring = computePluginDeclarationWiring([], EMPTY_LOCKED_MANIFEST, { existing: { a: 1 } }, ["already-on"])

		expect(wiring.pluginDirs).toEqual([])
		expect(wiring.pluginConfigsChanged).toBe(false)
		expect(wiring.enabledChanged).toBe(false)
		// Existing config + enabled set carried through untouched.
		expect(wiring.pluginConfigs).toEqual({ existing: { a: 1 } })
		expect(wiring.enabledPlugins).toEqual(["already-on"])
	})

	it("(b) adds a declared plugin's cache dir, seeds its config, and enables it", () => {
		const plugin = resolved({ name: "acme", dir: "/cache/acme@2.1.0", config: { greeting: "hi" } })

		const wiring = computePluginDeclarationWiring([plugin], EMPTY_LOCKED_MANIFEST, {}, [])

		expect(wiring.pluginDirs).toEqual([{ dir: "/cache/acme@2.1.0", scope: "global" }])
		expect(wiring.pluginConfigsChanged).toBe(true)
		expect(wiring.pluginConfigs).toEqual({ acme: { greeting: "hi" } })
		expect(wiring.enabledChanged).toBe(true)
		expect(wiring.enabledPlugins).toEqual(["acme"])
	})

	it("(b) unlocked declared config is a default — the user's stored value wins", () => {
		const plugin = resolved({ name: "acme", config: { greeting: "hi", extra: "seeded" } })

		const wiring = computePluginDeclarationWiring(
			[plugin],
			EMPTY_LOCKED_MANIFEST,
			{ acme: { greeting: "user-set" } },
			[],
		)

		// Stored `greeting` wins; the declared `extra` default fills the unset key.
		expect(wiring.pluginConfigs.acme).toEqual({ greeting: "user-set", extra: "seeded" })
		expect(wiring.pluginConfigsChanged).toBe(true)
	})

	it("(c) a global-locked declared plugin's config wins over an existing user entry and is always enabled", () => {
		const plugin = resolved({ name: "acme", config: { greeting: "org-mandated" }, enabled: false })

		const wiring = computePluginDeclarationWiring(
			[plugin],
			lockManifest("acme"),
			{ acme: { greeting: "user-set" } },
			[],
		)

		// Declared (locked) value overrides the user's stored value.
		expect(wiring.pluginConfigs.acme).toEqual({ greeting: "org-mandated" })
		expect(wiring.pluginConfigsChanged).toBe(true)
		// Locked ⇒ always enabled, even though the declaration set `enabled: false`.
		expect(wiring.enabledPlugins).toEqual(["acme"])
		expect(wiring.enabledChanged).toBe(true)
	})

	it("does not re-record an already-enabled plugin or an unchanged config", () => {
		const plugin = resolved({ name: "acme", config: { greeting: "hi" } })

		const wiring = computePluginDeclarationWiring([plugin], EMPTY_LOCKED_MANIFEST, { acme: { greeting: "hi" } }, [
			"acme",
		])

		expect(wiring.pluginConfigsChanged).toBe(false)
		expect(wiring.enabledChanged).toBe(false)
		// The dir is still appended (discovery is additive regardless of prior state).
		expect(wiring.pluginDirs).toEqual([{ dir: "/cache/acme@1.0.0", scope: "global" }])
	})
})
