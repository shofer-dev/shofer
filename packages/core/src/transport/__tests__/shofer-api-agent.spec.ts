import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"

import { ShoferEventName } from "@shofer/types"

import type { ShoferExtensionApi, ShoferMessage } from "@shofer/types"

import { ShoferApiAgent, FORWARDED_EVENTS, findOutstandingAsk } from "../shofer-api-agent.js"

/**
 * `ShoferExtensionApi` is itself a `ShoferApi`, so this adapter carries only what
 * the interface cannot express: the `allowClientConfig` gate on a client-supplied
 * per-task provider config, and rehydrating an addressed task before delivering
 * a message to it. Everything else must pass straight through — a translation
 * layer here would be a second place for the two surfaces to drift.
 */
describe("ShoferApiAgent", () => {
	const makeApi = (overrides: Partial<Record<string, unknown>> = {}) => {
		const emitter = new EventEmitter()
		return Object.assign(emitter, {
			createTask: vi.fn(async ({ prompt }: { prompt?: string }) => ({ taskId: `task:${prompt}` })),
			resumeTask: vi.fn(async () => {}),
			sendMessage: vi.fn(async () => {}),
			cancelTask: vi.fn(async () => {}),
			respondToAsk: vi.fn(async () => {}),
			getTaskSnapshot: vi.fn(async (taskId: string) => ({ taskId, messages: [] })),
			pluginRequest: vi.fn(async () => ({ ok: true })),
			subscribe: vi.fn(() => () => {}),
			...overrides,
		}) as unknown as ShoferExtensionApi & EventEmitter
	}
	const spies = (api: ShoferExtensionApi) => api as unknown as Record<string, ReturnType<typeof vi.fn>>

	it("createTask delegates, keeping mode and prompt", async () => {
		const api = makeApi()
		expect(await new ShoferApiAgent(api).createTask({ prompt: "hi", mode: "code" })).toEqual({
			taskId: "task:hi",
		})
		expect(spies(api).createTask).toHaveBeenCalledWith({
			prompt: "hi",
			mode: "code",
			apiConfiguration: undefined,
		})
	})

	it("createTask applies the client apiConfiguration when allowClientConfig is set", async () => {
		const api = makeApi()
		const apiConfiguration = { apiProvider: "openai", apiModelId: "gpt-4o" } as never
		await new ShoferApiAgent(api, { allowClientConfig: true }).createTask({
			prompt: "hi",
			mode: "code",
			apiConfiguration,
		})
		expect(spies(api).createTask).toHaveBeenCalledWith(expect.objectContaining({ apiConfiguration }))
	})

	it("createTask drops the client apiConfiguration when the host has a CLI override (default)", async () => {
		const api = makeApi()
		await new ShoferApiAgent(api).createTask({
			prompt: "hi",
			mode: "code",
			apiConfiguration: { apiProvider: "openai" } as never,
		})
		// `mode` still applies — it selects behaviour, not credentials.
		expect(spies(api).createTask).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "code", apiConfiguration: undefined }),
		)
	})

	it("createTask keeps BEHAVIOUR settings through a CLI override, dropping credentials", async () => {
		const api = makeApi()
		await new ShoferApiAgent(api).createTask({
			prompt: "hi",
			mode: "code",
			apiConfiguration: {
				// credentials + identity — pinned by the host, must not survive
				apiProvider: "openai",
				apiModelId: "gpt-4o",
				openAiApiKey: "sk-secret",
				openAiBaseUrl: "https://elsewhere.example",
				// behaviour — the caller's to choose per task
				enableReasoningEffort: false,
				reasoningEffort: "low",
				modelMaxThinkingTokens: 0,
			} as never,
		})
		expect(spies(api).createTask).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: {
					enableReasoningEffort: false,
					reasoningEffort: "low",
					modelMaxThinkingTokens: 0,
				},
			}),
		)
	})

	it("createTask keeps toolCallingEnabled through a CLI override", async () => {
		const api = makeApi()
		await new ShoferApiAgent(api).createTask({
			prompt: "hi",
			mode: "code",
			apiConfiguration: {
				apiProvider: "openai",
				openAiApiKey: "sk-secret",
				// A realtime caller's turn is plain streamed text — a behaviour
				// choice per task, not a credential the pin protects.
				toolCallingEnabled: false,
			} as never,
		})
		expect(spies(api).createTask).toHaveBeenCalledWith(
			expect.objectContaining({ apiConfiguration: { toolCallingEnabled: false } }),
		)
	})

	it("createTask leaves apiConfiguration undefined when a pinned host is sent only credentials", async () => {
		const api = makeApi()
		await new ShoferApiAgent(api).createTask({
			prompt: "hi",
			mode: "code",
			apiConfiguration: { apiProvider: "openai", openAiApiKey: "sk-secret" } as never,
		})
		// Nothing tunable was supplied, so the host must see "no client config"
		// rather than an empty object that would read as an override.
		expect(spies(api).createTask).toHaveBeenCalledWith(expect.objectContaining({ apiConfiguration: undefined }))
	})

	it("createTask forwards a controller-supplied title (which locks the name)", async () => {
		const api = makeApi()
		await new ShoferApiAgent(api).createTask({ prompt: "hi", mode: "code", title: "Call with Maria" })
		expect(spies(api).createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Call with Maria" }))
	})

	it("sendMessage delivers straight through, without resuming first", async () => {
		const api = makeApi()
		await new ShoferApiAgent(api).sendMessage("t1", "go", ["img"])
		expect(spies(api).sendMessage).toHaveBeenCalledWith("t1", "go", ["img"], undefined)
		// Resuming first RAISES a resume ask with nothing queued to answer it, so
		// it is answered by whoever watches asks (on a headless node, the CLI ask
		// dispatcher — which spends the `--retry` budget and then declines) before
		// the message ever arrives. Delivery owns the rehydration now.
		expect(spies(api).resumeTask).not.toHaveBeenCalled()
	})

	it("sendMessage still delivers when the task needs no rehydration", async () => {
		const api = makeApi({ resumeTask: vi.fn(async () => Promise.reject(new Error("already live"))) })
		await new ShoferApiAgent(api).sendMessage("t1", "go")
		expect(spies(api).sendMessage).toHaveBeenCalledWith("t1", "go", undefined, undefined)
	})

	it.each([
		["cancelTask", (a: ShoferApiAgent) => a.cancelTask("t1"), ["t1"]],
		[
			"respondToAsk",
			(a: ShoferApiAgent) => a.respondToAsk("t1", { askResponse: "yesButtonClicked" }),
			["t1", { askResponse: "yesButtonClicked" }],
		],
		["getTaskSnapshot", (a: ShoferApiAgent) => a.getTaskSnapshot("t1"), ["t1"]],
		[
			"pluginRequest",
			(a: ShoferApiAgent) => a.pluginRequest("t1", "checkpoints", "diff", { hash: "c1" }),
			["t1", "checkpoints", "diff", { hash: "c1" }],
		],
	])("%s passes straight through to the in-process API", async (name, call, args) => {
		const api = makeApi()
		await call(new ShoferApiAgent(api))
		expect(spies(api)[name as string]).toHaveBeenCalledWith(...(args as unknown[]))
	})

	it("subscribe passes straight through (the host owns the forwarded-event set)", () => {
		const api = makeApi()
		const listener = vi.fn()
		new ShoferApiAgent(api).subscribe(listener)
		expect(spies(api).subscribe).toHaveBeenCalledWith(listener)
	})
})

/**
 * The rule a host uses to decide "is this task blocked on an ask" — shared by the
 * snapshot assembly so a live task and one rehydrated from disk answer alike.
 */
describe("findOutstandingAsk", () => {
	const ask = (over: Partial<ShoferMessage> = {}): ShoferMessage => ({
		ts: 3,
		type: "ask",
		ask: "tool",
		text: '{"tool":"editedExistingFile"}',
		askId: "ask-1",
		...over,
	})

	it("reports the ask when the transcript ends on a complete, unanswered one", () => {
		expect(findOutstandingAsk([{ ts: 1, type: "say", say: "text", text: "hi" }, ask()])).toEqual({
			ask: "tool",
			askId: "ask-1",
			text: '{"tool":"editedExistingFile"}',
			ts: 3,
		})
	})

	it.each([
		["partial", { partial: true }],
		["auto-approved", { autoApproved: true }],
		["already answered", { isAnswered: true }],
	])("reports nothing for an ask that is %s", (_label, over) => {
		expect(findOutstandingAsk([ask(over)])).toBeUndefined()
	})

	it("reports nothing once the loop moved past the ask", () => {
		expect(findOutstandingAsk([ask(), { ts: 4, type: "say", say: "text", text: "after" }])).toBeUndefined()
	})

	it("reports nothing for an empty transcript", () => {
		expect(findOutstandingAsk([])).toBeUndefined()
	})
})

/**
 * The forwarded set is the boundary between "the host knows this" and "a
 * controller can act on it". A lifecycle event missing from it is not an error
 * anywhere — the controller simply never learns the fact, which is the failure
 * mode this test exists to make loud.
 */
describe("FORWARDED_EVENTS", () => {
	it("forwards the blocking states, the ask resolution and the delegation edges", () => {
		for (const name of [
			ShoferEventName.TaskActive,
			ShoferEventName.TaskInteractive,
			ShoferEventName.TaskResumable,
			ShoferEventName.TaskIdle,
			ShoferEventName.TaskAskResponded,
			ShoferEventName.TaskPaused,
			ShoferEventName.TaskUnpaused,
			ShoferEventName.TaskSpawned,
			ShoferEventName.TaskDelegated,
			ShoferEventName.TaskDelegationResumed,
			ShoferEventName.TaskToolFailed,
		]) {
			expect(FORWARDED_EVENTS).toContain(name)
		}
	})

	it("does NOT forward the host's own UI state or its configuration chatter", () => {
		for (const name of [
			ShoferEventName.TaskFocused,
			ShoferEventName.TaskUnfocused,
			ShoferEventName.QueuedMessagesUpdated,
			ShoferEventName.ModeChanged,
			ShoferEventName.ProviderProfileChanged,
			ShoferEventName.ModelsResponse,
		]) {
			expect(FORWARDED_EVENTS).not.toContain(name)
		}
	})

	it("carries no duplicates — a duplicate would double every such event on the wire", () => {
		expect(new Set(FORWARDED_EVENTS).size).toBe(FORWARDED_EVENTS.length)
	})
})
