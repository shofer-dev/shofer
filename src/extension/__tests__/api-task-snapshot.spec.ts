import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import type { HistoryItem, ShoferMessage } from "@shofer/types"

import { API } from "../api"
import { ShoferProvider } from "../../core/webview/ShoferProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ShoferProvider")

/**
 * `getTaskSnapshot` is the backfill half of attaching to a running task: it
 * assembles the transcript, the title/lifecycle and the outstanding ask from
 * this host's own records, so an attaching view renders exactly what the owning
 * host shows — including an ask raised before it attached.
 */
describe("API - getTaskSnapshot", () => {
	let api: API
	let mockProvider: ShoferProvider
	let getManagedTaskInstance: ReturnType<typeof vi.fn>
	let getCurrentTask: ReturnType<typeof vi.fn>
	let getTaskHistoryItems: ReturnType<typeof vi.fn>

	const historyItem = {
		id: "t1",
		number: 1,
		ts: 1700,
		task: "do the thing",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		taskState: { lifecycle: "running" },
	} as HistoryItem

	const liveTask = (messages: ShoferMessage[], tokenUsage?: unknown) => ({
		taskId: "t1",
		shoferMessages: messages,
		getTokenUsage: () => tokenUsage,
	})

	beforeEach(() => {
		getManagedTaskInstance = vi.fn().mockReturnValue(undefined)
		getCurrentTask = vi.fn().mockReturnValue(undefined)
		getTaskHistoryItems = vi.fn().mockReturnValue([historyItem])

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
			getCurrentTask,
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			taskManager: { getManagedTaskInstance },
			taskHistoryStore: { getOrLoad: vi.fn().mockResolvedValue(undefined) },
		} as unknown as ShoferProvider

		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, mockProvider, undefined, true)
		;(api as any).log = vi.fn()
		;(api as any).getTaskHistoryItems = getTaskHistoryItems
	})

	it("assembles messages, title, lifecycle and usage from the host's own records", async () => {
		const messages: ShoferMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "hello" },
			{ ts: 2, type: "say", say: "text", text: "working" },
		]
		const tokenUsage = { totalTokensIn: 10, totalTokensOut: 5, totalCost: 0.02, contextTokens: 42 }
		getCurrentTask.mockReturnValue(liveTask(messages, tokenUsage))

		expect(await api.getTaskSnapshot("t1")).toEqual({
			taskId: "t1",
			summary: "do the thing",
			createdAt: 1700,
			state: { lifecycle: "running" },
			messages,
			outstandingAsk: undefined,
			tokenUsage,
		})
	})

	it("reports the ask a task is blocked on — including one raised before the attach", async () => {
		getCurrentTask.mockReturnValue(
			liveTask([
				{ ts: 1, type: "say", say: "text", text: "hello" },
				{ ts: 3, type: "ask", ask: "tool", text: '{"tool":"editedExistingFile"}', askId: "ask-1" },
			]),
		)

		expect((await api.getTaskSnapshot("t1"))?.outstandingAsk).toEqual({
			ask: "tool",
			askId: "ask-1",
			text: '{"tool":"editedExistingFile"}',
			ts: 3,
		})
	})

	it("is undefined for a task this host does not know", async () => {
		expect(await api.getTaskSnapshot("nope")).toBeUndefined()
	})

	it("still assembles a snapshot for a task with no history entry", async () => {
		getCurrentTask.mockReturnValue(liveTask([]))
		getTaskHistoryItems.mockReturnValue([])

		expect(await api.getTaskSnapshot("t1")).toMatchObject({
			taskId: "t1",
			messages: [],
			summary: undefined,
			state: undefined,
		})
	})
})
