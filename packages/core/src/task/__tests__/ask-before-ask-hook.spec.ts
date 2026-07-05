// Prevent the transitive import graph from loading extension.ts,
// which pulls in WorkflowTask (which extends Task — circular).
vi.mock("../../../extension", () => ({}))

vi.mock("../../logging/subsystems.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../logging/subsystems.js")>()),
	taskLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	webviewLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	configLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { setHost, createInMemoryHost, type ShoferPlugin } from "@shofer/types"

import { Task } from "../Task.js"
import { pluginRegistry } from "../../plugins/plugin-registry.js"

/**
 * Phase 3 (design §6.9): `beforeAsk` is wired at the top of `Task.ask()`. A permitted
 * plugin may auto-answer an ask (short-circuiting the user prompt) or modify its text.
 * With no participating plugin the branch is skipped entirely (proven by the rest of
 * the Task suite staying green).
 */
describe("Task.ask() beforeAsk lifecycle hook", () => {
	const registered: string[] = []

	const buildTaskShell = () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).taskId = "task-1"
		;(task as any)._cwd = "/workspace"
		;(task as any)._taskMode = "code"
		;(task as any).lastMessageTs = undefined
		;(task as any)._currentAskId = undefined
		;(task as any).emit = vi.fn()
		;(task as any).addToShoferMessages = vi.fn(async () => {})
		return task
	}

	const useLifecyclePlugin = async (plugin: ShoferPlugin) => {
		await pluginRegistry.register(plugin, {}, { lifecycle: true })
		registered.push(plugin.name)
	}

	beforeEach(() => {
		setHost(createInMemoryHost())
	})

	afterEach(() => {
		for (const name of registered.splice(0)) pluginRegistry.unregister(name)
	})

	it("auto-approves an ask (short-circuit) and records it as auto-approved", async () => {
		await useLifecyclePlugin({ name: "approver", lifecycle: { beforeAsk: () => ({ decision: "approve" }) } })

		const task = buildTaskShell()
		const result = await task.ask("tool", "run this?")

		expect(result.response).toBe("yesButtonClicked")
		const addMsg = (task as any).addToShoferMessages as ReturnType<typeof vi.fn>
		expect(addMsg).toHaveBeenCalledTimes(1)
		expect(addMsg.mock.calls[0]![0]).toMatchObject({ ask: "tool", autoApproved: true, isAnswered: true })
	})

	it("auto-denies an ask (short-circuit)", async () => {
		await useLifecyclePlugin({ name: "denier", lifecycle: { beforeAsk: () => ({ decision: "deny" }) } })

		const task = buildTaskShell()
		const result = await task.ask("tool", "run this?")

		expect(result.response).toBe("noButtonClicked")
	})

	it("modifies the ask text while auto-answering", async () => {
		await useLifecyclePlugin({
			name: "rewriter",
			lifecycle: { beforeAsk: () => ({ decision: "approve", text: "MODIFIED" }) },
		})

		const task = buildTaskShell()
		const result = await task.ask("followup", "original")

		expect(result.text).toBe("MODIFIED")
		const addMsg = (task as any).addToShoferMessages as ReturnType<typeof vi.fn>
		expect(addMsg.mock.calls[0]![0]).toMatchObject({ text: "MODIFIED" })
	})

	it("does not short-circuit a plugin that lacks the lifecycle grant", async () => {
		// Registered WITHOUT the grant — beforeAsk must not fire.
		await pluginRegistry.register({
			name: "ungranted",
			lifecycle: { beforeAsk: () => ({ decision: "approve" }) },
		})
		registered.push("ungranted")

		expect(pluginRegistry.hasLifecycleHook("beforeAsk")).toBe(false)
	})
})
