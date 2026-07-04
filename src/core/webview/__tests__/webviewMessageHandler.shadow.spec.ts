import { describe, it, expect, vi, beforeEach } from "vitest"

import { createInMemoryHost, setHost } from "@shofer/types"
import { t } from "@shofer/core"

import { webviewMessageHandler } from "../webviewMessageHandler"

/**
 * Shofer Nodes L3 — reverse data channel. When a remote (shadow) task is focused,
 * the checkpoint diff/restore + changed-files webview handlers must route to the
 * owning executor via `provider.nodeRegistry`, NOT drive a local Task. These specs
 * exercise the shadow branches added in C5/C6.
 */

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn(async () => {}) }))

vi.mock("vscode", async (importOriginal) => {
	const actual: any = await importOriginal()
	return {
		...actual,
		Uri: { ...actual.Uri, parse: (s: string) => ({ scheme: "shofer-original", toString: () => s }) },
		commands: { ...actual.commands, executeCommand },
		window: { ...actual.window, showErrorMessage: vi.fn() },
		workspace: { ...actual.workspace, workspaceFolders: undefined },
	}
})

function makeNodeRegistry(shadowTaskId: string | undefined) {
	return {
		getFocusedShadow: vi.fn(() => (shadowTaskId ? { taskId: shadowTaskId } : undefined)),
		getCheckpointDiff: vi.fn(async () => [] as any[]),
		restoreCheckpoint: vi.fn(async () => {}),
		rebuildShadow: vi.fn(async () => {}),
		getChangedFileDiff: vi.fn(async () => ({ original: "base", final: "final" })),
		revertChangedFile: vi.fn(async () => {}),
		revertAllChangedFiles: vi.fn(async () => {}),
		acceptChangedFile: vi.fn(async () => {}),
		acceptAllChangedFiles: vi.fn(async () => {}),
		fetchShadowChangedFiles: vi.fn(async () => {}),
	}
}

describe("webviewMessageHandler — Shofer Nodes L3 shadow branches", () => {
	let host: ReturnType<typeof createInMemoryHost>
	let showMultiFileDiff: ReturnType<typeof vi.fn>
	let nodeRegistry: ReturnType<typeof makeNodeRegistry>
	let provider: any
	let activeManagedTasks: unknown[]

	function makeProvider() {
		activeManagedTasks = []
		nodeRegistry = makeNodeRegistry("r1-task-1")
		return {
			nodeRegistry,
			taskManager: { getActiveManagedTasks: vi.fn(() => activeManagedTasks) },
			getCurrentTask: vi.fn(() => undefined),
			pushChangedFilesUpdate: vi.fn(async () => {}),
			cancelTask: vi.fn(async () => {}),
			log: vi.fn(),
		}
	}

	beforeEach(() => {
		vi.clearAllMocks()
		host = createInMemoryHost()
		showMultiFileDiff = vi.fn(async () => {})
		host.editor.showMultiFileDiff = showMultiFileDiff as any
		host.notifier.info = vi.fn() as any
		host.notifier.warn = vi.fn() as any
		host.notifier.error = vi.fn() as any
		host.notifier.showChoice = vi.fn(async () => t("common:fileChanges.revertConfirmYes")) as any
		setHost(host)
		provider = makeProvider()
	})

	// ── checkpoint diff ──────────────────────────────────────────────────────────

	it("checkpointDiff fetches the diff from the executor and renders it locally", async () => {
		const changes = [{ paths: { relative: "a.ts", absolute: "/w/a.ts" }, content: { before: "x", after: "y" } }]
		nodeRegistry.getCheckpointDiff.mockResolvedValue(changes)
		await webviewMessageHandler(provider, {
			type: "checkpointDiff",
			payload: { commitHash: "c1", mode: "checkpoint" },
		} as any)
		expect(nodeRegistry.getCheckpointDiff).toHaveBeenCalledWith("r1-task-1", { commitHash: "c1", mode: "checkpoint" })
		expect(showMultiFileDiff).toHaveBeenCalledWith(expect.any(String), changes)
	})

	it("checkpointDiff surfaces a no-changes notice when the executor returns nothing", async () => {
		nodeRegistry.getCheckpointDiff.mockResolvedValue([])
		await webviewMessageHandler(provider, {
			type: "checkpointDiff",
			payload: { commitHash: "c1", mode: "to-current" },
		} as any)
		expect(host.notifier.info).toHaveBeenCalled()
		expect(showMultiFileDiff).not.toHaveBeenCalled()
	})

	// ── checkpoint restore ───────────────────────────────────────────────────────

	it("checkpointRestore restores on the executor then rebuilds the shadow", async () => {
		await webviewMessageHandler(provider, {
			type: "checkpointRestore",
			payload: { ts: 1, commitHash: "c1", mode: "restore" },
		} as any)
		expect(nodeRegistry.restoreCheckpoint).toHaveBeenCalledWith("r1-task-1", { ts: 1, commitHash: "c1", mode: "restore" })
		expect(nodeRegistry.rebuildShadow).toHaveBeenCalledWith("r1-task-1")
	})

	it("checkpointRestore is blocked when another task is active in the worktree", async () => {
		activeManagedTasks = [{ id: "local-1" }]
		await webviewMessageHandler(provider, {
			type: "checkpointRestore",
			payload: { ts: 1, commitHash: "c1", mode: "restore" },
		} as any)
		expect(host.notifier.warn).toHaveBeenCalled()
		expect(nodeRegistry.restoreCheckpoint).not.toHaveBeenCalled()
		expect(nodeRegistry.rebuildShadow).not.toHaveBeenCalled()
	})

	// ── changed files ──────────────────────────────────────────────────────────

	it("changedFiles/get fetches the shadow panel (never the local push path)", async () => {
		await webviewMessageHandler(provider, { type: "changedFiles/get" } as any)
		expect(nodeRegistry.fetchShadowChangedFiles).toHaveBeenCalledWith("r1-task-1")
		expect(provider.pushChangedFilesUpdate).not.toHaveBeenCalled()
	})

	it("changedFiles/showDiff builds the diff from the executor's base/final contents", async () => {
		await webviewMessageHandler(provider, { type: "changedFiles/showDiff", text: "a.ts" } as any)
		expect(nodeRegistry.getChangedFileDiff).toHaveBeenCalledWith("r1-task-1", "a.ts")
		expect(executeCommand).toHaveBeenCalledWith("vscode.diff", expect.anything(), expect.anything(), expect.any(String))
	})

	it("changedFiles/revert reverts on the executor then refreshes; blocks when a task is active", async () => {
		await webviewMessageHandler(provider, { type: "changedFiles/revert", text: "a.ts" } as any)
		expect(nodeRegistry.revertChangedFile).toHaveBeenCalledWith("r1-task-1", "a.ts")
		expect(nodeRegistry.fetchShadowChangedFiles).toHaveBeenCalledWith("r1-task-1")

		// A concurrent local task blocks the revert.
		vi.clearAllMocks()
		activeManagedTasks = [{ id: "local-1" }]
		await webviewMessageHandler(provider, { type: "changedFiles/revert", text: "a.ts" } as any)
		expect(host.notifier.warn).toHaveBeenCalled()
		expect(nodeRegistry.revertChangedFile).not.toHaveBeenCalled()
	})

	it("changedFiles/revertAll reverts all on the executor after confirmation", async () => {
		await webviewMessageHandler(provider, { type: "changedFiles/revertAll" } as any)
		expect(nodeRegistry.revertAllChangedFiles).toHaveBeenCalledWith("r1-task-1")
		expect(nodeRegistry.fetchShadowChangedFiles).toHaveBeenCalledWith("r1-task-1")
	})

	it("changedFiles/accept + acceptAll route to the executor (no active-task gate) then refresh", async () => {
		await webviewMessageHandler(provider, { type: "changedFiles/accept", text: "a.ts" } as any)
		expect(nodeRegistry.acceptChangedFile).toHaveBeenCalledWith("r1-task-1", "a.ts")

		await webviewMessageHandler(provider, { type: "changedFiles/acceptAll" } as any)
		expect(nodeRegistry.acceptAllChangedFiles).toHaveBeenCalledWith("r1-task-1")
		expect(nodeRegistry.fetchShadowChangedFiles).toHaveBeenCalledWith("r1-task-1")
	})

	it("falls through to the local path when no shadow is focused", async () => {
		nodeRegistry.getFocusedShadow.mockReturnValue(undefined)
		await webviewMessageHandler(provider, { type: "changedFiles/get" } as any)
		expect(nodeRegistry.fetchShadowChangedFiles).not.toHaveBeenCalled()
		expect(provider.pushChangedFilesUpdate).toHaveBeenCalled()
	})
})
