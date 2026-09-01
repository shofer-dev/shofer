// pnpm --filter @shofer/cli test src/agent/__tests__/approval-posture.test.ts

import fs from "fs/promises"
import os from "os"
import path from "path"

import { checkAutoApproval } from "@shofer/core"

import {
	APPROVAL_POSTURE_KEYS,
	applyConfiguredApprovalPosture,
	defaultApprovalSeed,
	resolveApprovalPosture,
	resolveCliScopeRoots,
	unattendedApprovalSeed,
} from "../approval-posture.js"

/**
 * Tests for the served/CLI node's approval-posture resolution.
 *
 * The load-bearing assertion is the FIRST group: an absent posture key DENIES.
 * A node whose configuration says nothing auto-approves nothing, and a key a
 * `.shofer/` scope does not name is not a decision the host may make on its
 * behalf. A regression there silently un-gates every deployed worker — an agent
 * spending someone's borrowed authority with no approval raised anywhere — and
 * shows up as a test failure nowhere else.
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
	describe("an absent key denies — the host seeds nothing ON", () => {
		it("seeds the master gate off and no toggle at all", () => {
			const posture = applyConfiguredApprovalPosture(defaultApprovalSeed(), {})

			expect(posture.configuredKeys).toEqual([])
			expect(posture.seed).toEqual({ autoApprovalEnabled: false })
			expect(posture.summary).toBe("ask (default — no posture configured)")
		})

		// The launch flag used to pick between two blobs. It no longer decides the
		// posture at all: only configuration does, so `defaultApprovalSeed` takes no
		// argument and there is exactly one default.
		it("never seeds a true value for any posture key", () => {
			for (const [key, value] of Object.entries(defaultApprovalSeed())) {
				expect({ key, value }).toEqual({ key, value: false })
			}
		})

		it("never seeds a command allowlist", () => {
			expect(defaultApprovalSeed()).not.toHaveProperty("allowedCommands")
		})

		it("an empty overlay is indistinguishable from no overlay", async () => {
			const emptyScope = await makeScope()
			const posture = await resolveApprovalPosture({ roots: { global: emptyScope } })

			expect(posture.configuredKeys).toEqual([])
			expect(posture.seed).toEqual(defaultApprovalSeed())
			expect(posture.summary).toBe("ask (default — no posture configured)")
		})
	})

	// The one grant with a stated author: a person asking for an unattended run
	// against their own workspace. It is passed by a command, never defaulted to,
	// which is what keeps `shofer serve` denying.
	describe("the unattended seed a local command may state for itself", () => {
		it("auto-approves every declared capability and every command", () => {
			expect(unattendedApprovalSeed()).toEqual({
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowReadOnlyOutsideWorkspace: true,
				alwaysAllowWrite: true,
				alwaysAllowWriteOutsideWorkspace: true,
				alwaysAllowWriteProtected: true,
				alwaysAllowGroups: { "*": true },
				alwaysAllowMcp: true,
				alwaysAllowModeSwitch: true,
				alwaysAllowSubtasks: true,
				alwaysAllowExecute: true,
				allowedCommands: ["*"],
			})
		})

		it("grants neither uncategorized nor the followup auto-answer", () => {
			expect(unattendedApprovalSeed()).not.toHaveProperty("alwaysAllowUncategorized")
			expect(unattendedApprovalSeed()).not.toHaveProperty("alwaysAllowFollowupQuestions")
		})

		it("is only a seed — a scope that gates a group still wins", async () => {
			const global = await makeScope({ alwaysAllowExecute: false })

			const posture = await resolveApprovalPosture({ roots: { global }, seed: unattendedApprovalSeed() })

			expect(posture.seed).not.toHaveProperty("alwaysAllowExecute")
			expect(posture.effective.alwaysAllowExecute).toBe(false)
			expect(posture.effective.alwaysAllowWrite).toBe(true)
		})

		it("covers only keys the posture set knows about", () => {
			for (const key of Object.keys(unattendedApprovalSeed())) {
				expect(APPROVAL_POSTURE_KEYS).toContain(key)
			}
		})
	})

	describe("configuration is the only thing that auto-approves", () => {
		it("omits a configured key from the seed instead of overriding it", () => {
			const posture = applyConfiguredApprovalPosture(defaultApprovalSeed(), {
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
			})

			// Omission is the mechanism: the overlay already wins in ContextProxy.getValue,
			// and seeding the key would write the host default through into the operator's
			// own settings.json.
			expect(posture.seed).not.toHaveProperty("autoApprovalEnabled")
			expect(posture.configuredKeys).toEqual(["autoApprovalEnabled", "alwaysAllowExecute"])
			expect(posture.effective.autoApprovalEnabled).toBe(true)
			expect(posture.effective.alwaysAllowExecute).toBe(true)

			// Posture keys the config says nothing about stay absent, hence denying.
			expect(posture.seed).not.toHaveProperty("alwaysAllowWrite")
			expect(posture.effective).not.toHaveProperty("alwaysAllowWrite")
			expect(posture.effective).not.toHaveProperty("allowedCommands")
		})

		it("reports the effective posture and says the source is config", () => {
			const posture = applyConfiguredApprovalPosture(defaultApprovalSeed(), {
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
			})

			expect(posture.summary).toBe(
				"from config (autoApprovalEnabled=true, execute auto-approved, 2 keys from .shofer config)",
			)
		})

		// A record is ONE key however many grants it carries, so a key count alone
		// would report "auto-approves every dynamic category" identically to
		// "auto-approves none". The summary names the categories instead.
		it("names the categories alwaysAllowGroups approves rather than counting the key", () => {
			const wildcard = applyConfiguredApprovalPosture(defaultApprovalSeed(), {
				autoApprovalEnabled: true,
				alwaysAllowGroups: { "*": true },
			})
			expect(wildcard.summary).toBe(
				"from config (autoApprovalEnabled=true, execute gated, alwaysAllowGroups{*}, 2 keys from .shofer config)",
			)

			const some = applyConfiguredApprovalPosture(defaultApprovalSeed(), {
				autoApprovalEnabled: true,
				alwaysAllowGroups: { salesforce: true, browser: false },
			})
			expect(some.summary).toBe(
				"from config (autoApprovalEnabled=true, execute gated, alwaysAllowGroups{salesforce}, 2 keys from .shofer config)",
			)

			// Declared and granting nothing is distinct from absent, which adds no fact.
			const none = applyConfiguredApprovalPosture(defaultApprovalSeed(), {
				autoApprovalEnabled: true,
				alwaysAllowGroups: {},
			})
			expect(none.summary).toContain("alwaysAllowGroups{}")
			expect(
				applyConfiguredApprovalPosture(defaultApprovalSeed(), { autoApprovalEnabled: true }).summary,
			).not.toContain("alwaysAllowGroups")
		})

		it("gates execute when the master toggle is on but alwaysAllowExecute is off", () => {
			const posture = applyConfiguredApprovalPosture(defaultApprovalSeed(), { autoApprovalEnabled: true })

			expect(posture.effective.autoApprovalEnabled).toBe(true)
			expect(posture.summary).toBe(
				"from config (autoApprovalEnabled=true, execute gated, 1 key from .shofer config)",
			)
		})

		it("honours a config layer read from disk on a served node", async () => {
			const global = await makeScope({ autoApprovalEnabled: true, alwaysAllowReadOnly: true })

			const posture = await resolveApprovalPosture({ roots: { global } })

			expect(posture.configuredKeys).toEqual(["autoApprovalEnabled", "alwaysAllowReadOnly"])
			expect(posture.seed).toEqual({})
			expect(posture.effective.autoApprovalEnabled).toBe(true)
			expect(posture.summary).toContain("from config")
		})

		it("lets a scope gate a node back off (config is not one-directional)", async () => {
			const global = await makeScope({ autoApprovalEnabled: false })

			const posture = await resolveApprovalPosture({ roots: { global } })

			expect(posture.configuredKeys).toEqual(["autoApprovalEnabled"])
			expect(posture.effective.autoApprovalEnabled).toBe(false)
		})
	})

	describe("scope precedence is the platform's, not this module's", () => {
		it("a more-specific scope overrides a less-specific one when unlocked", async () => {
			const global = await makeScope({ autoApprovalEnabled: true })
			const project = await makeScope({ autoApprovalEnabled: false })

			const posture = await resolveApprovalPosture({ roots: { global, project } })

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

			const posture = await resolveApprovalPosture({ roots: { global, project } })

			expect(posture.effective.autoApprovalEnabled).toBe(false)
		})
	})

	describe("an unreadable config falls back to the seed, which denies", () => {
		it("treats an unreadable scope root as a config that says nothing", async () => {
			const posture = await resolveApprovalPosture({
				roots: { global: path.join(os.tmpdir(), "shofer-posture-does-not-exist", ".shofer") },
			})

			expect(posture.configuredKeys).toEqual([])
			expect(posture.seed).toEqual(defaultApprovalSeed())
		})

		it("ignores a scope file that is not valid JSON", async () => {
			const global = await makeScope()
			await fs.writeFile(path.join(global, "settings.json"), "{ not json", "utf8")

			const posture = await resolveApprovalPosture({ roots: { global } })

			expect(posture.configuredKeys).toEqual([])
			expect(posture.seed).toEqual(defaultApprovalSeed())
		})
	})

	describe("the posture key set", () => {
		it("covers every key the seed sets", () => {
			for (const key of Object.keys(defaultApprovalSeed())) {
				expect(APPROVAL_POSTURE_KEYS).toContain(key)
			}
		})

		// The banner counts this list, so a key configuration may govern must appear
		// here even though the host never touches it — otherwise a node running from
		// a file is reported as one running the built-in default, the exact
		// misreading the summary exists to prevent.
		it("tracks the toggles the seed never mentions, so a configured value is still reported", () => {
			for (const key of ["alwaysAllowUncategorized", "alwaysAllowFollowupQuestions", "deniedCommands"]) {
				expect(APPROVAL_POSTURE_KEYS).toContain(key)
			}
			const posture = applyConfiguredApprovalPosture(defaultApprovalSeed(), {
				alwaysAllowUncategorized: true,
			})
			expect(posture.configuredKeys).toContain("alwaysAllowUncategorized")
			expect(posture.effective.alwaysAllowUncategorized).toBe(true)
			// Never seeded, so there is nothing to strip and the seed is untouched.
			expect(posture.seed).toEqual(defaultApprovalSeed())
		})
	})

	// The seed is only half the story: what matters is the DECISION a real ask
	// gets under it. These drive `checkAutoApproval` — the same function the
	// running host calls — with the posture each configuration resolves to, so a
	// change to either the seed or the gate table shows up here rather than in a pod.
	describe("what the resolved posture actually decides", () => {
		// A connected `browser-tools` server as McpHub pushes it to consumers: the
		// whole `browser_*` catalog resolves to the `browser` group, and the group
		// is the only thing the approval path looks at. `unclassified` stands for a
		// tool whose server declared no group at all.
		const mcpServers = [
			{
				name: "browser-tools",
				tools: [
					{ name: "browser_read_page", group: "read" },
					{ name: "browser_navigate", group: "browser" },
					{ name: "unclassified", group: "uncategorized" },
				],
			},
		] as never

		const call = (toolName: string) =>
			JSON.stringify({ type: "use_mcp_tool", serverName: "browser-tools", toolName })

		/** The effective posture of a node whose `.shofer/` config says what is passed. */
		const postureOf = (overlay: Record<string, unknown> = {}) => ({
			...applyConfiguredApprovalPosture(defaultApprovalSeed(), overlay).effective,
			mcpServers,
		})

		it("asks for every group when the config says nothing", async () => {
			for (const toolName of ["browser_read_page", "browser_navigate", "unclassified"]) {
				const result = await checkAutoApproval({
					state: postureOf() as never,
					ask: "use_mcp_server",
					text: call(toolName),
				})

				expect(result).toEqual({ decision: "ask" })
			}
		})

		it("auto-approves a group a scope explicitly allows", async () => {
			const result = await checkAutoApproval({
				state: postureOf({
					autoApprovalEnabled: true,
					alwaysAllowMcp: true,
					alwaysAllowReadOnly: true,
				}) as never,
				ask: "use_mcp_server",
				text: call("browser_read_page"),
			})

			expect(result).toEqual({ decision: "approve" })
		})

		// The single most likely mistake a posture author makes: declaring the
		// per-group toggles and forgetting the master gate. It approves nothing, and
		// that must be true rather than papered over by a seeded gate.
		it("approves nothing when the toggles are declared but the master gate is absent", async () => {
			const result = await checkAutoApproval({
				state: postureOf({ alwaysAllowMcp: true, alwaysAllowReadOnly: true }) as never,
				ask: "use_mcp_server",
				text: call("browser_read_page"),
			})

			expect(result).toEqual({ decision: "ask" })
		})

		// `browser` used to be seeded because its group holds no native tools, so an
		// unseeded toggle parked the first browser call of every headless run. It is
		// now exactly as explicit as the rest.
		it("still asks for browser under a read-only posture, and approves it once declared", async () => {
			const readOnly = postureOf({
				autoApprovalEnabled: true,
				alwaysAllowMcp: true,
				alwaysAllowReadOnly: true,
			})
			expect(
				await checkAutoApproval({
					state: readOnly as never,
					ask: "use_mcp_server",
					text: call("browser_navigate"),
				}),
			).toEqual({ decision: "ask" })

			const browsing = postureOf({
				autoApprovalEnabled: true,
				alwaysAllowMcp: true,
				alwaysAllowGroups: { browser: true },
			})
			expect(
				await checkAutoApproval({
					state: browsing as never,
					ask: "use_mcp_server",
					text: call("browser_navigate"),
				}),
			).toEqual({ decision: "approve" })
		})

		// The wildcard is the unattended seed's contract expressed for a vocabulary
		// nobody has met yet: a category minted mid-run by a server connecting has no
		// name anyone could have enumerated in advance.
		it("approves a dynamic category under the wildcard, and an explicit false beats it", async () => {
			const wildcard = postureOf({
				autoApprovalEnabled: true,
				alwaysAllowMcp: true,
				alwaysAllowGroups: { "*": true },
			})
			expect(
				await checkAutoApproval({
					state: wildcard as never,
					ask: "use_mcp_server",
					text: call("browser_navigate"),
				}),
			).toEqual({ decision: "approve" })

			const exception = postureOf({
				autoApprovalEnabled: true,
				alwaysAllowMcp: true,
				alwaysAllowGroups: { "*": true, browser: false },
			})
			expect(
				await checkAutoApproval({
					state: exception as never,
					ask: "use_mcp_server",
					text: call("browser_navigate"),
				}),
			).toEqual({ decision: "ask" })
		})

		// Containment: the wildcard covers the DYNAMIC categories only. `uncategorized`
		// is a builtin gated by its own flat toggle, so a tool whose server declared
		// nothing keeps asking even under the most permissive seed there is.
		it("does not let the wildcard reach an unclassified tool", async () => {
			const result = await checkAutoApproval({
				state: postureOf({
					autoApprovalEnabled: true,
					alwaysAllowMcp: true,
					alwaysAllowGroups: { "*": true },
				}) as never,
				ask: "use_mcp_server",
				text: call("unclassified"),
			})

			expect(result).toEqual({ decision: "ask" })
		})

		// Unchanged by the flip: neither was ever seeded, and `uncategorized` is the
		// absence of a declaration rather than a capability — a tool that parks a
		// headless run is fixed by CLASSIFYING it, never by widening this.
		it("keeps asking for an unclassified tool under a fully-declared read posture", async () => {
			const result = await checkAutoApproval({
				state: postureOf({
					autoApprovalEnabled: true,
					alwaysAllowMcp: true,
					alwaysAllowReadOnly: true,
					alwaysAllowGroups: { browser: true },
				}) as never,
				ask: "use_mcp_server",
				text: call("unclassified"),
			})

			expect(result).toEqual({ decision: "ask" })
		})

		it("asks a followup question rather than answering it, unless a scope says otherwise", async () => {
			const followup = JSON.stringify({ question: "which?", suggest: [{ answer: "this one" }] })

			expect(
				await checkAutoApproval({
					state: postureOf({ autoApprovalEnabled: true }) as never,
					ask: "followup",
					text: followup,
				}),
			).toEqual({ decision: "ask" })

			const answered = await checkAutoApproval({
				// `followupAutoApproveTimeoutMs` is a tuning value rather than a posture
				// key, so it is not in APPROVAL_POSTURE_KEYS and never rides the overlay.
				state: {
					...postureOf({ autoApprovalEnabled: true, alwaysAllowFollowupQuestions: true }),
					followupAutoApproveTimeoutMs: 1000,
				} as never,
				ask: "followup",
				text: followup,
			})
			expect(answered).toMatchObject({ decision: "timeout", timeout: 1000 })
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
