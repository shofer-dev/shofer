import { describe, it, expect, vi } from "vitest"

import type { AgentApi, ServerEvent } from "../agent-api.js"
import type { HostBridge } from "../host.js"
import { createInMemoryHost, RecordingNotifier } from "../host-memory.js"
import { createSplitHost } from "../host-rpc.js"
import { connectSession, serveSession } from "../session-transport.js"

const flush = () => new Promise((resolve) => setTimeout(resolve))

/** A mock executor-side AgentApi whose event stream the test drives. */
function makeExecutorApi() {
	let emit: (e: ServerEvent) => void = () => {}
	const api: AgentApi = {
		createTask: vi.fn(async (input) => ({ taskId: `task-for-${input.prompt}` })),
		sendMessage: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		respondToAsk: vi.fn(async () => {}),
		applyConfig: vi.fn(async () => {}),
		getCheckpointDiff: vi.fn(async () => [
			{ paths: { relative: "a.ts", absolute: "/w/a.ts" }, content: { before: "x", after: "y" } },
		]),
		getTaskChangedFiles: vi.fn(async () => ({ taskId: "t1", entries: [], backend: "none" as const })),
		getChangedFileDiff: vi.fn(async () => ({ original: "base", final: "final" })),
		restoreCheckpoint: vi.fn(async () => {}),
		revertChangedFile: vi.fn(async () => {}),
		revertAllChangedFiles: vi.fn(async () => {}),
		acceptChangedFile: vi.fn(async () => {}),
		acceptAllChangedFiles: vi.fn(async () => {}),
		pluginRequest: vi.fn(async () => ({ ok: true })),
		subscribe: (listener) => {
			emit = listener
			return () => {}
		},
	}
	return { api, emit: (e: ServerEvent) => emit(e) }
}

function wire(controllerHost: HostBridge, executorApi: AgentApi) {
	// Cross-connect: each endpoint's `send` feeds the other's `receive`.
	let controllerReceive: (f: Parameters<ReturnType<typeof connectSession>["receive"]>[0]) => void = () => {}
	const executor = serveSession({ api: executorApi, send: (f) => controllerReceive(f) })
	const controller = connectSession({ host: controllerHost, send: (f) => void executor.receive(f) })
	controllerReceive = (f) => void controller.receive(f)
	return { controller, executor }
}

describe("session transport (controller ↔ executor)", () => {
	it("drives the AgentApi across the link", async () => {
		const { api } = makeExecutorApi()
		const { controller } = wire(createInMemoryHost(), api)
		const result = await controller.api.createTask({ prompt: "hello", mode: "code" })
		expect(result).toEqual({ taskId: "task-for-hello" })
		expect(api.createTask).toHaveBeenCalledWith({ prompt: "hello", mode: "code" })
	})

	it("round-trips respondToAsk across the link", async () => {
		const { api } = makeExecutorApi()
		const { controller } = wire(createInMemoryHost(), api)
		await controller.api.respondToAsk("t1", { askResponse: "yesButtonClicked", text: "ok", askId: "a1" })
		expect(api.respondToAsk).toHaveBeenCalledWith("t1", {
			askResponse: "yesButtonClicked",
			text: "ok",
			askId: "a1",
		})
	})

	it("round-trips the L3 reverse-data-channel methods across the link", async () => {
		const { api } = makeExecutorApi()
		const { controller } = wire(createInMemoryHost(), api)

		// Data method: the computed diff comes back as the command result.
		const diff = await controller.api.getCheckpointDiff("t1", { commitHash: "c1", mode: "checkpoint" })
		expect(api.getCheckpointDiff).toHaveBeenCalledWith("t1", { commitHash: "c1", mode: "checkpoint" })
		expect(diff).toEqual([
			{ paths: { relative: "a.ts", absolute: "/w/a.ts" }, content: { before: "x", after: "y" } },
		])

		const changed = await controller.api.getChangedFileDiff("t1", "a.ts")
		expect(api.getChangedFileDiff).toHaveBeenCalledWith("t1", "a.ts")
		expect(changed).toEqual({ original: "base", final: "final" })

		// Execute methods resolve void and reach the executor.
		await controller.api.restoreCheckpoint("t1", { ts: 1, commitHash: "c1", mode: "restore" })
		expect(api.restoreCheckpoint).toHaveBeenCalledWith("t1", { ts: 1, commitHash: "c1", mode: "restore" })

		await controller.api.revertChangedFile("t1", "a.ts")
		expect(api.revertChangedFile).toHaveBeenCalledWith("t1", "a.ts")
		await controller.api.revertAllChangedFiles("t1")
		expect(api.revertAllChangedFiles).toHaveBeenCalledWith("t1")
		await controller.api.acceptChangedFile("t1", "a.ts")
		expect(api.acceptChangedFile).toHaveBeenCalledWith("t1", "a.ts")
		await controller.api.acceptAllChangedFiles("t1")
		expect(api.acceptAllChangedFiles).toHaveBeenCalledWith("t1")

		// Generic plugin RPC round-trips the plugin's result over the session frames.
		expect(await controller.api.pluginRequest("t1", "checkpoints", "diff", { hash: "abc" })).toEqual({ ok: true })
		expect(api.pluginRequest).toHaveBeenCalledWith("t1", "checkpoints", "diff", { hash: "abc" })
	})

	it("streams executor events to controller subscribers", async () => {
		const { api, emit } = makeExecutorApi()
		const { controller } = wire(createInMemoryHost(), api)
		const seen: ServerEvent[] = []
		controller.api.subscribe((e) => seen.push(e))
		emit({ type: "Message", text: "hi" })
		await flush()
		expect(seen).toEqual([{ type: "Message", text: "hi" }])
	})

	it("routes a split-host front-end call from the executor back to the controller", async () => {
		const notifier = new RecordingNotifier()
		const controllerHost: HostBridge = { ...createInMemoryHost(), notifier }
		const { api } = makeExecutorApi()
		const { executor } = wire(controllerHost, api)

		// The executor builds its host from a local base + the session's callback channel.
		const executorHost = createSplitHost({ local: createInMemoryHost(), channel: executor.channel })
		executorHost.notifier.warn("from the executor")
		await flush()
		expect(notifier.messages).toContainEqual({ level: "warn", message: "from the executor" })
	})

	it("returns a host-callback result across the link (lsp.getDiagnostics)", async () => {
		const diag = { filePath: "/a.ts", line: 1, column: 1, severity: "error" as const, message: "boom" }
		const base = createInMemoryHost()
		const controllerHost: HostBridge = { ...base, lsp: { ...base.lsp, getDiagnostics: async () => [diag] } }
		const { api } = makeExecutorApi()
		const { executor } = wire(controllerHost, api)
		const executorHost = createSplitHost({ local: createInMemoryHost(), channel: executor.channel })
		expect(await executorHost.lsp.getDiagnostics()).toEqual([diag])
	})
})
