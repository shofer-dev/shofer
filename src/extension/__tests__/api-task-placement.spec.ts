import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"

import { pluginRegistry } from "@shofer/core"

import { API } from "../api"
import { ShoferProvider } from "../../core/webview/ShoferProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ShoferProvider")

/**
 * Task **placement** on the non-webview entry point.
 *
 * `ShoferAPI.startNewTask` is what a controller's AgentApi call, the CLI and the public
 * API all come through — including on a headless `shofer serve` executor, which has no
 * chat input to have asked the question in. A task created there must get the same
 * placement as one typed into the sidebar, or the bundled `worktrees` plugin would be a
 * webview-only feature: every remote agent would land on the executor's current branch.
 */
describe("ShoferAPI.startNewTask — plugin task placement", () => {
	let api: API
	let provider: ShoferProvider
	let createTask: ReturnType<typeof vi.fn>

	beforeEach(() => {
		createTask = vi.fn().mockResolvedValue({ taskId: "task-1" })
		provider = {
			context: {} as vscode.ExtensionContext,
			on: vi.fn(),
			cwd: "/test/workspace",
			removeShoferFromStack: vi.fn().mockResolvedValue(undefined),
			postInitState: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			createTask,
		} as unknown as ShoferProvider

		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, provider)
	})

	afterEach(async () => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	it("runs the task where a plugin places it", async () => {
		await pluginRegistry.register({
			name: "placer",
			handleRequest: async (method) =>
				method === "resolve-task-cwd" ? { cwd: "/test/workspace/.shofer/worktrees/shofer-ab12c" } : undefined,
		})

		await api.startNewTask({ text: "hello" })

		expect(createTask).toHaveBeenCalledTimes(1)
		expect(createTask.mock.calls[0]![5]).toBe("/test/workspace/.shofer/worktrees/shofer-ab12c")
	})

	it("runs it in the workspace when no plugin answers", async () => {
		await api.startNewTask({ text: "hello" })

		expect(createTask.mock.calls[0]![5]).toBeUndefined()
	})

	it("aborts creation when a plugin recognised the question and failed", async () => {
		await pluginRegistry.register({
			name: "placer",
			handleRequest: async (method) =>
				method === "resolve-task-cwd" ? { error: "worktree creation failed: disk full" } : undefined,
		})

		await expect(api.startNewTask({ text: "hello" })).rejects.toThrow(/disk full/)
		expect(createTask).not.toHaveBeenCalled()
	})
})
