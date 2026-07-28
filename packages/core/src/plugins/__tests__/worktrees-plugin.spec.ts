import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

import {
	createInMemoryHost,
	EMBEDDED_WORKTREES_DIR,
	LEGACY_EMBEDDED_WORKTREES_DIR,
	type HostBridge,
} from "@shofer/types"

import { PluginManager, createNodePluginFs, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import { createNodePluginCodeLoader } from "../plugin-loader.js"

/**
 * Integration test for the first-party **Worktrees plugin** (`<repo>/plugins/worktrees`)
 * — the feature that used to be `src/core/webview/worktree/` plus eleven webview
 * handlers.
 *
 * It loads the *real* plugin off disk through the *real* {@link PluginManager} and asks
 * it the two questions core asks: the UI's requests, and — the load-bearing one —
 * `"resolve-task-cwd"`, the broadcast that decides where a task about to start runs.
 * That answer is what used to be `autoCreateWorktree` on the `newTask` IPC message, so a
 * regression here silently puts an agent on the user's current branch.
 *
 * Real git, real directories: the plugin's whole job is `git worktree`, and a mocked
 * `simple-git` would test the mock.
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../plugins/worktrees")
const PLUGINS_PARENT = path.dirname(PLUGIN_DIR)

class MemoryStore implements PluginStateStore {
	constructor(
		public names: string[] = [],
		public disabled: string[] = [],
	) {}
	getEnabledPlugins(): string[] {
		return [...this.names]
	}
	setEnabledPlugins(names: string[]): void {
		this.names = [...names]
	}
	getDisabledPlugins(): string[] {
		return [...this.disabled]
	}
	setDisabledPlugins(names: string[]): void {
		this.disabled = [...names]
	}
}

const tmpRoots: string[] = []

/** A repository with one commit — enough for `git worktree add` to have a base. */
function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-plugin-ws-"))
	tmpRoots.push(dir)
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
	git("init", "--initial-branch=main")
	git("config", "user.email", "test@example.com")
	git("config", "user.name", "Test")
	git("config", "commit.gpgsign", "false")
	fs.writeFileSync(path.join(dir, "README.md"), "hello\n")
	git("add", "README.md")
	git("commit", "-m", "initial")
	return dir
}

function makePlainDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-plugin-plain-"))
	tmpRoots.push(dir)
	return dir
}

interface Listing {
	worktrees: { path: string; branch: string; isCurrent: boolean }[]
	isGitRepo: boolean
	isMultiRoot: boolean
	isSubfolder: boolean
	gitRootPath: string
	error?: string
}

describe("Worktrees plugin (first-party, loaded off disk)", () => {
	let host: HostBridge

	beforeEach(() => {
		host = createInMemoryHost()
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	afterEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	afterAll(() => {
		for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
	})

	async function build(opts: { workspacePath: string; store?: PluginStateStore; workspaceFolders?: string[] }) {
		const storageBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-plugin-storage-"))
		tmpRoots.push(storageBaseDir)

		const manager = new PluginManager({
			fs: createNodePluginFs(),
			pluginDirs: [{ dir: PLUGINS_PARENT, scope: "bundled" }],
			stateStore: opts.store ?? new MemoryStore(),
			codeLoader: createNodePluginCodeLoader({ nodePaths: [path.join(process.cwd(), "node_modules")] }),
			host,
			workspacePath: opts.workspacePath,
			workspaceFolders: opts.workspaceFolders,
			storageBaseDir,
		})

		await manager.discover()
		await manager.activateCodePlugins()
		return { manager }
	}

	const call = <T>(method: string, params: unknown, cwd: string) =>
		pluginRegistry.request("worktrees", method, params, { cwd, workspacePath: cwd }) as Promise<T>

	/** What core asks at task creation: every plugin, first concrete answer wins. */
	const placement = async (cwd: string) => {
		const answers = await pluginRegistry.requestAll("resolve-task-cwd", undefined, { cwd, workspacePath: cwd })
		return answers[0] as { cwd?: string; error?: string } | undefined
	}

	it("is enabled out of the box (a shipped feature, not an opt-in add-on)", async () => {
		const { manager } = await build({ workspacePath: makeRepo() })
		expect(manager.isEnabled("worktrees")).toBe(true)
		expect(pluginRegistry.has("worktrees")).toBe(true)
	}, 30_000)

	it("stays off once the user disables it", async () => {
		const store = new MemoryStore([], ["worktrees"])
		const { manager } = await build({ workspacePath: makeRepo(), store })
		expect(manager.isEnabled("worktrees")).toBe(false)
		expect(pluginRegistry.has("worktrees")).toBe(false)
	}, 30_000)

	it("keeps the platform's own slash-command names (bundled scope)", async () => {
		const { manager } = await build({ workspacePath: makeRepo() })
		const contribution = manager.getContributedCommandDirs().find((c) => c.pluginName === "worktrees")
		expect(contribution?.unqualified).toBe(true)
		expect(fs.existsSync(path.join(PLUGIN_DIR, "commands", "merge-worktree.md"))).toBe(true)
	}, 30_000)

	it("lists the repository's worktrees", async () => {
		const cwd = makeRepo()
		await build({ workspacePath: cwd })

		const listing = await call<Listing>("list", undefined, cwd)
		expect(listing.isGitRepo).toBe(true)
		expect(listing.error).toBeUndefined()
		expect(listing.worktrees.some((w) => w.isCurrent)).toBe(true)
	}, 30_000)

	it("refuses a directory that is not a git repository", async () => {
		const cwd = makePlainDir()
		await build({ workspacePath: cwd })

		const listing = await call<Listing>("list", undefined, cwd)
		expect(listing).toMatchObject({ isGitRepo: false, error: "not-a-repo" })
	}, 30_000)

	it("refuses a multi-root window rather than guessing which repository is meant", async () => {
		const cwd = makeRepo()
		await build({ workspacePath: cwd, workspaceFolders: [cwd, makeRepo()] })

		const listing = await call<Listing>("list", undefined, cwd)
		expect(listing).toMatchObject({ isMultiRoot: true, error: "multi-root" })
	}, 30_000)

	it("creates a worktree under the embedded convention and gitignores the directory", async () => {
		const cwd = makeRepo()
		await build({ workspacePath: cwd })

		const { suggestedBranch, suggestedPath } = await call<{ suggestedBranch: string; suggestedPath: string }>(
			"defaults",
			undefined,
			cwd,
		)
		expect(suggestedPath.startsWith(path.join(cwd, EMBEDDED_WORKTREES_DIR))).toBe(true)

		const result = await call<{ success: boolean; message: string; worktree?: { path: string; branch: string } }>(
			"create",
			{ path: suggestedPath, branch: suggestedBranch, createNewBranch: true, initSubmodules: false },
			cwd,
		)
		expect(result.success).toBe(true)
		expect(result.worktree?.branch).toBe(suggestedBranch)
		expect(fs.existsSync(path.join(suggestedPath, "README.md"))).toBe(true)
		expect(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")).toContain(`${EMBEDDED_WORKTREES_DIR}/`)
	}, 60_000)

	it("forces a request that points outside the worktrees directory back inside it", async () => {
		const cwd = makeRepo()
		await build({ workspacePath: cwd })

		const result = await call<{ success: boolean; worktree?: { path: string } }>(
			"create",
			{ path: path.join(cwd, "..", "escapee"), branch: "escapee", createNewBranch: true, initSubmodules: false },
			cwd,
		)
		expect(result.success).toBe(true)
		expect(result.worktree?.path).toBe(path.join(cwd, EMBEDDED_WORKTREES_DIR, "escapee"))
	}, 60_000)

	// Transition shim: worktrees created before the move live under `.shofer/worktrees/`.
	// Nothing creates them there any more, but leaving them unlistable would orphan a
	// user's existing checkouts.
	it("still lists and deletes a worktree at the legacy .shofer/worktrees path", async () => {
		const cwd = makeRepo()
		await build({ workspacePath: cwd })

		const legacy = path.join(cwd, LEGACY_EMBEDDED_WORKTREES_DIR, "old-one")
		execFileSync("git", ["worktree", "add", "-b", "old-one", legacy], { cwd, stdio: "pipe" })

		const listing = await call<Listing>("list", undefined, cwd)
		expect(listing.worktrees.some((wt) => path.resolve(wt.path) === path.resolve(legacy))).toBe(true)

		const removed = await call<{ success: boolean; message: string }>("delete", { path: legacy }, cwd)
		expect(removed.success).toBe(true)
		expect(fs.existsSync(legacy)).toBe(false)
	}, 60_000)

	describe("where a new task runs (`resolve-task-cwd`)", () => {
		it("gives an unclaimed task its own fresh worktree", async () => {
			const cwd = makeRepo()
			await build({ workspacePath: cwd })

			const answer = await placement(cwd)
			expect(answer?.error).toBeUndefined()
			expect(answer?.cwd?.startsWith(path.join(cwd, EMBEDDED_WORKTREES_DIR))).toBe(true)
			expect(fs.existsSync(path.join(answer!.cwd!, "README.md"))).toBe(true)
		}, 60_000)

		it("honours the worktree the user picked, and consumes the pick", async () => {
			const cwd = makeRepo()
			await build({ workspacePath: cwd })
			const chosen = path.join(cwd, EMBEDDED_WORKTREES_DIR, "picked")
			await call("create", { path: chosen, branch: "picked", createNewBranch: true, initSubmodules: false }, cwd)

			await call("select", { cwd: chosen }, cwd)
			expect(await call("selection", undefined, cwd)).toEqual({ cwd: chosen, optedOut: false })

			expect((await placement(cwd))?.cwd).toBe(chosen)

			// One pick, one task: the next task falls back to the auto-create default rather
			// than silently reusing a checkout the user chose for the previous one.
			const next = await placement(cwd)
			expect(next?.cwd).not.toBe(chosen)
		}, 60_000)

		it("answers nothing when the user explicitly chose the current branch", async () => {
			const cwd = makeRepo()
			await build({ workspacePath: cwd })

			await call("select", { cwd: null }, cwd)
			expect(await call("selection", undefined, cwd)).toEqual({ cwd: undefined, optedOut: true })
			expect(await placement(cwd)).toBeUndefined()
		}, 30_000)

		it("answers nothing outside a git repository — there is nothing to branch from", async () => {
			const cwd = makePlainDir()
			await build({ workspacePath: cwd })
			expect(await placement(cwd)).toBeUndefined()
		}, 30_000)
	})
})
