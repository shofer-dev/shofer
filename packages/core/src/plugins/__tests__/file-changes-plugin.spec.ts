import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import fs from "fs"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

import { createInMemoryHost, type HostBridge } from "@shofer/types"

import { PluginManager, createNodePluginFs, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import { createNodePluginCodeLoader } from "../plugin-loader.js"

/**
 * Integration test for the first-party **File Changes plugin**
 * (`<repo>/plugins/file-changes`) — the feature that used to live in core.
 *
 * It loads the *real* plugin off disk through the *real* {@link PluginManager} and
 * drives it the way core does: the two file-edit hooks in, the change list and the
 * revert/accept requests out. Failing here means the extraction is broken in a way the
 * plugin's own unit tests cannot see — they call the store directly; this one goes
 * through the hooks, the permission gate and the request surface.
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../plugins/file-changes")
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

interface ChangedFilesPayload {
	taskId: string
	entries: { path: string; insertions: number; deletions: number; state: string; hasOriginalContent: boolean }[]
}

const tmpRoots: string[] = []

function makeWorkspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-changes-plugin-ws-"))
	tmpRoots.push(dir)
	fs.writeFileSync(path.join(dir, "file.txt"), "original\n")
	return dir
}

describe("File Changes plugin (first-party, loaded off disk)", () => {
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

	async function build(opts: { workspacePath: string; store?: PluginStateStore }) {
		const storageBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-changes-plugin-storage-"))
		tmpRoots.push(storageBaseDir)

		const manager = new PluginManager({
			fs: createNodePluginFs(),
			pluginDirs: [{ dir: PLUGINS_PARENT, scope: "bundled" }],
			stateStore: opts.store ?? new MemoryStore(),
			codeLoader: createNodePluginCodeLoader({ nodePaths: [path.join(process.cwd(), "node_modules")] }),
			host,
			workspacePath: opts.workspacePath,
			storageBaseDir,
		})

		await manager.discover()
		await manager.activateCodePlugins()
		return { manager, storageBaseDir }
	}

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
		pluginRegistry.request("file-changes", "get", undefined, { taskId, cwd }) as Promise<ChangedFilesPayload>

	it("is enabled out of the box (a shipped feature, not an opt-in add-on)", async () => {
		const { manager } = await build({ workspacePath: makeWorkspace() })
		expect(manager.isEnabled("file-changes")).toBe(true)
		expect(pluginRegistry.has("file-changes")).toBe(true)
	}, 30_000)

	it("stays off once the user disables it", async () => {
		const store = new MemoryStore([], ["file-changes"])
		const { manager } = await build({ workspacePath: makeWorkspace(), store })
		expect(manager.isEnabled("file-changes")).toBe(false)
		expect(pluginRegistry.has("file-changes")).toBe(false)
	}, 30_000)

	it("turns the two edit hooks into a change list", async () => {
		const cwd = makeWorkspace()
		await build({ workspacePath: cwd })

		await agentEdit("task-1", cwd, "file.txt", "original\nadded\n")

		const payload = await list("task-1", cwd)
		expect(payload.entries).toEqual([
			expect.objectContaining({ path: "file.txt", insertions: 1, deletions: 0, state: "modified" }),
		])
	}, 30_000)

	it("reverts a file back to what it was before the task touched it", async () => {
		const cwd = makeWorkspace()
		await build({ workspacePath: cwd })
		await agentEdit("task-1", cwd, "file.txt", "agent's version\n")

		const result = (await pluginRegistry.request(
			"file-changes",
			"revert",
			{ path: "file.txt", confirmed: true },
			{ taskId: "task-1", cwd },
		)) as { reverted: boolean }

		expect(result.reverted).toBe(true)
		expect(fs.readFileSync(path.join(cwd, "file.txt"), "utf8")).toBe("original\n")
		expect((await list("task-1", cwd)).entries).toEqual([])
	}, 30_000)

	it("refuses to revert while the task is still writing", async () => {
		const cwd = makeWorkspace()
		await build({ workspacePath: cwd })
		await agentEdit("task-1", cwd, "file.txt", "mid-turn\n")

		await expect(
			pluginRegistry.request(
				"file-changes",
				"revert",
				{ path: "file.txt", confirmed: true },
				{ taskId: "task-1", cwd, taskStreaming: true },
			),
		).rejects.toThrow(/Pause or cancel/)
		expect(fs.readFileSync(path.join(cwd, "file.txt"), "utf8")).toBe("mid-turn\n")
	}, 30_000)

	it("answers the `task-stats` question core asks every plugin on completion", async () => {
		const cwd = makeWorkspace()
		await build({ workspacePath: cwd })
		await agentEdit("task-1", cwd, "file.txt", "original\none\ntwo\n")

		const answers = await pluginRegistry.requestAll("task-stats", undefined, { taskId: "task-1", cwd })
		expect(answers).toEqual([{ insertions: 2, deletions: 0 }])
	}, 30_000)

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
	}, 30_000)

	it("removes a deleted task's snapshots rather than leaving them in storage", async () => {
		const cwd = makeWorkspace()
		const { storageBaseDir } = await build({ workspacePath: cwd })
		await agentEdit("task-1", cwd, "file.txt", "changed\n")

		const taskDir = path.join(storageBaseDir, "file-changes", "tasks", "task-1")
		expect(fs.existsSync(taskDir)).toBe(true)

		await pluginRegistry.notifyTaskDeleted({ taskId: "task-1", workspacePath: cwd }, { cwd })
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(fs.existsSync(taskDir)).toBe(false)
	}, 30_000)

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
	}, 30_000)

	it("does nothing at all when the user disabled it", async () => {
		const cwd = makeWorkspace()
		const store = new MemoryStore([], ["file-changes"])
		const { storageBaseDir } = await build({ workspacePath: cwd, store })

		await agentEdit("task-1", cwd, "file.txt", "changed\n")

		// No hooks, no storage, and the tool is not in the catalog.
		expect(fs.existsSync(path.join(storageBaseDir, "file-changes"))).toBe(false)
		const tools = await pluginRegistry.collectTools({ taskId: "task-1", cwd })
		expect(tools.find((t) => t.name === "get_changed_files")).toBeUndefined()
		await expect(list("task-1", cwd)).rejects.toThrow()
		await fsp.rm(path.join(cwd, "file.txt"), { force: true })
	}, 30_000)
})
