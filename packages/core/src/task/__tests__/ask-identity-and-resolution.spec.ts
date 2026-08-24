// Prevent the transitive import graph from loading extension.ts,
// which pulls in WorkflowTask (which extends Task — circular).
vi.mock("../../../extension", () => ({}))

vi.mock("../../logging/subsystems.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../logging/subsystems.js")>()),
	taskLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	webviewLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	configLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// The auto-approval policy is stubbed so a test can pin ONE decision. The point
// under test is what observers are told about that decision, not how it is made.
const autoApprovalDecision = vi.hoisted(() => ({ value: "ask" as "ask" | "approve" | "deny" }))
vi.mock("../../auto-approval/index.js", () => ({
	checkAutoApproval: vi.fn(async () => ({ decision: autoApprovalDecision.value })),
}))

import { setHost, createInMemoryHost, type AskResolvedInfo, type PluginContext, type ShoferPlugin } from "@shofer/types"

import { Task } from "../Task.js"
import { pluginRegistry } from "../../plugins/plugin-registry.js"

/**
 * The two ask-identity seams, and the hook that makes the host's own
 * auto-approval decision observable.
 *
 * `beforeAsk` runs BEFORE `checkAutoApproval` — deliberately, so a plugin may
 * pre-empt the policy — which means it can never learn the verdict. `afterAsk` is
 * the other end, and it carries the host's `askId`, so a plugin's record of an
 * approval can be joined to whatever surface decided it.
 */
describe("Task.ask() — askId on beforeAsk, and afterAsk's verdict", () => {
	const registered: string[] = []

	const buildTaskShell = () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).taskId = "task-1"
		;(task as any)._cwd = "/workspace"
		;(task as any)._taskMode = "code"
		;(task as any).turnCount = 7
		;(task as any).lastMessageTs = undefined
		;(task as any)._currentAskId = undefined
		;(task as any).emit = vi.fn()
		;(task as any).addToShoferMessages = vi.fn(async () => {})
		;(task as any).providerRef = { deref: () => undefined }
		;(task as any).withTaskTrust = (state: unknown) => state
		;(task as any).isRoutedFollowupPending = () => false
		return task
	}

	const useLifecyclePlugin = async (plugin: ShoferPlugin) => {
		await pluginRegistry.register(plugin, {}, { lifecycle: true })
		registered.push(plugin.name)
	}

	/** `afterAsk` is fire-and-forget, so let its microtask chain drain. */
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

	beforeEach(() => {
		setHost(createInMemoryHost())
		autoApprovalDecision.value = "ask"
	})

	afterEach(() => {
		for (const name of registered.splice(0)) pluginRegistry.unregister(name)
	})

	it("hands beforeAsk the host's own askId, and it matches the persisted ask", async () => {
		let seen: PluginContext | undefined
		await useLifecyclePlugin({
			name: "observer",
			lifecycle: {
				beforeAsk: (_type, _payload, ctx) => {
					seen = ctx
				},
			},
		})
		autoApprovalDecision.value = "approve"

		const task = buildTaskShell()
		await task.ask("tool", "run this?")

		const addMsg = (task as any).addToShoferMessages as ReturnType<typeof vi.fn>
		expect(seen?.askId).toBeTruthy()
		// The join that matters: the id the hook saw IS the id on the durable row.
		expect(addMsg.mock.calls[0]![0].askId).toBe(seen?.askId)
	})

	it("reports an auto-approved ask as decided by the policy, not by a human", async () => {
		const seen: AskResolvedInfo[] = []
		await useLifecyclePlugin({ name: "watcher", lifecycle: { afterAsk: (info) => void seen.push(info) } })
		autoApprovalDecision.value = "approve"

		const task = buildTaskShell()
		await task.ask("tool", "run this?")
		await settle()

		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({
			taskId: "task-1",
			askType: "tool",
			outcome: "answered",
			response: "yesButtonClicked",
			decidedBy: "auto-approval",
			autoApproved: true,
		})
	})

	it("reports an ask a PLUGIN answered as decided by a plugin", async () => {
		const seen: AskResolvedInfo[] = []
		await useLifecyclePlugin({
			name: "decider",
			lifecycle: { beforeAsk: () => ({ decision: "deny" }), afterAsk: (info) => void seen.push(info) },
		})

		const task = buildTaskShell()
		await task.ask("tool", "run this?")
		await settle()

		expect(seen[0]).toMatchObject({
			outcome: "answered",
			response: "noButtonClicked",
			decidedBy: "plugin",
			autoApproved: true,
		})
	})

	it("pairs afterAsk with beforeAsk on the same askId", async () => {
		let raised: string | undefined
		const resolved: AskResolvedInfo[] = []
		await useLifecyclePlugin({
			name: "pairer",
			lifecycle: {
				beforeAsk: (_type, _payload, ctx) => {
					raised = ctx.askId
				},
				afterAsk: (info) => void resolved.push(info),
			},
		})
		autoApprovalDecision.value = "approve"

		const task = buildTaskShell()
		await task.ask("command", "ls?")
		await settle()

		expect(raised).toBeTruthy()
		expect(resolved).toHaveLength(1)
		expect(resolved[0]!.askId).toBe(raised)
	})

	it("reports an ask the task was torn down under as ABORTED, never as a refusal", async () => {
		const seen: AskResolvedInfo[] = []
		await useLifecyclePlugin({ name: "aborts", lifecycle: { afterAsk: (info) => void seen.push(info) } })

		const task = buildTaskShell()
		;(task as any).messageQueueService = { isEmpty: () => true, dequeueMessage: () => undefined }
		;(task as any).findMessageByTimestamp = () => undefined
		;(task as any).diagLog = () => {}

		const pending = task.ask("tool", "run this?")
		// The task is torn down while the ask is outstanding: nobody decided it.
		setTimeout(() => {
			;(task as any).abort = true
		}, 10)
		await expect(pending).rejects.toThrow(/aborted/)
		await settle()

		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ outcome: "aborted" })
		// The distinction the approvals rules insist on: closing is not deciding.
		expect(seen[0]!.response).toBeUndefined()
		expect(seen[0]!.decidedBy).toBeUndefined()
		expect(seen[0]!.autoApproved).toBeUndefined()
	})

	it("does not fire afterAsk for a plugin without the lifecycle grant", async () => {
		await pluginRegistry.register({ name: "ungranted", lifecycle: { afterAsk: () => {} } })
		registered.push("ungranted")

		expect(pluginRegistry.hasLifecycleHook("afterAsk")).toBe(false)
	})
})
