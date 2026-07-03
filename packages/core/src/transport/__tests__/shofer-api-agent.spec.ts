import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"

import { ShoferEventName, type ShoferAPI } from "@shofer/types"

import { ShoferApiAgent } from "../shofer-api-agent.js"

/**
 * §11 live adapter — maps the transport's AgentApi onto the in-process ShoferAPI.
 */
describe("ShoferApiAgent (§11)", () => {
	const makeApi = () => {
		const emitter = new EventEmitter()
		const api = Object.assign(emitter, {
			startNewTask: vi.fn(async ({ text }: { text?: string }) => `task:${text}`),
			resumeTask: vi.fn(async () => {}),
			sendMessage: vi.fn(async () => {}),
			cancelCurrentTask: vi.fn(async () => {}),
			respondToAsk: vi.fn(async () => {}),
		}) as unknown as ShoferAPI & EventEmitter
		return api
	}

	it("createTask delegates to startNewTask", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api)
		expect(await agent.createTask({ prompt: "hi" })).toEqual({ taskId: "task:hi" })
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).startNewTask).toHaveBeenCalledWith({
			text: "hi",
			taskId: undefined,
		})
	})

	it("sendMessage resumes the addressed task then sends", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api)
		await agent.sendMessage("t1", "go")
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).resumeTask).toHaveBeenCalledWith("t1")
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).sendMessage).toHaveBeenCalledWith("go")
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
