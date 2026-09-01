import type { ModeConfig } from "@shofer/types"

import {
	EMPTY_LOCKED_MANIFEST,
	isPathLocked,
	LOCKED_MANIFEST_VERSION,
	mergeLayeredConfig,
	parseLockedManifest,
	type LayeredSettings,
	type LockedManifest,
} from "../layered-config.js"

/** Build a locked manifest from a plain list of locked paths. */
function locked(paths: string[]): LockedManifest {
	return { version: LOCKED_MANIFEST_VERSION, locked: paths }
}

/** Minimal valid `ModeConfig` fixture. */
function mode(slug: string, roleDefinition: string): ModeConfig {
	return { slug, name: slug, roleDefinition, tools_allowed: [] }
}

describe("parseLockedManifest", () => {
	it("parses a well-formed manifest", () => {
		const raw = { version: LOCKED_MANIFEST_VERSION, locked: ["autoApprovalEnabled", "modes/Code"] }
		expect(parseLockedManifest(raw)).toEqual(raw)
	})

	it("fails closed to an empty manifest on a version mismatch", () => {
		expect(parseLockedManifest({ version: 999, locked: ["autoApprovalEnabled"] })).toEqual(EMPTY_LOCKED_MANIFEST)
	})

	it("fails closed to an empty manifest on corrupt input", () => {
		expect(parseLockedManifest({ locked: "not-an-array" })).toEqual(EMPTY_LOCKED_MANIFEST)
		expect(parseLockedManifest(null)).toEqual(EMPTY_LOCKED_MANIFEST)
		expect(parseLockedManifest("garbage")).toEqual(EMPTY_LOCKED_MANIFEST)
	})
})

describe("isPathLocked", () => {
	it("reports membership in the locked list", () => {
		const manifest = locked(["autoApprovalEnabled", "modes/Code"])
		expect(isPathLocked("autoApprovalEnabled", manifest)).toBe(true)
		expect(isPathLocked("modes/Code", manifest)).toBe(true)
		expect(isPathLocked("writeDelayMs", manifest)).toBe(false)
	})
})

describe("mergeLayeredConfig — scalar keys", () => {
	it("locked scalar: global wins over user and project", () => {
		const result = mergeLayeredConfig(
			{
				global: { autoApprovalEnabled: false },
				user: { autoApprovalEnabled: true },
				project: { autoApprovalEnabled: true },
			},
			locked(["autoApprovalEnabled"]),
		)
		expect(result.autoApprovalEnabled).toBe(false)
	})

	it("unlocked scalar: project wins, and user beats global", () => {
		const projectWins = mergeLayeredConfig({
			global: { writeDelayMs: 100 },
			user: { writeDelayMs: 200 },
			project: { writeDelayMs: 300 },
		})
		expect(projectWins.writeDelayMs).toBe(300)

		const userBeatsGlobal = mergeLayeredConfig({
			global: { writeDelayMs: 100 },
			user: { writeDelayMs: 200 },
		})
		expect(userBeatsGlobal.writeDelayMs).toBe(200)
	})

	it("locking a key the global layer never set falls back to the unlocked merge", () => {
		const result = mergeLayeredConfig(
			{
				user: { writeDelayMs: 200 },
				project: { writeDelayMs: 300 },
			},
			locked(["writeDelayMs"]),
		)
		expect(result.writeDelayMs).toBe(300)
	})

	it("a user/project locked.json is ignored (only the passed manifest is honored)", () => {
		// The caller reads locked.json only from the global scope; user/project
		// layers are plain settings with no lock authority. Simulate a project
		// trying to lock a key by passing no manifest — nothing is locked, so the
		// normal more-specific-wins merge applies and project overrides global.
		const result = mergeLayeredConfig({
			global: { autoApprovalEnabled: false },
			project: { autoApprovalEnabled: true },
		})
		expect(result.autoApprovalEnabled).toBe(true)
	})
})

describe("mergeLayeredConfig — deep merge of nested objects (unlocked)", () => {
	it("deep-merges nested plain objects, most-specific leaf winning", () => {
		const result = mergeLayeredConfig({
			global: { profileThresholds: { a: 1, b: 2 } },
			user: { profileThresholds: { b: 20, c: 30 } },
			project: { profileThresholds: { c: 300, d: 400 } },
		})
		expect(result.profileThresholds).toEqual({ a: 1, b: 20, c: 300, d: 400 })
	})

	it("does not mutate the input layers", () => {
		const global: LayeredSettings = { profileThresholds: { a: 1 } }
		const project: LayeredSettings = { profileThresholds: { a: 2 } }
		mergeLayeredConfig({ global, project })
		expect(global.profileThresholds).toEqual({ a: 1 })
		expect(project.profileThresholds).toEqual({ a: 2 })
	})
})

describe("mergeLayeredConfig — named-entity collections (customModes)", () => {
	it("unlocked entity: project's mode wins over global's same-slug mode", () => {
		const result = mergeLayeredConfig({
			global: { customModes: [mode("Code", "global-code")] },
			project: { customModes: [mode("Code", "project-code")] },
		})
		const codeMode = result.customModes?.find((m) => m.slug === "Code")
		expect(codeMode?.roleDefinition).toBe("project-code")
	})

	it("locked named entity: global's Code mode wins, but other modes still project-wins", () => {
		const result = mergeLayeredConfig(
			{
				global: { customModes: [mode("Code", "global-code"), mode("Docs", "global-docs")] },
				project: { customModes: [mode("Code", "project-code"), mode("Docs", "project-docs")] },
			},
			locked(["modes/Code"]),
		)
		const codeMode = result.customModes?.find((m) => m.slug === "Code")
		const docsMode = result.customModes?.find((m) => m.slug === "Docs")
		expect(codeMode?.roleDefinition).toBe("global-code")
		expect(docsMode?.roleDefinition).toBe("project-docs")
	})

	it("a locked named entity cannot be removed by user/project (it stays present)", () => {
		const result = mergeLayeredConfig(
			{
				global: { customModes: [mode("Code", "global-code")] },
				project: { customModes: [] },
			},
			locked(["modes/Code"]),
		)
		expect(result.customModes?.find((m) => m.slug === "Code")?.roleDefinition).toBe("global-code")
	})

	it("additive: user and project add modes the global layer did not define", () => {
		const result = mergeLayeredConfig({
			global: { customModes: [mode("Code", "global-code")] },
			user: { customModes: [mode("UserMode", "user-mode")] },
			project: { customModes: [mode("ProjectMode", "project-mode")] },
		})
		const slugs = result.customModes?.map((m) => m.slug).sort()
		expect(slugs).toEqual(["Code", "ProjectMode", "UserMode"])
	})

	it("whole-collection lock: every global mode wins and additions are still allowed", () => {
		const result = mergeLayeredConfig(
			{
				global: { customModes: [mode("Code", "global-code")] },
				project: { customModes: [mode("Code", "project-code"), mode("Extra", "project-extra")] },
			},
			locked(["modes"]),
		)
		expect(result.customModes?.find((m) => m.slug === "Code")?.roleDefinition).toBe("global-code")
		// A project-added mode the global layer did not define is still additive.
		expect(result.customModes?.find((m) => m.slug === "Extra")?.roleDefinition).toBe("project-extra")
	})
})

/**
 * `alwaysAllowGroups` is the record-valued key: one auto-approve toggle per tool
 * CATEGORY, in a map whose membership nobody can enumerate in advance (a dynamic
 * category is minted by whatever declares it). It therefore merges and locks per
 * ENTRY — the `<key>/<name>` grammar the named-entity collections use, applied to
 * a record — because an org pinning one category must not thereby freeze every
 * user's unrelated toggles.
 */
describe("mergeLayeredConfig — record-valued keys (alwaysAllowGroups)", () => {
	it("merges per entry across scopes rather than replacing the map", () => {
		const result = mergeLayeredConfig({
			global: { alwaysAllowGroups: { browser: false } },
			user: { alwaysAllowGroups: { salesforce: true } },
		})
		expect(result.alwaysAllowGroups).toEqual({ browser: false, salesforce: true })
	})

	it("unlocked entry: project wins, and user beats global", () => {
		const result = mergeLayeredConfig({
			global: { alwaysAllowGroups: { browser: false, salesforce: false, jira: false } },
			user: { alwaysAllowGroups: { browser: true, salesforce: true } },
			project: { alwaysAllowGroups: { browser: false } },
		})
		expect(result.alwaysAllowGroups).toEqual({ browser: false, salesforce: true, jira: false })
	})

	it("locked entry: global's value wins for it alone, siblings still merge", () => {
		const result = mergeLayeredConfig(
			{
				global: { alwaysAllowGroups: { browser: false, salesforce: false } },
				user: { alwaysAllowGroups: { browser: true, salesforce: true, jira: true } },
			},
			locked(["alwaysAllowGroups/browser"]),
		)
		expect(result.alwaysAllowGroups).toEqual({ browser: false, salesforce: true, jira: true })
	})

	it("the bare key still locks the whole map, additions included", () => {
		const result = mergeLayeredConfig(
			{
				global: { alwaysAllowGroups: { browser: false } },
				user: { alwaysAllowGroups: { browser: true, salesforce: true } },
				project: { alwaysAllowGroups: { jira: true } },
			},
			locked(["alwaysAllowGroups"]),
		)
		expect(result.alwaysAllowGroups).toEqual({ browser: false })
	})

	// Locking what nobody set is meaningless, exactly as for a scalar key or a
	// named entity: there is no global value for the lock to make final.
	it("locking an entry the global layer never set falls back to the unlocked merge", () => {
		const result = mergeLayeredConfig(
			{
				user: { alwaysAllowGroups: { browser: true } },
				project: { alwaysAllowGroups: { browser: false } },
			},
			locked(["alwaysAllowGroups/browser"]),
		)
		expect(result.alwaysAllowGroups).toEqual({ browser: false })
	})

	// The asymmetry the per-entry merge leaves: a scope ADDS or OVERRIDES, never
	// deletes. An org revokes a grant by locking an explicit `false`.
	it("a scope cannot delete an entry another scope declared", () => {
		const result = mergeLayeredConfig({
			global: { alwaysAllowGroups: { browser: true } },
			project: { alwaysAllowGroups: {} },
		})
		expect(result.alwaysAllowGroups).toEqual({ browser: true })
	})

	it("is additive when only one scope declares the key", () => {
		const result = mergeLayeredConfig({ user: { alwaysAllowGroups: { salesforce: true } } })
		expect(result.alwaysAllowGroups).toEqual({ salesforce: true })
	})

	it("does not mutate the input layers", () => {
		const global: LayeredSettings = { alwaysAllowGroups: { browser: false } }
		const user: LayeredSettings = { alwaysAllowGroups: { browser: true } }
		mergeLayeredConfig({ global, user })
		expect(global.alwaysAllowGroups).toEqual({ browser: false })
		expect(user.alwaysAllowGroups).toEqual({ browser: true })
	})
})

describe("mergeLayeredConfig — additive top-level keys", () => {
	it("user/project may add keys the global layer does not define", () => {
		const result = mergeLayeredConfig({
			global: { autoApprovalEnabled: true },
			user: { soundEnabled: true },
			project: { ttsEnabled: true },
		})
		expect(result.autoApprovalEnabled).toBe(true)
		expect(result.soundEnabled).toBe(true)
		expect(result.ttsEnabled).toBe(true)
	})
})
