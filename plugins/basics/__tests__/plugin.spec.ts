import fs from "fs/promises"
import os from "os"
import path from "path"

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { simpleGit } from "simple-git"

import plugin from "../src/main.js"
import { FILE_MUTATING_TOOLS, resolveDiffRange } from "../src/checkpoints/feature.js"
import { CheckpointServiceRegistry } from "../src/checkpoints/service-registry.js"

const tmpDir = path.join(os.tmpdir(), "CheckpointsPluginHooks")

/** A workspace with a real git repo and one committed file. */
async function makeWorkspace(name: string): Promise<string> {
	const dir = path.join(tmpDir, `${name}-${Date.now()}`)
	await fs.mkdir(dir, { recursive: true })
	const git = simpleGit(dir)
	await git.init()
	await git.addConfig("user.name", "Shofer")
	await git.addConfig("user.email", "noreply@example.com")
	await fs.writeFile(path.join(dir, "file.txt"), "original")
	await git.add(".")
	await git.commit("initial")
	return dir
}

/** A `PluginContext` with the capabilities the plugin actually uses, all recorded. */
function makeContext(workspacePath: string, storageDir: string) {
	const markers: {
		ts: number
		pluginName: string
		kind: string
		text: string
		restorable?: boolean
		suppress?: boolean
	}[] = []
	const rewinds: { ts: number; includeTargetMessage?: boolean }[] = []
	const shownDiffs: { title: string; changes: unknown[] }[] = []
	let ts = 1000

	const ctx = {
		workspacePath,
		cwd: workspacePath,
		taskId: "task-1",
		turn: 0,
		config: { checkpointInitTimeoutSeconds: 20 },
		storage: { dir: storageDir },
		host: {
			log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			editor: {
				showMultiFileDiff: async (title: string, changes: unknown[]) => {
					shownDiffs.push({ title, changes })
				},
			},
		},
		task: {
			marker: async (input: { kind: string; text: string; restorable?: boolean; suppress?: boolean }) => {
				markers.push({ ...input, ts: (ts += 10), pluginName: "basics" })
			},
			listMarkers: async () => markers,
			rewind: async (at: number, opts?: { includeTargetMessage?: boolean }) => {
				rewinds.push({ ts: at, includeTargetMessage: opts?.includeTargetMessage })
			},
		},
	}

	return { ctx, markers, rewinds, shownDiffs }
}

describe("basics plugin — checkpoints hooks", () => {
	let workspace: string
	let storage: string
	let harness: ReturnType<typeof makeContext>

	beforeEach(async () => {
		workspace = await makeWorkspace("ws")
		storage = path.join(tmpDir, `storage-${Date.now()}`)
		harness = makeContext(workspace, storage)
		// The plugin keeps module-level state; `initialize` rebinds it to this test's
		// context and drops everything derived from the previous one.
		plugin.initialize?.(harness.ctx as never)
	})

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	}, 60_000)

	it("snapshots before a file-mutating tool and appends a restorable marker", async () => {
		const result = await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, harness.ctx as never)
		expect(result).toEqual({ allow: true })

		expect(harness.markers).toHaveLength(1)
		expect(harness.markers[0]).toMatchObject({ kind: "checkpoint", restorable: true })
		expect(harness.markers[0]!.text).toMatch(/^[0-9a-f]{7,40}$/)
	})

	it("takes at most one snapshot per turn no matter how many tools run", async () => {
		const ctx = harness.ctx as never
		await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, ctx)
		await plugin.lifecycle!.beforeToolCall!("apply_diff", {}, ctx)
		await plugin.lifecycle!.beforeToolCall!("insert_edit", {}, ctx)
		expect(harness.markers).toHaveLength(1)

		// A new turn is a new step in the user's mental model, so it gets its own anchor.
		await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, { ...harness.ctx, turn: 1 } as never)
		expect(harness.markers).toHaveLength(2)
	})

	it("ignores tools that cannot change files", async () => {
		for (const tool of ["read_file", "rag_search", "ask_followup_question"]) {
			expect(FILE_MUTATING_TOOLS.has(tool)).toBe(false)
			await plugin.lifecycle!.beforeToolCall!(tool, {}, harness.ctx as never)
		}
		expect(harness.markers).toHaveLength(0)
	})

	it("anchors a user message with a suppressed marker", async () => {
		await plugin.lifecycle!.onUserMessage!({ taskId: "task-1", text: "do it" }, harness.ctx as never)
		expect(harness.markers).toHaveLength(1)
		expect(harness.markers[0]!.suppress).toBe(true)
	})

	it("restores files and rewinds the conversation for mode 'restore'", async () => {
		await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, harness.ctx as never)
		const marker = harness.markers[0]!

		// The agent's edit, after the snapshot.
		await fs.writeFile(path.join(workspace, "file.txt"), "agent edit")

		const result = (await plugin.handleRequest!(
			"checkpoints:restore",
			{ ts: marker.ts, commitHash: marker.text, mode: "restore" },
			harness.ctx as never,
		)) as { rewound: boolean }

		expect(await fs.readFile(path.join(workspace, "file.txt"), "utf8")).toBe("original")
		expect(result.rewound).toBe(true)
		expect(harness.rewinds).toEqual([{ ts: marker.ts, includeTargetMessage: false }])
	})

	it("restores files only for mode 'preview' — the conversation is left alone", async () => {
		await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, harness.ctx as never)
		const marker = harness.markers[0]!
		await fs.writeFile(path.join(workspace, "file.txt"), "agent edit")

		const result = (await plugin.handleRequest!(
			"checkpoints:restore",
			{ ts: marker.ts, commitHash: marker.text, mode: "preview" },
			harness.ctx as never,
		)) as { rewound: boolean }

		expect(await fs.readFile(path.join(workspace, "file.txt"), "utf8")).toBe("original")
		expect(result.rewound).toBe(false)
		expect(harness.rewinds).toEqual([])
	})

	it("computes a diff against the current workspace", async () => {
		await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, harness.ctx as never)
		const marker = harness.markers[0]!
		await fs.writeFile(path.join(workspace, "file.txt"), "agent edit")

		const result = (await plugin.handleRequest!(
			"checkpoints:diff",
			{ commitHash: marker.text, mode: "to-current" },
			harness.ctx as never,
		)) as {
			title?: string
			changes?: { paths: { relative: string }; content: { before: string; after: string } }[]
		}

		expect(result.changes?.map((c) => c.paths.relative)).toContain("file.txt")
		expect(result.changes?.find((c) => c.paths.relative === "file.txt")?.content).toEqual({
			before: "original",
			after: "agent edit",
		})
	})

	it("reports a notice rather than an empty diff when nothing changed", async () => {
		await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, harness.ctx as never)
		const marker = harness.markers[0]!

		const result = await plugin.handleRequest!(
			"checkpoints:diff",
			{ commitHash: marker.text, mode: "to-current" },
			harness.ctx as never,
		)
		expect(result).toEqual({ notice: "no-changes" })
	})

	it("renders a diff through the host editor for a local:show-diff request", async () => {
		await plugin.handleRequest!("local:checkpoints:show-diff", { title: "T", changes: [] }, harness.ctx as never)
		expect(harness.shownDiffs).toEqual([{ title: "T", changes: [] }])
	})

	it("rejects an unknown request method instead of answering undefined", async () => {
		await expect(plugin.handleRequest!("nope", {}, harness.ctx as never)).rejects.toThrow(/unknown request method/)
	})

	it("restores the workspace on a timeline rewind that asked for state", async () => {
		await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, harness.ctx as never)
		const marker = harness.markers[0]!
		await fs.writeFile(path.join(workspace, "file.txt"), "agent edit")

		await plugin.lifecycle!.onTimelineRewind!(
			{ ts: marker.ts - 5, taskId: "task-1", operation: "delete", restoreState: true },
			harness.ctx as never,
		)
		expect(await fs.readFile(path.join(workspace, "file.txt"), "utf8")).toBe("original")
	})

	it("leaves the workspace alone on a chat-only rewind", async () => {
		await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, harness.ctx as never)
		const marker = harness.markers[0]!
		await fs.writeFile(path.join(workspace, "file.txt"), "agent edit")

		await plugin.lifecycle!.onTimelineRewind!(
			{ ts: marker.ts - 5, taskId: "task-1", operation: "delete", restoreState: false },
			harness.ctx as never,
		)
		expect(await fs.readFile(path.join(workspace, "file.txt"), "utf8")).toBe("agent edit")
	})

	it("removes the task's shadow repository when the task is deleted", async () => {
		await plugin.lifecycle!.beforeToolCall!("write_to_file", {}, harness.ctx as never)
		// Scoped below the plugin storage: the Basics features share one storage dir.
		const repoDir = path.join(storage, "checkpoints", "tasks", "task-1")
		expect(await fs.stat(repoDir).then(() => true)).toBe(true)

		await plugin.lifecycle!.onTaskDeleted!({ taskId: "task-1" }, harness.ctx as never)
		await expect(fs.stat(repoDir)).rejects.toThrow()
	})
})

describe("basics plugin — checkpoint diff range resolution", () => {
	const hashes = ["aaa", "bbb", "ccc"]

	it("compares a checkpoint with the next one", () => {
		expect(resolveDiffRange(hashes, "bbb", "checkpoint")).toMatchObject({ from: "bbb", to: "ccc" })
	})

	it("leaves `to` open for the newest checkpoint so it diffs against the working tree", () => {
		expect(resolveDiffRange(hashes, "ccc", "checkpoint")).toMatchObject({ from: "ccc", to: undefined })
	})

	it("compares from the first checkpoint", () => {
		expect(resolveDiffRange(hashes, "ccc", "from-init")).toMatchObject({ from: "aaa", to: "ccc" })
		expect(resolveDiffRange(hashes, "ccc", "full")).toMatchObject({ from: "aaa", to: undefined })
	})

	it("reports no-first when the task has no checkpoints yet", () => {
		expect(resolveDiffRange([], "aaa", "from-init")).toEqual({ notice: "no-first" })
		expect(resolveDiffRange([], "aaa", "full")).toEqual({ notice: "no-first" })
	})
})

describe("CheckpointServiceRegistry", () => {
	it("gives up on a task loudly, once, and never retries it", async () => {
		const warn = vi.fn()
		const registry = new CheckpointServiceRegistry({
			storageDir: path.join(tmpDir, `reg-${Date.now()}`),
			initTimeoutMs: 5000,
			extraExcludePatterns: [],
			log: () => {},
			warn,
			onCheckpoint: () => {},
		})

		registry.disable("t1", "git is not installed")
		registry.disable("t1", "something else")
		expect(warn).toHaveBeenCalledTimes(1)
		expect(registry.isDisabled("t1")).toBe(true)
		expect(await registry.get({ taskId: "t1", workspaceDir: "/tmp/whatever" })).toBeUndefined()
	})

	it("disables a task with no workspace rather than snapshotting the wrong tree", async () => {
		const registry = new CheckpointServiceRegistry({
			storageDir: path.join(tmpDir, `reg2-${Date.now()}`),
			initTimeoutMs: 5000,
			extraExcludePatterns: [],
			log: () => {},
			warn: () => {},
			onCheckpoint: () => {},
		})
		expect(await registry.get({ taskId: "t1", workspaceDir: "" })).toBeUndefined()
		expect(registry.isDisabled("t1")).toBe(true)
	})
})
