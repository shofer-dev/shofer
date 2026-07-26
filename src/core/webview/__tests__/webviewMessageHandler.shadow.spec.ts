import { describe, it, expect, vi, beforeEach } from "vitest"

import { createInMemoryHost, setHost } from "@shofer/types"
import { t } from "@shofer/core"

import { webviewMessageHandler } from "../webviewMessageHandler"

/**
 * Shofer Nodes L3 — reverse data channel. When a remote (shadow) task is focused,
 * the changed-files webview handlers must route to the owning executor via
 * `provider.nodeRegistry`, NOT drive a local Task. (Plugin-owned features route the
 * same way, through `ShoferProvider`'s plugin-request routing — see
 * `pluginUiRequestRouting.spec.ts`.)
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
		pluginRequest: vi.fn(async () => ({})),
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

	// ── changed files ──────────────────────────────────────────────────────────

	it("changedFiles/get fetches the shadow panel (never the local push path)", async () => {
		await webviewMessageHandler(provider, { type: "changedFiles/get" } as any)
		expect(nodeRegistry.fetchShadowChangedFiles).toHaveBeenCalledWith("r1-task-1")
		expect(provider.pushChangedFilesUpdate).not.toHaveBeenCalled()
	})

	it("changedFiles/showDiff builds the diff from the executor's base/final contents", async () => {
		await webviewMessageHandler(provider, { type: "changedFiles/showDiff", text: "a.ts" } as any)
		expect(nodeRegistry.getChangedFileDiff).toHaveBeenCalledWith("r1-task-1", "a.ts")
		expect(executeCommand).toHaveBeenCalledWith(
			"vscode.diff",
			expect.anything(),
			expect.anything(),
			expect.any(String),
		)
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
