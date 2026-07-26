import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

import { createInMemoryHost, type HostBridge, type PluginMarker, type PluginMarkerInput } from "@shofer/types"

import { PluginManager, createNodePluginFs, type PluginStateStore } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import { createNodePluginCodeLoader } from "../plugin-loader.js"
import { packPluginToFile, unpackPlugin, PLUGIN_ARCHIVE_EXTENSION } from "../plugin-pack.js"
import type { PluginTaskProvider } from "../plugin-task.js"

/**
 * Integration test for the first-party **Checkpoints plugin**
 * (`<repo>/plugins/checkpoints`) — the feature that used to live in core.
 *
 * It discovers and loads the *real* plugin off disk through the *real*
 * {@link PluginManager} with the task/editor seams wired, then drives the seams the
 * feature depends on end-to-end: a snapshot taken before a file-mutating tool, the
 * timeline marker that snapshot produces, and the restore that puts the workspace
 * back. Failing here means the extraction is broken in a way the plugin's own unit
 * tests cannot see — they stub the host; this one uses it.
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../plugins/checkpoints")
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
	}
	return { provider, markers, rewinds }
}

const tmpRoots: string[] = []

function makeWorkspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoints-plugin-ws-"))
	tmpRoots.push(dir)
	fs.writeFileSync(path.join(dir, "file.txt"), "original")
	return dir
}

describe("Checkpoints plugin (first-party, loaded off disk)", () => {
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
		const storageBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoints-plugin-storage-"))
		tmpRoots.push(storageBaseDir)
		const task = makeTaskProvider()

		const manager = new PluginManager({
			fs: createNodePluginFs(),
			pluginDirs: [{ dir: PLUGINS_PARENT, scope: "bundled" }],
			stateStore: opts.store ?? new MemoryStore(),
			codeLoader: createNodePluginCodeLoader({ nodePaths: [path.join(process.cwd(), "node_modules")] }),
			host,
			workspacePath: opts.workspacePath,
			storageBaseDir,
			taskProvider: task.provider,
		})

		await manager.discover()
		await manager.activateCodePlugins()
		return { manager, ...task }
	}

	it("is enabled out of the box (a shipped feature, not an opt-in add-on)", async () => {
		const { manager } = await build({ workspacePath: makeWorkspace() })
		expect(manager.isEnabled("checkpoints")).toBe(true)
		expect(pluginRegistry.has("checkpoints")).toBe(true)
	})

	it("stays off once the user disables it", async () => {
		const store = new MemoryStore([], ["checkpoints"])
		const { manager } = await build({ workspacePath: makeWorkspace(), store })
		expect(manager.isEnabled("checkpoints")).toBe(false)
		expect(pluginRegistry.has("checkpoints")).toBe(false)
	})

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
		expect(markers[0]).toMatchObject({ pluginName: "checkpoints", kind: "checkpoint", restorable: true })

		// The agent's edit, then a restore back to that marker.
		fs.writeFileSync(path.join(workspacePath, "file.txt"), "agent edit")
		const result = (await pluginRegistry.request(
			"checkpoints",
			"restore",
			{ ts: markers[0]!.ts, commitHash: markers[0]!.text, mode: "restore" },
			{ taskId: "task-1", cwd: workspacePath },
		)) as { rewound: boolean }

		expect(fs.readFileSync(path.join(workspacePath, "file.txt"), "utf8")).toBe("original")
		expect(result.rewound).toBe(true)
		expect(rewinds).toEqual([markers[0]!.ts])
	}, 30_000)

	it("takes no snapshot for a tool that cannot change files", async () => {
		const workspacePath = makeWorkspace()
		const { markers } = await build({ workspacePath })

		await pluginRegistry.applyBeforeToolCall("read_file", {}, { taskId: "task-1", cwd: workspacePath, turn: 0 })
		expect(markers).toHaveLength(0)
	})

	it("packs to a .shofer-plugin archive that round-trips (a single distributable file)", async () => {
		const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoints-pack-"))
		tmpRoots.push(outDir)
		const archive = path.join(outDir, `checkpoints${PLUGIN_ARCHIVE_EXTENSION}`)
		await packPluginToFile(PLUGIN_DIR, archive)

		const installed = await unpackPlugin(archive, path.join(outDir, "unpacked"))
		expect(installed.name).toBe("checkpoints")
		// The built entry + UI bundle travel with it, so the archive is self-contained:
		// no build step and no `npm install` on the installing machine.
		expect(fs.existsSync(path.join(installed.dir, "plugin.json"))).toBe(true)
		expect(fs.existsSync(path.join(installed.dir, "main.js"))).toBe(true)
		expect(fs.existsSync(path.join(installed.dir, "ui", "row.js"))).toBe(true)
	})
})
