import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest"
import { execFileSync } from "child_process"
import fs from "fs"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

import {
	createInMemoryHost,
	EMBEDDED_WORKTREES_DIR,
	LEGACY_EMBEDDED_WORKTREES_DIR,
	type HostBridge,
	type PluginMarker,
	type PluginMarkerInput,
} from "@shofer/types"

import { PluginManager, createNodePluginFs, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import { createNodePluginCodeLoader } from "../plugin-loader.js"
import { packPluginToFile, unpackPlugin, PLUGIN_ARCHIVE_EXTENSION } from "../plugin-pack.js"
import type { PluginTaskProvider } from "../plugin-task.js"

/**
 * Integration test for the first-party **Basics plugin** (`<repo>/plugins/basics`) —
 * the three workspace features (checkpoints, file-changes, worktrees) that used to
 * live in core, merged into one plugin.
 *
 * It discovers and loads the *real* plugin off disk through the *real*
 * {@link PluginManager} with the task/editor seams wired, then drives the seams each
 * feature depends on end-to-end: the pre-tool snapshot and its restorable marker, the
 * two file-edit hooks and the change list, the worktree operations and — the
 * load-bearing one — the `"resolve-task-cwd"` broadcast that decides where a task
 * runs. Failing here means the merge is broken in a way the plugin's own unit tests
 * cannot see — they stub the host; this one uses it.
 *
 * Real git, real directories: two of the features' whole job is git, and a mocked
 * `simple-git` would test the mock.
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../plugins/basics")

/**
 * A parent directory containing ONLY the basics plugin (as a symlink), so the
 * manager discovers and activates exactly the plugin under test. Pointing
 * `pluginDirs` at the real `plugins/` parent made every `build()` bundle and
 * activate the OTHER code plugins too — measured: live-memory 4.3s +
 * rag-indexing 3.5s + second-brain 3.4s of cold esbuild on top of basics' own
 * 5.2s, all serial, all inside whichever test ran first with a cold bundle
 * cache (the cache is keyed on the plugin's source-tree mtimes, so any source
 * touch re-colds it). Under a saturated worker pool that first test blew its
 * 30s budget.
 *
 * The path is STABLE (not mkdtemp) on purpose: the bundle cache hashes the
 * entry path, so a fresh parent per run would defeat the cross-run cache.
 */
const PLUGINS_PARENT = path.join(os.tmpdir(), "shofer-basics-spec-plugins")
fs.mkdirSync(PLUGINS_PARENT, { recursive: true })
const basicsLink = path.join(PLUGINS_PARENT, "basics")
fs.rmSync(basicsLink, { force: true })
fs.symlinkSync(PLUGIN_DIR, basicsLink)

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

/** Records what the plugin writes to the timeline, and serves it back. */
function makeTaskProvider() {
	const markers: PluginMarker[] = []
	const rewinds: number[] = []
	let ts = 1000
	const provider: PluginTaskProvider = {
		marker: async (pluginName: string, input: PluginMarkerInput) => {
			markers.push({ ...input, ts: (ts += 10), pluginName })
		},
		listMarkers: async (pluginName: string) => markers.filter((m) => m.pluginName === pluginName),
		rewind: async (_pluginName: string, at: number) => {
			rewinds.push(at)
		},
		setCwd: async () => {},
		openTask: async () => "task-1",
	}
	return { provider, markers, rewinds }
}

interface ChangedFilesPayload {
	taskId: string
	entries: { path: string; insertions: number; deletions: number; state: string; hasOriginalContent: boolean }[]
}

interface Listing {
	worktrees: { path: string; branch: string; isCurrent: boolean }[]
	isGitRepo: boolean
	isMultiRoot: boolean
	isSubfolder: boolean
	gitRootPath: string
	error?: string
}

const tmpRoots: string[] = []

function makeWorkspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basics-plugin-ws-"))
	tmpRoots.push(dir)
	fs.writeFileSync(path.join(dir, "file.txt"), "original\n")
	return dir
}

/** A repository with one commit — enough for `git worktree add` to have a base. */
function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basics-plugin-repo-"))
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basics-plugin-plain-"))
	tmpRoots.push(dir)
	return dir
}

describe("Basics plugin (first-party, loaded off disk)", () => {
	let host: HostBridge

	beforeEach(() => {
		host = createInMemoryHost()
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	afterEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
		delete process.env.SHOFER_DISABLED_PLUGINS
	})

	afterAll(() => {
		for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
	})

	async function build(opts: { workspacePath: string; store?: PluginStateStore; workspaceFolders?: string[] }) {
		const storageBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "basics-plugin-storage-"))
		tmpRoots.push(storageBaseDir)
		const task = makeTaskProvider()

		const manager = new PluginManager({
			fs: createNodePluginFs(),
			pluginDirs: [{ dir: PLUGINS_PARENT, scope: "bundled" }],
			stateStore: opts.store ?? new MemoryStore(),
			codeLoader: createNodePluginCodeLoader({ nodePaths: [path.join(process.cwd(), "node_modules")] }),
			host,
			workspacePath: opts.workspacePath,
			workspaceFolders: opts.workspaceFolders,
			storageBaseDir,
			taskProvider: task.provider,
		})

		await manager.discover()
		await manager.activateCodePlugins()
		return { manager, storageBaseDir, ...task }
	}

	/**
	 * Pay basics' one cold esbuild bundle (~5s idle, arbitrarily worse under a
	 * saturated worker pool) HERE, under an explicit budget, instead of inside
	 * whichever test happens to run first. Every test's own `build()` then hits
	 * the warm content-addressed cache in milliseconds. The registry state this
	 * leaves behind is torn down by the first `beforeEach` like any test's.
	 */
	beforeAll(async () => {
		host = createInMemoryHost()
		await build({ workspacePath: makeWorkspace() })
	}, 120_000)

	const request = <T>(method: string, params: unknown, cwd: string) =>
		pluginRegistry.request("basics", method, params, { cwd, workspacePath: cwd }) as Promise<T>

	/** Drive one agent edit exactly as `FileContextTracker` does. */
	async function agentEdit(taskId: string, cwd: string, relPath: string, next: string | undefined) {
		const abs = path.join(cwd, relPath)
		const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined
		await pluginRegistry.applyBeforeFileEdit({ path: relPath, before }, { taskId, cwd })
		if (next === undefined) fs.rmSync(abs, { force: true })
		else fs.writeFileSync(abs, next)
		await pluginRegistry.applyAfterFileEdit({ path: relPath }, { taskId, cwd })
	}

	const list = (taskId: string, cwd: string) =>
		pluginRegistry.request("basics", "file-changes:get", undefined, { taskId, cwd }) as Promise<ChangedFilesPayload>

	/** What core asks at task creation: every plugin, first concrete answer wins. */
	const placement = async (cwd: string) => {
		const answers = await pluginRegistry.requestAll("resolve-task-cwd", undefined, { cwd, workspacePath: cwd })
		return answers[0] as { cwd?: string; error?: string } | undefined
	}

	it("is enabled out of the box (a shipped feature set, not an opt-in add-on)", async () => {
		const { manager } = await build({ workspacePath: makeWorkspace() })
		expect(manager.isEnabled("basics")).toBe(true)
		expect(pluginRegistry.has("basics")).toBe(true)
	})

	it("stays off once the user disables it", async () => {
		const store = new MemoryStore([], ["basics"])
		const { manager } = await build({ workspacePath: makeWorkspace(), store })
		expect(manager.isEnabled("basics")).toBe(false)
		expect(pluginRegistry.has("basics")).toBe(false)
	})

	it("reports the effective feature map over the `features` request", async () => {
		const cwd = makeWorkspace()
		await build({ workspacePath: cwd })
		expect(await request("features", undefined, cwd)).toEqual({
			checkpoints: true,
			"file-changes": true,
			worktrees: true,
		})
	})

	it("packs to a .shofer-plugin archive that round-trips (a single distributable file)", async () => {
		const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "basics-pack-"))
		tmpRoots.push(outDir)
		const archive = path.join(outDir, `basics${PLUGIN_ARCHIVE_EXTENSION}`)
		await packPluginToFile(PLUGIN_DIR, archive)

		const installed = await unpackPlugin(archive, path.join(outDir, "unpacked"))
		expect(installed.name).toBe("basics")
		// The UI bundles + vendored deps travel with it, so the archive is
		// self-contained: no build step and no `npm install` on the installing machine.
		expect(fs.existsSync(path.join(installed.dir, "plugin.json"))).toBe(true)
		expect(fs.existsSync(path.join(installed.dir, "ui", "row.js"))).toBe(true)
		expect(fs.existsSync(path.join(installed.dir, "ui", "indicator.js"))).toBe(true)
		expect(fs.existsSync(path.join(installed.dir, "src", "vendor", "simple-git.mjs"))).toBe(true)
	})

	describe("checkpoints feature", () => {
		it("snapshots before a file-mutating tool and restores the workspace from the marker", async () => {
			const workspacePath = makeWorkspace()
			const { markers, rewinds } = await build({ workspacePath })

			const gate = await pluginRegistry.applyBeforeToolCall(
				"write_to_file",
				{ path: "file.txt" },
				{ taskId: "task-1", cwd: workspacePath, turn: 0 },
			)
			expect(gate.allow).toBe(true)

			// The snapshot became a restorable row on the task's timeline.
			expect(markers).toHaveLength(1)
			expect(markers[0]).toMatchObject({ pluginName: "basics", kind: "checkpoint", restorable: true })

			// The agent's edit, then a restore back to that marker.
			fs.writeFileSync(path.join(workspacePath, "file.txt"), "agent edit")
			const result = (await pluginRegistry.request(
				"basics",
				"checkpoints:restore",
				{ ts: markers[0]!.ts, commitHash: markers[0]!.text, mode: "restore" },
				{ taskId: "task-1", cwd: workspacePath },
			)) as { rewound: boolean }

			expect(fs.readFileSync(path.join(workspacePath, "file.txt"), "utf8")).toBe("original\n")
			expect(result.rewound).toBe(true)
			expect(rewinds).toEqual([markers[0]!.ts])
		})

		it("takes no snapshot for a tool that cannot change files", async () => {
			const workspacePath = makeWorkspace()
			const { markers } = await build({ workspacePath })

			await pluginRegistry.applyBeforeToolCall("read_file", {}, { taskId: "task-1", cwd: workspacePath, turn: 0 })
			expect(markers).toHaveLength(0)
		})

		it("takes no snapshot when the feature is suppressed via governance", async () => {
			process.env.SHOFER_DISABLED_PLUGINS = "basics:checkpoints"
			const workspacePath = makeWorkspace()
			const { markers } = await build({ workspacePath })

			await pluginRegistry.applyBeforeToolCall(
				"write_to_file",
				{ path: "file.txt" },
				{ taskId: "task-1", cwd: workspacePath, turn: 0 },
			)
			expect(markers).toHaveLength(0)
			expect(await request("features", undefined, workspacePath)).toMatchObject({ checkpoints: false })
			await expect(request("checkpoints:list", undefined, workspacePath)).rejects.toThrow(/disabled/)
		})
	})

	describe("file-changes feature", () => {
		it("turns the two edit hooks into a change list", async () => {
			const cwd = makeWorkspace()
			await build({ workspacePath: cwd })

			await agentEdit("task-1", cwd, "file.txt", "original\nadded\n")

			const payload = await list("task-1", cwd)
			expect(payload.entries).toEqual([
				expect.objectContaining({ path: "file.txt", insertions: 1, deletions: 0, state: "modified" }),
			])
		})

		it("reverts a file back to what it was before the task touched it", async () => {
			const cwd = makeWorkspace()
			await build({ workspacePath: cwd })
			await agentEdit("task-1", cwd, "file.txt", "agent's version\n")

			const result = (await pluginRegistry.request(
				"basics",
				"file-changes:revert",
				{ path: "file.txt", confirmed: true },
				{ taskId: "task-1", cwd },
			)) as { reverted: boolean }

			expect(result.reverted).toBe(true)
			expect(fs.readFileSync(path.join(cwd, "file.txt"), "utf8")).toBe("original\n")
			expect((await list("task-1", cwd)).entries).toEqual([])
		})

		it("refuses to revert while the task is still writing", async () => {
			const cwd = makeWorkspace()
			await build({ workspacePath: cwd })
			await agentEdit("task-1", cwd, "file.txt", "mid-turn\n")

			await expect(
				pluginRegistry.request(
					"basics",
					"file-changes:revert",
					{ path: "file.txt", confirmed: true },
					{ taskId: "task-1", cwd, taskStreaming: true },
				),
			).rejects.toThrow(/Pause or cancel/)
			expect(fs.readFileSync(path.join(cwd, "file.txt"), "utf8")).toBe("mid-turn\n")
		})

		it("answers the `task-stats` question core asks every plugin on completion", async () => {
			const cwd = makeWorkspace()
			await build({ workspacePath: cwd })
			await agentEdit("task-1", cwd, "file.txt", "original\none\ntwo\n")

			const answers = await pluginRegistry.requestAll("task-stats", undefined, { taskId: "task-1", cwd })
			expect(answers).toEqual([{ insertions: 2, deletions: 0 }])
		})

		it("keeps two tasks' change lists apart in one workspace", async () => {
			const cwd = makeWorkspace()
			await build({ workspacePath: cwd })

			await agentEdit("task-1", cwd, "file.txt", "original\nfrom task one\n")
			await agentEdit("task-2", cwd, "file.txt", "original\nfrom task one\nfrom task two\n")

			// Task 2's baseline is what it found — including task 1's line — so each list
			// reports only its own work.
			expect((await list("task-1", cwd)).entries).toEqual([
				expect.objectContaining({ path: "file.txt", insertions: 1 }),
			])
			expect((await list("task-2", cwd)).entries).toEqual([
				expect.objectContaining({ path: "file.txt", insertions: 1 }),
			])
		})

		it("removes a deleted task's snapshots rather than leaving them in storage", async () => {
			const cwd = makeWorkspace()
			const { storageBaseDir } = await build({ workspacePath: cwd })
			await agentEdit("task-1", cwd, "file.txt", "changed\n")

			// Feature-scoped below the plugin's storage dir — the features share one.
			const taskDir = path.join(storageBaseDir, "basics", "file-changes", "tasks", "task-1")
			expect(fs.existsSync(taskDir)).toBe(true)

			await pluginRegistry.notifyTaskDeleted({ taskId: "task-1", workspacePath: cwd }, { cwd })
			await new Promise((resolve) => setTimeout(resolve, 50))

			expect(fs.existsSync(taskDir)).toBe(false)
		})

		it("contributes the get_changed_files tool, reporting the same list", async () => {
			const cwd = makeWorkspace()
			await build({ workspacePath: cwd })
			await agentEdit("task-1", cwd, "file.txt", "original\nadded\n")

			const tools = await pluginRegistry.collectTools({ taskId: "task-1", cwd })
			const tool = tools.find((t) => t.name === "get_changed_files")
			expect(tool).toBeDefined()

			const output = await tool!.execute({}, { mode: "code", task: {} as never })
			expect(output).toContain("file.txt")
			expect(output).toContain("+1")
		})

		it("does nothing at all when the feature is suppressed via governance", async () => {
			process.env.SHOFER_DISABLED_PLUGINS = "basics:file-changes"
			const cwd = makeWorkspace()
			const { storageBaseDir } = await build({ workspacePath: cwd })

			await agentEdit("task-1", cwd, "file.txt", "changed\n")

			// No hooks, no storage, and the tool is not in the catalog.
			expect(fs.existsSync(path.join(storageBaseDir, "basics", "file-changes"))).toBe(false)
			const tools = await pluginRegistry.collectTools({ taskId: "task-1", cwd })
			expect(tools.find((t) => t.name === "get_changed_files")).toBeUndefined()
			await expect(list("task-1", cwd)).rejects.toThrow(/disabled/)
			await fsp.rm(path.join(cwd, "file.txt"), { force: true })
		})
	})

	describe("worktrees feature", () => {
		it("keeps the platform's own slash-command names (bundled scope)", async () => {
			const { manager } = await build({ workspacePath: makeRepo() })
			const contribution = manager.getContributedCommandDirs().find((c) => c.pluginName === "basics")
			expect(contribution?.unqualified).toBe(true)
			expect(fs.existsSync(path.join(PLUGIN_DIR, "commands", "merge-worktree.md"))).toBe(true)
		})

		it("lists the repository's worktrees", async () => {
			const cwd = makeRepo()
			await build({ workspacePath: cwd })

			const listing = await request<Listing>("worktrees:list", undefined, cwd)
			expect(listing.isGitRepo).toBe(true)
			expect(listing.error).toBeUndefined()
			expect(listing.worktrees.some((w) => w.isCurrent)).toBe(true)
		})

		it("refuses a directory that is not a git repository", async () => {
			const cwd = makePlainDir()
			await build({ workspacePath: cwd })

			const listing = await request<Listing>("worktrees:list", undefined, cwd)
			expect(listing).toMatchObject({ isGitRepo: false, error: "not-a-repo" })
		})

		it("refuses a multi-root window rather than guessing which repository is meant", async () => {
			const cwd = makeRepo()
			await build({ workspacePath: cwd, workspaceFolders: [cwd, makeRepo()] })

			const listing = await request<Listing>("worktrees:list", undefined, cwd)
			expect(listing).toMatchObject({ isMultiRoot: true, error: "multi-root" })
		})

		it("creates a worktree under the embedded convention and gitignores the directory", async () => {
			const cwd = makeRepo()
			await build({ workspacePath: cwd })

			const { suggestedBranch, suggestedPath } = await request<{
				suggestedBranch: string
				suggestedPath: string
			}>("worktrees:defaults", undefined, cwd)
			expect(suggestedPath.startsWith(path.join(cwd, EMBEDDED_WORKTREES_DIR))).toBe(true)

			const result = await request<{
				success: boolean
				message: string
				worktree?: { path: string; branch: string }
			}>(
				"worktrees:create",
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

			const result = await request<{ success: boolean; worktree?: { path: string } }>(
				"worktrees:create",
				{
					path: path.join(cwd, "..", "escapee"),
					branch: "escapee",
					createNewBranch: true,
					initSubmodules: false,
				},
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

			const listing = await request<Listing>("worktrees:list", undefined, cwd)
			expect(listing.worktrees.some((wt) => path.resolve(wt.path) === path.resolve(legacy))).toBe(true)

			const removed = await request<{ success: boolean; message: string }>(
				"worktrees:delete",
				{ path: legacy },
				cwd,
			)
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
				await request(
					"worktrees:create",
					{ path: chosen, branch: "picked", createNewBranch: true, initSubmodules: false },
					cwd,
				)

				await request("worktrees:select", { cwd: chosen }, cwd)
				expect(await request("worktrees:selection", undefined, cwd)).toEqual({
					cwd: chosen,
					optedOut: false,
				})

				expect((await placement(cwd))?.cwd).toBe(chosen)

				// One pick, one task: the next task falls back to the auto-create default
				// rather than silently reusing a checkout the user chose for the previous one.
				const next = await placement(cwd)
				expect(next?.cwd).not.toBe(chosen)
			}, 60_000)

			it("answers nothing when the user explicitly chose the current branch", async () => {
				const cwd = makeRepo()
				await build({ workspacePath: cwd })

				await request("worktrees:select", { cwd: null }, cwd)
				expect(await request("worktrees:selection", undefined, cwd)).toEqual({
					cwd: undefined,
					optedOut: true,
				})
				expect(await placement(cwd)).toBeUndefined()
			})

			it("answers nothing outside a git repository — there is nothing to branch from", async () => {
				const cwd = makePlainDir()
				await build({ workspacePath: cwd })
				expect(await placement(cwd)).toBeUndefined()
			})

			it("answers nothing when the feature is suppressed via governance — the task runs in the workspace", async () => {
				process.env.SHOFER_DISABLED_PLUGINS = "basics:worktrees"
				const cwd = makeRepo()
				await build({ workspacePath: cwd })
				expect(await placement(cwd)).toBeUndefined()
				await expect(request("worktrees:list", undefined, cwd)).rejects.toThrow(/disabled/)
			})
		})
	})
})
