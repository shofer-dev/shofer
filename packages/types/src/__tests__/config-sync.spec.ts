import { describe, it, expect } from "vitest"

import {
	GLOBAL_SECRET_KEYS,
	GLOBAL_SETTINGS_KEYS,
	SETTING_SYNC_SCOPE,
	SYNCED_SETTINGS_KEYS,
	computeConfigVersion,
	pickSyncedSettings,
	type SyncedSettings,
} from "../global-settings.js"

describe("computeConfigVersion (config_sync §6)", () => {
	it("is insertion-order-independent — same content, different key order → same version", () => {
		const a: SyncedSettings = {
			autoApprovalEnabled: true,
			alwaysAllowWrite: false,
			allowedCommands: ["ls", "git status"],
		}
		// Same content, keys inserted in a different order.
		const b: SyncedSettings = {
			allowedCommands: ["ls", "git status"],
			alwaysAllowWrite: false,
			autoApprovalEnabled: true,
		}
		expect(computeConfigVersion(a)).toBe(computeConfigVersion(b))
	})

	it("returns a different version when content differs", () => {
		const base: SyncedSettings = { autoApprovalEnabled: true, alwaysAllowWrite: false }
		const changedValue: SyncedSettings = { autoApprovalEnabled: true, alwaysAllowWrite: true }
		const extraKey: SyncedSettings = { autoApprovalEnabled: true, alwaysAllowWrite: false, alwaysAllowMcp: true }
		expect(computeConfigVersion(changedValue)).not.toBe(computeConfigVersion(base))
		expect(computeConfigVersion(extraKey)).not.toBe(computeConfigVersion(base))
	})

	it("is deterministic/stable across repeated calls", () => {
		const config: SyncedSettings = {
			autoApprovalEnabled: true,
			allowedCommands: ["a", "b"],
			maxWorkspaceFiles: 200,
		}
		const v = computeConfigVersion(config)
		expect(computeConfigVersion(config)).toBe(v)
		expect(computeConfigVersion(config)).toBe(v)
		expect(typeof v).toBe("string")
		expect(v.length).toBeGreaterThan(0)
	})

	it("array order is significant (allowedCommands is order-preserving)", () => {
		const forward: SyncedSettings = { allowedCommands: ["a", "b"] }
		const reversed: SyncedSettings = { allowedCommands: ["b", "a"] }
		expect(computeConfigVersion(forward)).not.toBe(computeConfigVersion(reversed))
	})

	it("handles an empty slice deterministically", () => {
		const empty: SyncedSettings = {}
		const v = computeConfigVersion(empty)
		expect(v).toBe(computeConfigVersion({}))
		expect(typeof v).toBe("string")
		expect(v.length).toBeGreaterThan(0)
	})
})

describe("pickSyncedSettings (config_sync §4a)", () => {
	it("returns only node-scoped keys that are present; drops frontend-only and absent keys", () => {
		const mixed = {
			// node-scoped, present → kept
			autoApprovalEnabled: true,
			alwaysAllowWrite: false,
			allowedCommands: ["ls"],
			// frontend-only, present → dropped
			language: "en" as const,
			soundEnabled: true,
			openRouterImageApiKey: "sk-secret", // secret → frontend → dropped
			// node-scoped but absent (undefined) → omitted
			alwaysAllowMcp: undefined,
		}

		const picked = pickSyncedSettings(mixed)

		expect(picked).toEqual({
			autoApprovalEnabled: true,
			alwaysAllowWrite: false,
			allowedCommands: ["ls"],
		})
		// Frontend-only keys are absent entirely.
		expect("language" in picked).toBe(false)
		expect("soundEnabled" in picked).toBe(false)
		expect("openRouterImageApiKey" in picked).toBe(false)
		// Absent node-scoped key is omitted (not present as undefined).
		expect("alwaysAllowMcp" in picked).toBe(false)
	})

	it("returns an empty object when nothing node-scoped is present", () => {
		expect(pickSyncedSettings({ language: "en", soundEnabled: false })).toEqual({})
	})

	it("only ever emits keys drawn from SYNCED_SETTINGS_KEYS", () => {
		const picked = pickSyncedSettings({
			autoApprovalEnabled: true,
			language: "en",
			mode: "code",
		})
		for (const key of Object.keys(picked)) {
			expect(SYNCED_SETTINGS_KEYS).toContain(key)
		}
	})
})

describe("SETTING_SYNC_SCOPE invariants (config_sync §3)", () => {
	it("is exhaustive — every GLOBAL_SETTINGS_KEYS entry has a scope", () => {
		expect(GLOBAL_SETTINGS_KEYS.every((k) => k in SETTING_SYNC_SCOPE)).toBe(true)
	})

	it("classifies every entry as exactly 'node' or 'frontend'", () => {
		for (const scope of Object.values(SETTING_SYNC_SCOPE)) {
			expect(scope === "node" || scope === "frontend").toBe(true)
		}
	})

	it("never routes a secret over the sync channel — no GLOBAL_SECRET_KEYS entry is 'node'", () => {
		// The motivating secret example (image-gen API key).
		expect(SETTING_SYNC_SCOPE["openRouterImageApiKey"]).not.toBe("node")
		// And, generally, no global secret is node-scoped.
		for (const secret of GLOBAL_SECRET_KEYS) {
			expect(SETTING_SYNC_SCOPE[secret]).not.toBe("node")
		}
	})

	it("SYNCED_SETTINGS_KEYS equals exactly the keys whose scope is 'node'", () => {
		const nodeKeys = (Object.keys(SETTING_SYNC_SCOPE) as (keyof typeof SETTING_SYNC_SCOPE)[]).filter(
			(k) => SETTING_SYNC_SCOPE[k] === "node",
		)
		// Same membership, independent of order.
		expect(new Set(SYNCED_SETTINGS_KEYS)).toEqual(new Set(nodeKeys))
		expect(SYNCED_SETTINGS_KEYS.length).toBe(nodeKeys.length)
		// Every synced key really is node-scoped.
		for (const k of SYNCED_SETTINGS_KEYS) {
			expect(SETTING_SYNC_SCOPE[k]).toBe("node")
		}
	})

	it("includes the core auto-approval keys", () => {
		expect(SYNCED_SETTINGS_KEYS).toContain("autoApprovalEnabled")
		expect(SYNCED_SETTINGS_KEYS).toContain("alwaysAllowWrite")
		expect(SYNCED_SETTINGS_KEYS).toContain("allowedCommands")
	})
})
