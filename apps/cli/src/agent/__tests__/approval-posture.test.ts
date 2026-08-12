// pnpm --filter @shofer/cli test src/agent/__tests__/approval-posture.test.ts

import fs from "fs/promises"
import os from "os"
import path from "path"

import {
	APPROVAL_POSTURE_KEYS,
	applyConfiguredApprovalPosture,
	defaultApprovalSeed,
	resolveApprovalPosture,
	resolveCliScopeRoots,
} from "../approval-posture.js"

/**
 * Tests for the served/CLI node's approval-posture resolution.
 *
 * The load-bearing assertion is the FIRST group: a node whose configuration says
 * nothing must behave exactly as it did before configuration was consulted at all.
 * Deployed workers depend on that, and a regression there either silently stops
 * every pipeline stake (nothing auto-approves, everything parks) or silently
 * un-gates one (everything auto-approves where an operator asked for gating) —
 * neither of which shows up as a test failure anywhere else.
 */

/** Materialise a `.shofer/settings.json` scope root under a fresh temp dir. */
async function makeScope(settings?: Record<string, unknown>): Promise<string> {
	const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "shofer-posture-")), ".shofer")
	await fs.mkdir(root, { recursive: true })
	if (settings) {
		await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings, null, 2), "utf8")
	}
	return root
}

describe("approval posture", () => {
	describe("defaults — behaviour must be unchanged for a node whose config says nothing", () => {
		it("non-interactive auto-approves every tool group and every command", () => {
			const posture = applyConfiguredApprovalPosture(defaultApprovalSeed(true), {}, true)

			expect(posture.configuredKeys).toEqual([])
			expect(posture.seed).toEqual({
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowReadOnlyOutsideWorkspace: true,
				alwaysAllowWrite: true,
				alwaysAllowWriteOutsideWorkspace: true,
				alwaysAllowWriteProtected: true,
				alwaysAllowMcp: true,
				alwaysAllowModeSwitch: true,
				alwaysAllowSubtasks: true,
				alwaysAllowExecute: true,
				allowedCommands: ["*"],
			})
			expect(posture.summary).toBe("auto-approve (default)")
		})

		it("interactive seeds the master gate off and nothing else", () => {
			const posture = applyConfiguredApprovalPosture(defaultApprovalSeed(false), {}, false)

			expect(posture.configuredKeys).toEqual([])
			expect(posture.seed).toEqual({ autoApprovalEnabled: false })
			expect(posture.summary).toBe("interactive, brokered to controller (default)")
		})

		it("an empty overlay is indistinguishable from no overlay", async () => {
			const emptyScope = await makeScope()
			const posture = await resolveApprovalPosture({
				nonInteractive: true,
				roots: { global: emptyScope },
			})

			expect(posture.configuredKeys).toEqual([])
			expect(posture.seed).toEqual(defaultApprovalSeed(true))
			expect(posture.summary).toBe("auto-approve (default)")
		})
	})

	describe("configuration wins over the flag's default", () => {
		it("omits a configured key from the seed instead of overriding it", () => {
			const posture = applyConfiguredApprovalPosture(
				defaultApprovalSeed(true),
				{ autoApprovalEnabled: false, alwaysAllowExecute: false },
				true,
			)

			// Omission is the mechanism: the overlay already wins in ContextProxy.getValue,
			// and seeding the key would write the host default through into the operator's
			// own settings.json.
			expect(posture.seed).not.toHaveProperty("autoApprovalEnabled")
			expect(posture.seed).not.toHaveProperty("alwaysAllowExecute")
			expect(posture.configuredKeys).toEqual(["autoApprovalEnabled", "alwaysAllowExecute"])

			// Untouched posture keys keep the seed's value.
			expect(posture.seed.alwaysAllowWrite).toBe(true)
			expect(posture.seed.allowedCommands).toEqual(["*"])
		})

		it("reports the effective posture and says the source is config", () => {
			const posture = applyConfiguredApprovalPosture(
				defaultApprovalSeed(true),
				{ autoApprovalEnabled: false, alwaysAllowExecute: false },
				true,
			)

			expect(posture.effective.autoApprovalEnabled).toBe(false)
			expect(posture.effective.alwaysAllowExecute).toBe(false)
			expect(posture.summary).toBe(
				"from config (autoApprovalEnabled=false, execute gated, 2 keys from .shofer config)",
			)
		})

		it("gates execute when the master toggle is on but alwaysAllowExecute is off", () => {
			const posture = applyConfiguredApprovalPosture(
				defaultApprovalSeed(true),
				{ alwaysAllowExecute: false },
				true,
			)

			expect(posture.effective.autoApprovalEnabled).toBe(true)
			expect(posture.summary).toBe(
				"from config (autoApprovalEnabled=true, execute gated, 1 key from .shofer config)",
			)
		})

		it("honours a config layer read from disk on a served (non-interactive) node", async () => {
			const global = await makeScope({ autoApprovalEnabled: false, alwaysAllowExecute: false })

			const posture = await resolveApprovalPosture({ nonInteractive: true, roots: { global } })

			expect(posture.configuredKeys).toEqual(["autoApprovalEnabled", "alwaysAllowExecute"])
			expect(posture.seed).not.toHaveProperty("autoApprovalEnabled")
			expect(posture.seed).not.toHaveProperty("alwaysAllowExecute")
			expect(posture.effective.autoApprovalEnabled).toBe(false)
			expect(posture.summary).toContain("from config")
		})

		it("can also turn approvals ON for an --interactive node (config is not one-directional)", async () => {
			const global = await makeScope({ autoApprovalEnabled: true, alwaysAllowReadOnly: true })

			const posture = await resolveApprovalPosture({ nonInteractive: false, roots: { global } })

			expect(posture.configuredKeys).toEqual(["autoApprovalEnabled", "alwaysAllowReadOnly"])
			expect(posture.seed).toEqual({})
			expect(posture.effective.autoApprovalEnabled).toBe(true)
		})
	})

	describe("scope precedence is the platform's, not this module's", () => {
		it("a more-specific scope overrides a less-specific one when unlocked", async () => {
			const global = await makeScope({ autoApprovalEnabled: true })
			const project = await makeScope({ autoApprovalEnabled: false })

			const posture = await resolveApprovalPosture({ nonInteractive: true, roots: { global, project } })

			expect(posture.effective.autoApprovalEnabled).toBe(false)
		})

		it("a globally locked key inverts that — the global value is final", async () => {
			const global = await makeScope({ autoApprovalEnabled: false })
			await fs.writeFile(
				path.join(global, "locked.json"),
				JSON.stringify({ version: 1, locked: ["autoApprovalEnabled"] }),
				"utf8",
			)
			const project = await makeScope({ autoApprovalEnabled: true })

			const posture = await resolveApprovalPosture({ nonInteractive: true, roots: { global, project } })

			expect(posture.effective.autoApprovalEnabled).toBe(false)
		})
	})

	describe("fail-open to the seed", () => {
		it("treats an unreadable scope root as a config that says nothing", async () => {
			const posture = await resolveApprovalPosture({
				nonInteractive: true,
				roots: { global: path.join(os.tmpdir(), "shofer-posture-does-not-exist", ".shofer") },
			})

			expect(posture.configuredKeys).toEqual([])
			expect(posture.seed).toEqual(defaultApprovalSeed(true))
		})

		it("ignores a scope file that is not valid JSON", async () => {
			const global = await makeScope()
			await fs.writeFile(path.join(global, "settings.json"), "{ not json", "utf8")

			const posture = await resolveApprovalPosture({ nonInteractive: true, roots: { global } })

			expect(posture.configuredKeys).toEqual([])
			expect(posture.seed).toEqual(defaultApprovalSeed(true))
		})
	})

	describe("the posture key set", () => {
		it("covers every key the non-interactive seed sets", () => {
			for (const key of Object.keys(defaultApprovalSeed(true))) {
				expect(APPROVAL_POSTURE_KEYS).toContain(key)
			}
		})

		it("covers every key the interactive seed sets", () => {
			for (const key of Object.keys(defaultApprovalSeed(false))) {
				expect(APPROVAL_POSTURE_KEYS).toContain(key)
			}
		})

		// The seed is "auto-approve every declared capability", not "auto-approve
		// everything". `uncategorized` is the absence of a declaration, so seeding
		// it would approve exactly the tools nobody classified — bypassing a
		// posture that deliberately gates `write`, since a mutating tool whose
		// server declared no group lands there. A headless run that parks on such
		// a tool is fixed by CLASSIFYING the tool, never by widening this.
		it("never seeds the uncategorized group, however headless the node", () => {
			expect(defaultApprovalSeed(true)).not.toHaveProperty("alwaysAllowUncategorized")
			expect(defaultApprovalSeed(false)).not.toHaveProperty("alwaysAllowUncategorized")
		})

		// A key configuration may set must still be COUNTED as configured, or the
		// startup banner reports a node running from a file as one running the
		// flag's default — the exact misreading the summary exists to prevent.
		it("tracks the toggles it never seeds, so a configured value is still reported", () => {
			for (const key of ["alwaysAllowUncategorized", "alwaysAllowBrowser", "alwaysAllowFollowupQuestions"]) {
				expect(APPROVAL_POSTURE_KEYS).toContain(key)
			}
			const posture = applyConfiguredApprovalPosture(
				defaultApprovalSeed(true),
				{ alwaysAllowUncategorized: false },
				true,
			)
			expect(posture.configuredKeys).toContain("alwaysAllowUncategorized")
			expect(posture.effective.alwaysAllowUncategorized).toBe(false)
			// Never seeded, so there is nothing to strip and the seed is untouched.
			expect(posture.seed).toEqual(defaultApprovalSeed(true))
		})
	})

	describe("resolveCliScopeRoots", () => {
		it("derives the project scope from the workspace and the global scope from global storage", () => {
			const previous = process.env.SHOFER_GLOBAL_DIR
			delete process.env.SHOFER_GLOBAL_DIR
			try {
				const roots = resolveCliScopeRoots({
					globalStorageFsPath: path.join("/state", "global-storage"),
					workspacePath: "/work",
				})

				expect(roots.global).toBe(path.join("/state", "global-storage", ".shofer"))
				expect(roots.project).toBe(path.join("/work", ".shofer"))
				expect(roots.user).toBe(path.join(os.homedir(), ".shofer"))
			} finally {
				if (previous !== undefined) {
					process.env.SHOFER_GLOBAL_DIR = previous
				}
			}
		})

		it("lets SHOFER_GLOBAL_DIR name the global scope directly (the SaaS ConfigMap mount)", () => {
			const previous = process.env.SHOFER_GLOBAL_DIR
			process.env.SHOFER_GLOBAL_DIR = "/etc/shofer-config"
			try {
				const roots = resolveCliScopeRoots({ globalStorageFsPath: "/state/global-storage" })
				expect(roots.global).toBe("/etc/shofer-config")
			} finally {
				if (previous === undefined) {
					delete process.env.SHOFER_GLOBAL_DIR
				} else {
					process.env.SHOFER_GLOBAL_DIR = previous
				}
			}
		})
	})
})
