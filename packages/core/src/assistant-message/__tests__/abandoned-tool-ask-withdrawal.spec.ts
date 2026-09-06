// Prevent the transitive import graph from loading extension.ts,
// which pulls in the extension entrypoint (circular).
vi.mock("../../../extension", () => ({}))

vi.mock("../../logging/subsystems.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../logging/subsystems.js")>()),
	taskLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	webviewLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	toolsLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	configLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock("../../tools/validateToolUse.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../tools/validateToolUse.js")>()),
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		hasInstance: () => true,
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

import { ShoferEventName, createInMemoryHost, setHost, type ShoferMessage } from "@shofer/types"

import { BUILTIN_MODES } from "../../__fixtures__/builtin-config.js"
import { Task } from "../../task/Task.js"
import { presentAssistantMessage } from "../presentAssistantMessage.js"

/**
 * An ABANDONED tool call must not leave a live approval behind — and must not
 * leave one PER RETRY.
 *
 * A native tool renders itself while its arguments are still streaming:
 * `BaseTool.handlePartial` calls `Task.ask(type, text, true)`, which publishes an
 * `ask` message carrying `partial: true` and NO decision. `checkAutoApproval` is
 * consulted only when an ask COMPLETES, and the complete ask is raised by the
 * tool's own `execute()`. So a call that never reaches `execute()` — arguments
 * that did not parse (the §C `!block.nativeArgs` guard), a mode/tool validation
 * refusal, a previously rejected tool — used to leave that row published forever:
 * unfinalized, undecided, unanswerable, and invisible to the bundle posture that
 * would have approved the call.
 *
 * That is the approval storm's engine, because every one of those paths hands the
 * model a re-emit instruction: one tool call yields one orphaned ask per retry,
 * all carrying the same (usually empty) arguments, for as long as the model keeps
 * failing. Measured on a live L2 conversation whose tool arguments kept arriving
 * as `{}` (the concurrent-stream parser splice, since fixed): 39 orphaned
 * `partial: true` ask rows against 37 parse failures, in one turn.
 *
 * `Task.withdrawStreamedToolAsk` retires the row instead, marked `abandoned` —
 * NOT answered and NOT auto-approved, because withdrawing is not deciding.
 */

/** The predicate every consumer uses to decide whether an ask needs a decision. */
const needsADecision = (m: ShoferMessage): boolean =>
	m.type === "ask" && m.partial !== true && m.autoApproved !== true && m.isAnswered !== true && m.abandoned !== true

const buildTask = () => {
	const task = Object.create(Task.prototype) as Task
	const emit = vi.fn()
	const appended: ShoferMessage[] = []
	const provider = {
		getState: vi.fn(async () => ({ mode: "code", customModes: [] })),
		getCurrentTask: vi.fn(() => undefined),
		taskManager: { getFocusedTaskId: vi.fn(() => undefined) },
		postMessageToWebview: vi.fn(async () => {}),
	}

	// ── Task.ask() / updateShoferMessage() plumbing ──────────────────────────
	;(task as any).taskId = "task-storm"
	;(task as any).instanceId = "instance-1"
	;(task as any).abort = false
	;(task as any).abandoned = false
	;(task as any).isBackground = false
	;(task as any).parentTaskId = undefined
	;(task as any).shoferMessages = []
	;(task as any).askResponse = undefined
	;(task as any).askResponseText = undefined
	;(task as any).askResponseImages = undefined
	;(task as any).lastMessageTs = undefined
	;(task as any)._currentAskId = undefined
	;(task as any).isAwaitingAskResponse = false
	;(task as any).trustedReadPaths = []
	;(task as any).trustedWritePaths = []
	;(task as any)._lastPartialAppendTs = 0
	;(task as any)._tokenBearingMessageCount = 0
	;(task as any)._persistencePromise = Promise.resolve({
		appendTaskMessage: vi.fn(async (_taskId: string, message: ShoferMessage) => {
			appended.push(message)
		}),
	})
	;(task as any)._debouncedSaveShoferMessages = Object.assign(
		vi.fn(async () => {}),
		{ cancel: vi.fn() },
	)
	;(task as any).saveShoferMessages = vi.fn(async () => true)
	;(task as any).diagLog = vi.fn()
	;(task as any).emit = emit
	;(task as any).providerRef = { deref: () => provider }

	// ── presentAssistantMessage() plumbing ───────────────────────────────────
	;(task as any).presentAssistantMessageLocked = false
	;(task as any).presentAssistantMessageHasPendingUpdates = false
	;(task as any).currentStreamingContentIndex = 0
	;(task as any).assistantMessageContent = []
	;(task as any).userMessageContent = []
	;(task as any).didCompleteReadingStream = false
	;(task as any).didRejectTool = false
	;(task as any).didAlreadyUseTool = false
	;(task as any).consecutiveMistakeCount = 0
	;(task as any).api = { getModel: () => ({ id: "test-model", info: {} }) }
	;(task as any).recordToolUsage = vi.fn()
	;(task as any).recordToolError = vi.fn()
	;(task as any).toolRepetitionDetector = { check: vi.fn(() => ({ allowExecution: true })) }
	// `say` APPENDS, and that is load-bearing rather than incidental fidelity:
	// the guard's `say("error", …)` is what puts a message between one retry's
	// streamed ask and the next, so the next `ask(…, partial: true)` no longer
	// finds a trailing partial to update and creates a row of its own. That is
	// why the orphans accumulate one per retry instead of collapsing onto one.
	;(task as any).say = vi.fn(async (type: string, text?: string) => {
		;(task as any).shoferMessages.push({ ts: Date.now(), type: "say", say: type, text })
	})
	;(task as any).pushToolResultToUserContent = vi.fn((toolResult: unknown) => {
		;(task as any).userMessageContent.push(toolResult)
		return true
	})

	return {
		task,
		emit,
		askMessages: () => (task as any).shoferMessages.filter((m: ShoferMessage) => m.type === "ask"),
		emittedAsks: () =>
			emit.mock.calls
				.filter((call) => call[0] === ShoferEventName.Message)
				.map((call) => call[1] as { action: string; message: ShoferMessage })
				.filter((e) => e.message.type === "ask"),
	}
}

/**
 * One turn of the observed failure: the model emits `new_task`, its arguments
 * stream in (so the tool renders itself through `handlePartial`), and the stream
 * finalizes with arguments that do not parse — which is exactly the state
 * `finalizeStreamingToolCall`'s null branch leaves behind: a known tool, no
 * longer partial, with `nativeArgs` cleared.
 */
const runOneFailedNewTaskCall = async (task: Task, toolCallId: string, deltas: number) => {
	// `NewTaskTool.handlePartial` — verbatim shape, including the empty payload a
	// call whose argument fragments never arrived renders with.
	const partialPayload = JSON.stringify({ tool: "newTask", mode: "", content: "" })
	for (let i = 0; i < deltas; i++) {
		await task.ask("tool", partialPayload, true).catch(() => {})
	}

	;(task as any).assistantMessageContent = [
		{ type: "tool_use", id: toolCallId, name: "new_task", params: {}, partial: false },
	]
	;(task as any).currentStreamingContentIndex = 0
	;(task as any).presentAssistantMessageLocked = false
	;(task as any).presentAssistantMessageHasPendingUpdates = false

	await presentAssistantMessage(task)
	// The tail recursion runs the next (non-existent) block fire-and-forget.
	for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe("an abandoned tool call withdraws its streamed ask", () => {
	it("leaves no ask needing a decision, once per retry", async () => {
		const { task, askMessages } = buildTask()

		// Two retries of the same `new_task` call, exactly as the loop produces
		// them: the §C guard pushes a re-emit instruction and the model tries
		// again with the same (empty) arguments.
		await runOneFailedNewTaskCall(task, "toolu_newtask_1", 3)
		await runOneFailedNewTaskCall(task, "toolu_newtask_2", 3)

		const asks = askMessages()

		// One row per streamed call — the deltas UPDATE their row, they do not
		// each create one.
		expect(asks).toHaveLength(2)

		// The regression: before the fix both rows stayed `partial: true`
		// forever, so `shoferMessages` accumulated one undecided ask per retry.
		expect(asks.filter((m: ShoferMessage) => m.partial === true)).toHaveLength(0)

		// Both are WITHDRAWN — finalized with nothing to decide, and explicitly
		// not answered and not auto-approved, because nothing decided them.
		for (const ask of asks) {
			expect(ask.abandoned).toBe(true)
			expect(ask.partial).toBe(false)
			expect(ask.isAnswered).toBeUndefined()
			expect(ask.autoApproved).toBeUndefined()
			expect(ask.askId).toBeUndefined()
		}

		// The property that actually matters to a controller recording asks
		// durably: nothing here opens an approval.
		expect(asks.filter(needsADecision)).toHaveLength(0)

		// And the guard still did its job — the model gets its re-emit
		// instruction for each attempt.
		expect((task as any).consecutiveMistakeCount).toBe(2)
		expect((task as any).userMessageContent.filter((b: any) => b.is_error === true)).toHaveLength(2)
	})

	it("publishes the withdrawal, so a consumer that only sees events also stops asking", async () => {
		const { task, emittedAsks } = buildTask()

		await runOneFailedNewTaskCall(task, "toolu_newtask_1", 2)

		const events = emittedAsks()
		expect(events.length).toBeGreaterThan(0)

		// Whatever a subscriber saw mid-stream, the LAST thing it is told about
		// this ask is the withdrawal — no consumer is left holding a live one.
		const last = events.at(-1)!.message
		expect(last.abandoned).toBe(true)
		expect(last.partial).toBe(false)

		// No published snapshot ever asked for a decision.
		expect(events.map((e) => e.message).filter(needsADecision)).toHaveLength(0)
	})

	it("withdraws the ask when tool validation refuses the call", async () => {
		const { task, askMessages } = buildTask()
		const { validateToolUse } = await import("../../tools/validateToolUse.js")
		vi.mocked(validateToolUse).mockImplementationOnce(() => {
			throw new Error("Tool 'new_task' is not allowed in mode 'ask'.")
		})

		await task.ask("tool", JSON.stringify({ tool: "newTask", mode: "", content: "" }), true).catch(() => {})
		;(task as any).assistantMessageContent = [
			{
				type: "tool_use",
				id: "toolu_refused",
				name: "new_task",
				params: {},
				partial: false,
				nativeArgs: { mode: "code", message: "go" },
			},
		]
		await presentAssistantMessage(task)
		for (let i = 0; i < 8; i++) await Promise.resolve()

		const asks = askMessages()
		expect(asks).toHaveLength(1)
		expect(asks[0]!.abandoned).toBe(true)
		expect(asks.filter(needsADecision)).toHaveLength(0)
	})
})

/**
 * The same defect one layer deeper, and the reason the withdrawal is a guard at
 * the END of the tool block rather than a patch on each abandoning path.
 *
 * The three paths above all abandon BEFORE `execute()` runs. A tool can also
 * abandon INSIDE it: `NewTaskTool.execute` refuses an unknown mode with
 * `Invalid mode: <slug>` and returns before it ever builds `toolMessage` or calls
 * `askApproval`, so the streamed row `handlePartial` published is neither
 * finalized nor withdrawn — identical remnant, identical re-emit instruction to
 * the model, identical one-orphan-per-retry shape. Observed live: the model
 * guessed the slug `ask`, which no deployed bundle contributes, and a
 * `partial: true` `{"tool":"newTask","mode":"ask",…}` row survived the turn.
 */
describe("a tool that refuses inside execute() withdraws its streamed ask too", () => {
	/** Stubs `NewTaskTool.execute` needs to reach its mode check and no further. */
	const equipForNewTask = (task: Task) => {
		setHost(createInMemoryHost())
		const provider = {
			// The effective mode list a real host assembles. `ask` is not in it —
			// there are six contributed modes and none is named that.
			getState: vi.fn(async () => ({ mode: "code", customModes: BUILTIN_MODES })),
			getCurrentTask: vi.fn(() => undefined),
			taskManager: {
				getFocusedTaskId: vi.fn(() => undefined),
				countActiveTasks: vi.fn(() => 0),
			},
			contextProxy: { getValue: vi.fn(() => undefined) },
			getTaskWithId: vi.fn(async () => ({ historyItem: {} })),
			postMessageToWebview: vi.fn(async () => {}),
			log: vi.fn(),
		}
		;(task as any).providerRef = { deref: () => provider }
		;(task as any).getTaskMode = vi.fn(async () => "code")
		;(task as any).agentContext = undefined
		;(task as any).didToolFailInCurrentTurn = false
		;(task as any).costLimit = undefined
		;(task as any).emitTaskInteraction = vi.fn(async () => {})
		;(task as any).timelineOriginMs = 0
	}

	it("withdraws the row when new_task names a mode that does not exist", async () => {
		const { task, askMessages } = buildTask()
		equipForNewTask(task)

		// The tool renders itself while its arguments stream.
		await task
			.ask("tool", JSON.stringify({ tool: "newTask", mode: "ask", content: "Summarise the repo" }), true)
			.catch(() => {})
		expect(askMessages().filter((m: ShoferMessage) => m.partial === true)).toHaveLength(1)

		// …and then the complete call executes and refuses.
		;(task as any).assistantMessageContent = [
			{
				type: "tool_use",
				id: "toolu_invalid_mode",
				name: "new_task",
				params: {},
				partial: false,
				nativeArgs: { mode: "ask", message: "Summarise the repo" },
			},
		]
		;(task as any).currentStreamingContentIndex = 0
		await presentAssistantMessage(task)
		for (let i = 0; i < 8; i++) await Promise.resolve()

		// Execution really did reach `execute()` and take the refusal branch —
		// otherwise this would be re-testing one of the pre-execute guards.
		const results = (task as any).userMessageContent as Array<{ content?: string }>
		expect(JSON.stringify(results)).toContain("Invalid mode: ask")

		const asks = askMessages()
		expect(asks).toHaveLength(1)

		// The regression: the row stayed `partial: true` for the life of the task.
		expect(asks.filter((m: ShoferMessage) => m.partial === true)).toHaveLength(0)
		expect(asks[0]!.abandoned).toBe(true)
		expect(asks[0]!.partial).toBe(false)
		expect(asks[0]!.isAnswered).toBeUndefined()
		expect(asks[0]!.autoApproved).toBeUndefined()
		expect(asks.filter(needsADecision)).toHaveLength(0)
	})

	it("leaves a call that DID raise its complete ask alone", async () => {
		const { task, askMessages } = buildTask()
		equipForNewTask(task)

		// A finalized ask — the shape `Task.ask(…, partial: false)` leaves behind
		// once the streamed row transitions. The guard must not touch it: it is
		// decided, and marking it `abandoned` would retract a real approval.
		;(task as any).shoferMessages.push({
			ts: Date.now(),
			type: "ask",
			ask: "tool",
			text: JSON.stringify({ tool: "newTask", mode: "code", content: "go" }),
			partial: false,
			askId: "ask-decided",
			autoApproved: true,
			isAnswered: true,
		})
		;(task as any).assistantMessageContent = [
			{
				type: "tool_use",
				id: "toolu_valid_mode",
				name: "new_task",
				params: {},
				partial: false,
				nativeArgs: { mode: "ask", message: "Summarise the repo" },
			},
		]
		;(task as any).currentStreamingContentIndex = 0
		await presentAssistantMessage(task)
		for (let i = 0; i < 8; i++) await Promise.resolve()

		const asks = askMessages()
		expect(asks).toHaveLength(1)
		expect(asks[0]!.abandoned).toBeUndefined()
		expect(asks[0]!.isAnswered).toBe(true)
	})
})
