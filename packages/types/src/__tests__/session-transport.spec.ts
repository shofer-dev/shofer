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
		const result = await controller.api.createTask({ prompt: "hello" })
		expect(result).toEqual({ taskId: "task-for-hello" })
		expect(api.createTask).toHaveBeenCalledWith({ prompt: "hello" })
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
