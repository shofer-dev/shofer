import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"

import { ShoferEventName, type HistoryItem, type ShoferAPI, type ShoferMessage } from "@shofer/types"

import { ShoferApiAgent } from "../shofer-api-agent.js"

/**
 * §11 live adapter — maps the transport's AgentApi onto the in-process ShoferAPI.
 */
describe("ShoferApiAgent (§11)", () => {
	const makeApi = (overrides: Partial<Record<string, unknown>> = {}) => {
		const emitter = new EventEmitter()
		const api = Object.assign(emitter, {
			startNewTask: vi.fn(async ({ text }: { text?: string }) => `task:${text}`),
			resumeTask: vi.fn(async () => {}),
			sendMessage: vi.fn(async () => {}),
			cancelCurrentTask: vi.fn(async () => {}),
			respondToAsk: vi.fn(async () => {}),
			pluginRequest: vi.fn(async () => ({ ok: true })),
			getTaskConversation: vi.fn(async () => undefined),
			getTaskHistoryItems: vi.fn(() => []),
			...overrides,
		}) as unknown as ShoferAPI & EventEmitter
		return api
	}

	const askMessage = (over: Partial<ShoferMessage> = {}): ShoferMessage => ({
		ts: 3,
		type: "ask",
		ask: "tool",
		text: '{"tool":"editedExistingFile"}',
		askId: "ask-1",
		...over,
	})

	it("createTask delegates to startNewTask", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api)
		expect(await agent.createTask({ prompt: "hi", mode: "code" })).toEqual({ taskId: "task:hi" })
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).startNewTask).toHaveBeenCalledWith({
			text: "hi",
			taskId: undefined,
			initialMode: "code",
			configuration: undefined,
		})
	})

	it("createTask applies the client apiConfiguration when allowClientConfig is set", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api, { allowClientConfig: true })
		const apiConfiguration = { apiProvider: "openai", apiModelId: "gpt-4o" } as never
		await agent.createTask({ prompt: "hi", mode: "code", apiConfiguration })
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).startNewTask).toHaveBeenCalledWith({
			text: "hi",
			taskId: undefined,
			initialMode: "code",
			configuration: apiConfiguration,
		})
	})

	it("createTask ignores the client apiConfiguration when it has a CLI override (default)", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api) // allowClientConfig defaults to false
		await agent.createTask({ prompt: "hi", mode: "code", apiConfiguration: { apiProvider: "openai" } as never })
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).startNewTask).toHaveBeenCalledWith({
			text: "hi",
			taskId: undefined,
			initialMode: "code",
			configuration: undefined,
		})
	})

	it("sendMessage resumes the addressed task then sends", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api)
		await agent.sendMessage("t1", "go")
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).resumeTask).toHaveBeenCalledWith("t1")
		// Delivery is task-addressed — (text, images, taskId) — never current-task-centric,
		// which raced concurrent tasks and dropped messages on headless hosts.
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).sendMessage).toHaveBeenCalledWith(
			"go",
			undefined,
			"t1",
		)
	})

	it("cancelTask cancels the current task", async () => {
		const api = makeApi()
		await new ShoferApiAgent(api).cancelTask("t1")
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).cancelCurrentTask).toHaveBeenCalled()
	})

	it("respondToAsk delegates to ShoferAPI.respondToAsk", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api)
		await agent.respondToAsk("t1", { askResponse: "yesButtonClicked", askId: "a1" })
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).respondToAsk).toHaveBeenCalledWith("t1", {
			askResponse: "yesButtonClicked",
			askId: "a1",
		})
	})

	it("delegates the L3 plugin request 1:1 to the in-process ShoferAPI", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api)
		const rec = api as unknown as Record<string, ReturnType<typeof vi.fn>>

		await agent.pluginRequest("t1", "checkpoints", "diff", { hash: "c1" })
		expect(rec.pluginRequest).toHaveBeenCalledWith("t1", "checkpoints", "diff", { hash: "c1" })
	})

	describe("getTaskSnapshot (attach backfill)", () => {
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

		it("assembles messages, title, lifecycle and usage from the host's own records", async () => {
			const messages: ShoferMessage[] = [
				{ ts: 1, type: "say", say: "text", text: "hello" },
				{ ts: 2, type: "say", say: "text", text: "working" },
			]
			const tokenUsage = {
				totalTokensIn: 10,
				totalTokensOut: 5,
				totalCost: 0.02,
				contextTokens: 42,
			}
			const api = makeApi({
				getTaskConversation: vi.fn(async () => ({ messages, tokenUsage })),
				getTaskHistoryItems: vi.fn(() => [historyItem]),
			})

			const snapshot = await new ShoferApiAgent(api).getTaskSnapshot("t1")
			expect(snapshot).toEqual({
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
			const api = makeApi({
				getTaskConversation: vi.fn(async () => ({
					messages: [{ ts: 1, type: "say", say: "text", text: "hello" }, askMessage()],
				})),
				getTaskHistoryItems: vi.fn(() => [historyItem]),
			})

			const snapshot = await new ShoferApiAgent(api).getTaskSnapshot("t1")
			expect(snapshot?.outstandingAsk).toEqual({
				ask: "tool",
				askId: "ask-1",
				text: '{"tool":"editedExistingFile"}',
				ts: 3,
			})
		})

		it("reports no outstanding ask for a partial, auto-approved or answered ask", async () => {
			for (const over of [{ partial: true }, { autoApproved: true }, { isAnswered: true }]) {
				const api = makeApi({
					getTaskConversation: vi.fn(async () => ({ messages: [askMessage(over)] })),
				})
				expect((await new ShoferApiAgent(api).getTaskSnapshot("t1"))?.outstandingAsk).toBeUndefined()
			}
		})

		it("reports no outstanding ask once the loop moved past it", async () => {
			const api = makeApi({
				getTaskConversation: vi.fn(async () => ({
					messages: [askMessage(), { ts: 4, type: "say", say: "text", text: "after" }],
				})),
			})
			expect((await new ShoferApiAgent(api).getTaskSnapshot("t1"))?.outstandingAsk).toBeUndefined()
		})

		it("is undefined for a task this host does not know", async () => {
			const api = makeApi()
			expect(await new ShoferApiAgent(api).getTaskSnapshot("nope")).toBeUndefined()
		})

		it("still assembles a snapshot for a task with no history entry", async () => {
			const api = makeApi({ getTaskConversation: vi.fn(async () => ({ messages: [] })) })
			const snapshot = await new ShoferApiAgent(api).getTaskSnapshot("t1")
			expect(snapshot).toMatchObject({ taskId: "t1", messages: [], summary: undefined, state: undefined })
		})
	})

	it("subscribe forwards ShoferAPI events and unsubscribes", () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api)
		const seen: string[] = []
		const unsub = agent.subscribe((e) => seen.push(e.type))

		;(api as EventEmitter).emit(ShoferEventName.Message, { foo: 1 })
		;(api as EventEmitter).emit(ShoferEventName.TaskCompleted)
		expect(seen).toEqual([ShoferEventName.Message, ShoferEventName.TaskCompleted])

		unsub()
		;(api as EventEmitter).emit(ShoferEventName.Message, {})
		expect(seen).toHaveLength(2) // no more after unsubscribe
	})
})
