import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { ShoferEventName, type ShoferMessage, type ServerEvent } from "@shofer/types"

import { API } from "../api"
import { ShoferProvider } from "../../core/webview/ShoferProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ShoferProvider")

/**
 * A synchronously spawned child's question must reach the conversation's driver.
 *
 * The failure this pins down was silent and total: a controller subscribes to ONE
 * task's event stream — the conversation's root — so a child task's
 * `ask_followup_question` reached nobody, the child parked forever, and the
 * parent parked behind it inside `new_task`. Nothing errored and nothing logged.
 *
 * Two halves are tested here because neither is any use alone: the question is
 * REPUBLISHED on the root's stream (so the controller sees it at all), and the
 * answer — which the controller necessarily posts against the conversation, the
 * only id its question row holds — is ROUTED BACK to the child that raised it.
 */

/** A fake Task exposing only what the API's listeners touch. */
interface FakeTask {
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	isBackgroundTask: boolean
	on: (event: string, handler: (...args: unknown[]) => void) => void
	emitMessage: (message: ShoferMessage, action?: "created" | "updated") => void
}

function makeTask(init: {
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	isBackgroundTask?: boolean
}): FakeTask {
	const handlers = new Map<string, (...args: unknown[]) => void>()
	return {
		taskId: init.taskId,
		rootTaskId: init.rootTaskId,
		parentTaskId: init.parentTaskId,
		isBackgroundTask: init.isBackgroundTask ?? false,
		on(event, handler) {
			handlers.set(event, handler)
		},
		emitMessage(message, action = "created") {
			handlers.get(ShoferEventName.Message)?.({ action, message })
		},
	}
}

function followupAsk(askId: string): ShoferMessage {
	return {
		ts: 1,
		type: "ask",
		ask: "followup",
		askId,
		text: JSON.stringify({ question: "Which region?", suggest: [{ answer: "eu-west" }] }),
	}
}

describe("ShoferExtensionApi — a sync child's followup question", () => {
	let api: API
	let provider: ShoferProvider
	let events: ServerEvent[]
	let announceTaskCreated: (task: FakeTask) => void

	beforeEach(() => {
		const providerHandlers = new Map<string, (task: FakeTask) => void>()

		provider = {
			context: {} as vscode.ExtensionContext,
			cwd: "/test/workspace",
			viewLaunched: false,
			on: vi.fn((event: string, handler: (task: FakeTask) => void) => {
				providerHandlers.set(event, handler)
			}),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			getTaskStackInstances: vi.fn().mockReturnValue([]),
			taskManager: {
				getManagedTaskInstance: vi.fn().mockReturnValue(undefined),
				getManagedTasks: vi.fn().mockReturnValue([]),
			},
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		} as unknown as ShoferProvider

		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, provider)

		events = []
		api.subscribe((event) => events.push(event))

		announceTaskCreated = (task) => providerHandlers.get(ShoferEventName.TaskCreated)?.(task)
	})

	/** Every `message` event the stream carried, as `{ taskId, sourceTaskId, askId }`. */
	const messageEvents = () =>
		events
			.filter((event) => event.type === ShoferEventName.Message)
			.map((event) => {
				const payload = (event.args as unknown[])[0] as {
					taskId: string
					sourceTaskId?: string
					message: ShoferMessage
				}
				return { taskId: payload.taskId, sourceTaskId: payload.sourceTaskId, askId: payload.message.askId }
			})

	it("republishes the question on the ROOT task's stream, naming the asking task", () => {
		const child = makeTask({ taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1" })
		announceTaskCreated(child)

		child.emitMessage(followupAsk("ask-1"))

		expect(messageEvents()).toEqual([
			// The child's own stream still carries it — a controller attached to the
			// child is not deprived of anything.
			{ taskId: "child-1", sourceTaskId: undefined, askId: "ask-1" },
			// …and the conversation's stream now carries it too.
			{ taskId: "root-1", sourceTaskId: "child-1", askId: "ask-1" },
		])
	})

	it("republishes it once, however many times the message is re-emitted", () => {
		const child = makeTask({ taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1" })
		announceTaskCreated(child)

		child.emitMessage(followupAsk("ask-1"))
		child.emitMessage(followupAsk("ask-1"), "updated")

		expect(messageEvents().filter((event) => event.sourceTaskId)).toHaveLength(1)
	})

	it("leaves a BACKGROUND child's question alone — its parent answers it", () => {
		const child = makeTask({
			taskId: "child-1",
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			isBackgroundTask: true,
		})
		announceTaskCreated(child)

		child.emitMessage(followupAsk("ask-1"))

		expect(messageEvents()).toEqual([{ taskId: "child-1", sourceTaskId: undefined, askId: "ask-1" }])
	})

	it("leaves a root task's own question alone — it is already on the right stream", () => {
		const root = makeTask({ taskId: "root-1" })
		announceTaskCreated(root)

		root.emitMessage(followupAsk("ask-1"))

		expect(messageEvents()).toEqual([{ taskId: "root-1", sourceTaskId: undefined, askId: "ask-1" }])
	})

	it("does not republish a partial, auto-approved or already-answered ask", () => {
		const child = makeTask({ taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1" })
		announceTaskCreated(child)

		child.emitMessage({ ...followupAsk("ask-partial"), partial: true })
		child.emitMessage({ ...followupAsk("ask-auto"), autoApproved: true })
		child.emitMessage({ ...followupAsk("ask-done"), isAnswered: true })

		expect(messageEvents().filter((event) => event.sourceTaskId)).toEqual([])
	})

	describe("answering it", () => {
		/** The pieces of a live Task that answering an ask actually exercises. */
		interface AnswerableTask {
			taskId: string
			rootTaskId?: string
			parentTaskId?: string
			isAwaitingAsk: ReturnType<typeof vi.fn>
			handleWebviewAskResponse: ReturnType<typeof vi.fn>
		}

		let child: AnswerableTask
		let root: AnswerableTask

		beforeEach(() => {
			child = {
				taskId: "child-1",
				rootTaskId: "root-1",
				parentTaskId: "root-1",
				isAwaitingAsk: vi.fn((askId: string) => askId === "ask-1"),
				handleWebviewAskResponse: vi.fn(),
			}
			root = {
				taskId: "root-1",
				rootTaskId: undefined,
				isAwaitingAsk: vi.fn().mockReturnValue(false),
				handleWebviewAskResponse: vi.fn(),
			}
			;(provider.taskManager.getManagedTaskInstance as ReturnType<typeof vi.fn>).mockImplementation(
				(id: string) => (id === "root-1" ? root : undefined),
			)
			;(provider.getTaskStackInstances as ReturnType<typeof vi.fn>).mockReturnValue([root, child])
		})

		it("routes an answer addressed at the conversation to the child that asked", async () => {
			await api.respondToAsk("root-1", { askResponse: "messageResponse", text: "eu-west", askId: "ask-1" })

			expect(child.handleWebviewAskResponse).toHaveBeenCalledWith(
				"messageResponse",
				"eu-west",
				undefined,
				"ask-1",
			)
			expect(root.handleWebviewAskResponse).not.toHaveBeenCalled()
		})

		it("leaves an ordinary answer on the addressed task", async () => {
			root.isAwaitingAsk.mockImplementation((askId: string) => askId === "ask-root")

			await api.respondToAsk("root-1", { askResponse: "yesButtonClicked", askId: "ask-root" })

			expect(root.handleWebviewAskResponse).toHaveBeenCalled()
			expect(child.handleWebviewAskResponse).not.toHaveBeenCalled()
		})

		it("never crosses into another conversation", async () => {
			child.rootTaskId = "root-other"

			await api.respondToAsk("root-1", { askResponse: "messageResponse", text: "eu-west", askId: "ask-1" })

			expect(child.handleWebviewAskResponse).not.toHaveBeenCalled()
			// Falls back to the addressed task, whose askId guard drops the stale answer.
			expect(root.handleWebviewAskResponse).toHaveBeenCalled()
		})
	})
})
