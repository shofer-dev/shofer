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
			applySyncedSettings: vi.fn(async () => {}),
			applySyncedSecrets: vi.fn(async () => {}),
			getCheckpointDiff: vi.fn(async () => [
				{ paths: { relative: "a", absolute: "/a" }, content: { before: "b", after: "c" } },
			]),
			getTaskChangedFiles: vi.fn(async () => ({ taskId: "t1", entries: [], backend: "none" })),
			getChangedFileDiff: vi.fn(async () => ({ original: "o", final: "f" })),
			restoreCheckpoint: vi.fn(async () => {}),
			revertChangedFile: vi.fn(async () => {}),
			revertAllChangedFiles: vi.fn(async () => {}),
			acceptChangedFile: vi.fn(async () => {}),
			acceptAllChangedFiles: vi.fn(async () => {}),
		}) as unknown as ShoferAPI & EventEmitter
		return api
	}

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

	it("applyConfig applies the config + secrets and records the version when allowClientConfig is set (config_sync §Part A)", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api, { allowClientConfig: true })
		const config = { autoApprovalEnabled: true } as never
		const secrets = { codeIndexOpenAiKey: "sk-test" }
		await agent.applyConfig(config, "v1", secrets)
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).applySyncedSettings).toHaveBeenCalledWith(
			config,
		)
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).applySyncedSecrets).toHaveBeenCalledWith(
			secrets,
		)
		expect(agent.configVersion).toBe("v1")
	})

	it("applyConfig ignores the controller push when it has a CLI override (default)", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api) // allowClientConfig defaults to false
		await agent.applyConfig({ autoApprovalEnabled: true } as never, "v1", { codeIndexOpenAiKey: "sk-test" })
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).applySyncedSettings).not.toHaveBeenCalled()
		expect((api as unknown as Record<string, ReturnType<typeof vi.fn>>).applySyncedSecrets).not.toHaveBeenCalled()
		expect(agent.configVersion).toBeUndefined()
	})

	it("acceptsClientConfig reflects the constructed allowClientConfig option", () => {
		expect(new ShoferApiAgent(makeApi(), { allowClientConfig: true }).acceptsClientConfig).toBe(true)
		expect(new ShoferApiAgent(makeApi(), { allowClientConfig: false }).acceptsClientConfig).toBe(false)
		expect(new ShoferApiAgent(makeApi()).acceptsClientConfig).toBe(false) // default
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

	it("L3 reverse-data-channel methods delegate 1:1 to the in-process ShoferAPI", async () => {
		const api = makeApi()
		const agent = new ShoferApiAgent(api)
		const rec = api as unknown as Record<string, ReturnType<typeof vi.fn>>

		expect(await agent.getCheckpointDiff("t1", { commitHash: "c1", mode: "checkpoint" })).toEqual([
			{ paths: { relative: "a", absolute: "/a" }, content: { before: "b", after: "c" } },
		])
		expect(rec.getCheckpointDiff).toHaveBeenCalledWith("t1", { commitHash: "c1", mode: "checkpoint" })

		expect(await agent.getChangedFileDiff("t1", "a.ts")).toEqual({ original: "o", final: "f" })
		expect(rec.getChangedFileDiff).toHaveBeenCalledWith("t1", "a.ts")

		await agent.getTaskChangedFiles("t1")
		expect(rec.getTaskChangedFiles).toHaveBeenCalledWith("t1")

		await agent.restoreCheckpoint("t1", { ts: 1, commitHash: "c1", mode: "restore" })
		expect(rec.restoreCheckpoint).toHaveBeenCalledWith("t1", { ts: 1, commitHash: "c1", mode: "restore" })

		await agent.revertChangedFile("t1", "a.ts")
		expect(rec.revertChangedFile).toHaveBeenCalledWith("t1", "a.ts")
		await agent.revertAllChangedFiles("t1")
		expect(rec.revertAllChangedFiles).toHaveBeenCalledWith("t1")
		await agent.acceptChangedFile("t1", "a.ts")
		expect(rec.acceptChangedFile).toHaveBeenCalledWith("t1", "a.ts")
		await agent.acceptAllChangedFiles("t1")
		expect(rec.acceptAllChangedFiles).toHaveBeenCalledWith("t1")
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
