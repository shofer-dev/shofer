import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ShoferProvider } from "../../core/webview/ShoferProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ShoferProvider")
vi.mock("../../utils/logging", () => ({
	getRecentLogs: vi.fn(() => "2026-01-01 INFO  log line 1\n2026-01-01 WARN  log line 2"),
	getLogLevel: vi.fn(() => "info"),
	getLogKnownCategories: vi.fn(() => ["Task", "Webview"]),
}))

describe("API — new ShoferAPI methods", () => {
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: ShoferProvider

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			viewLaunched: true,
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getValues: vi.fn(() => ({})),
			getProviderProfileEntries: vi.fn(() => []),
			getProviderProfileEntry: vi.fn(),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				saveConfig: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: "/test/workspace",
			taskHistoryStore: {
				getAll: vi.fn(() => []),
				get: vi.fn(),
				upsert: vi.fn(),
				delete: vi.fn(),
				deleteMany: vi.fn(),
				initialized: Promise.resolve(),
			},
			taskManager: {
				renameManagedTask: vi.fn(),
				registerBackgroundTask: vi.fn(),
				focusTask: vi.fn().mockResolvedValue(undefined),
			},
			getTaskWithId: vi.fn().mockRejectedValue(new Error("Task not found")),
			showTaskWithId: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			renameManagedTask: vi.fn(),
			archiveManagedTask: vi.fn().mockResolvedValue(undefined),
			unarchiveManagedTask: vi.fn().mockResolvedValue(undefined),
			pinManagedTask: vi.fn().mockResolvedValue(undefined),
			unpinManagedTask: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			popFromStackWithoutAborting: vi.fn().mockReturnValue(undefined),
			addShoferToStack: vi.fn().mockResolvedValue(undefined),
			getProviderProfileEntry: vi.fn(),
			activateProviderProfile: vi.fn().mockResolvedValue(undefined),
			deleteProviderProfile: vi.fn().mockResolvedValue(undefined),
			upsertProviderProfile: vi.fn().mockResolvedValue("profile-id"),
			getManagedTasks: vi.fn(() => []),
			removeShoferFromStack: vi.fn().mockResolvedValue(undefined),
		} as unknown as ShoferProvider

		api = new API(mockOutputChannel, mockProvider, undefined, true)
		;(api as any).log = vi.fn()
	})

	// ─── Task History ──────────────────────────────────────────────

	describe("getTaskHistoryItems", () => {
		it("returns empty array when no tasks exist", () => {
			const items = api.getTaskHistoryItems()
			expect(items).toEqual([])
		})

		it("returns tasks from the task history store", () => {
			;(mockProvider.taskHistoryStore.getAll as ReturnType<typeof vi.fn>).mockReturnValue([
				{ id: "task-1", ts: 100, task: "test" },
			])
			const items = api.getTaskHistoryItems()
			expect(items).toHaveLength(1)
			expect(items[0].id).toBe("task-1")
		})
	})

	describe("showTaskWithId", () => {
		it("delegates to ShoferProvider.showTaskWithId", async () => {
			await api.showTaskWithId("task-1")
			expect(mockProvider.showTaskWithId).toHaveBeenCalledWith("task-1", undefined)
		})

		it("passes keepCurrentTask option", async () => {
			await api.showTaskWithId("task-2", { keepCurrentTask: true })
			expect(mockProvider.showTaskWithId).toHaveBeenCalledWith("task-2", { keepCurrentTask: true })
		})
	})

	// ─── Task Rename/Archive/Pin/Delete ─────────────────────────────

	describe("renameTask", () => {
		it("renames a task via updateTaskHistory and renameManagedTask", async () => {
			;(mockProvider.getTaskWithId as ReturnType<typeof vi.fn>).mockResolvedValue({
				historyItem: { id: "task-1", task: "old name" },
			})
			await api.renameTask("task-1", "New Name")
			expect(mockProvider.updateTaskHistory).toHaveBeenCalledWith(
				expect.objectContaining({ id: "task-1", name: "New Name" }),
			)
			expect(mockProvider.renameManagedTask).toHaveBeenCalledWith("task-1", "New Name")
		})

		it("throws when task is not found", async () => {
			;(mockProvider.getTaskWithId as ReturnType<typeof vi.fn>).mockResolvedValue({
				historyItem: undefined,
			})
			await expect(api.renameTask("missing", "New Name")).rejects.toThrow("Task not found")
		})
	})

	describe("archiveTask / unarchiveTask", () => {
		it("delegates archiveTask to ShoferProvider", async () => {
			await api.archiveTask("task-1")
			expect(mockProvider.archiveManagedTask).toHaveBeenCalledWith("task-1")
		})

		it("delegates unarchiveTask to ShoferProvider", async () => {
			await api.unarchiveTask("task-2")
			expect(mockProvider.unarchiveManagedTask).toHaveBeenCalledWith("task-2")
		})
	})

	describe("pinTask / unpinTask", () => {
		it("delegates pinTask to ShoferProvider", async () => {
			await api.pinTask("task-1")
			expect(mockProvider.pinManagedTask).toHaveBeenCalledWith("task-1")
		})

		it("delegates unpinTask to ShoferProvider", async () => {
			await api.unpinTask("task-2")
			expect(mockProvider.unpinManagedTask).toHaveBeenCalledWith("task-2")
		})
	})

	describe("deleteTask", () => {
		it("delegates deleteTask with cascadeSubtasks=true by default", async () => {
			await api.deleteTask("task-1")
			expect(mockProvider.deleteTaskWithId).toHaveBeenCalledWith("task-1", true)
		})

		it("passes cascadeSubtasks=false", async () => {
			await api.deleteTask("task-2", false)
			expect(mockProvider.deleteTaskWithId).toHaveBeenCalledWith("task-2", false)
		})
	})

	// ─── Logging ────────────────────────────────────────────────────

	describe("getOutputLogs", () => {
		it("returns log lines from the ring buffer", () => {
			const logs = api.getOutputLogs()
			expect(logs).toContain("log line 1")
			expect(logs).toContain("log line 2")
		})

		it("passes maxLines parameter", () => {
			const logs = api.getOutputLogs(100)
			expect(logs).toBeTruthy()
		})
	})

	// ─── Configuration Import/Export ─────────────────────────────────

	describe("exportConfiguration", () => {
		it("returns JSON string of current configuration", () => {
			;(mockProvider.getValues as ReturnType<typeof vi.fn>).mockReturnValue({
				mode: "code",
				apiProvider: "openrouter",
			})
			const json = api.exportConfiguration()
			const parsed = JSON.parse(json)
			expect(parsed.mode).toBe("code")
			expect(parsed.apiProvider).toBe("openrouter")
		})
	})

	describe("importConfiguration", () => {
		it("parses and applies configuration", async () => {
			await api.importConfiguration(JSON.stringify({ mode: "architect" }))
			expect(mockProvider.contextProxy.setValues).toHaveBeenCalledWith(
				expect.objectContaining({ mode: "architect" }),
			)
		})

		it("throws on invalid JSON", async () => {
			await expect(api.importConfiguration("not json")).rejects.toThrow("Invalid configuration JSON")
		})
	})
})
