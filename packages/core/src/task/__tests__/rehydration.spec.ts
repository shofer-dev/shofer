import { BUILTIN_MODES } from "../../__fixtures__/builtin-config.js"

vi.mock("../../ignore/ShoferIgnoreController.js", () => ({
	ShoferIgnoreController: class {
		validateAccess() {
			return true
		}
		validateCommand() {
			return undefined
		}
		filterPaths(paths: string[]) {
			return paths
		}
		getInstructions() {
			return undefined
		}
		async initialize() {}
		dispose() {}
	},
}))

vi.mock("../../utils/storage.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	getTaskDirectoryPath: vi.fn(async (root: string, taskId: string) => `${root}/tasks/${taskId}`),
	getSettingsDirectoryPath: vi.fn(async (root: string) => `${root}/settings`),
}))

/** What the persisted stores hold for the task under test. */
let persistedUiMessages: unknown[] = []
let persistedApiHistory: unknown[] = []

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	const stubs = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		appendFile: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
		readdir: vi.fn().mockResolvedValue([]),
	}
	return { ...actual, ...stubs, default: stubs }
})

vi.mock("delay", () => ({ __esModule: true, default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("p-wait-for", () => ({ default: vi.fn().mockImplementation(async () => Promise.resolve()) }))

vi.mock("../../environment/getEnvironmentDetails.js", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue("<environment_details>mock</environment_details>"),
}))

import {
	BASE_API_CONFIG,
	makeProvider,
	makeScriptedTask,
	resetScriptedEnvironment,
	type FakeProvider,
} from "./helpers/scriptedTask.js"

/**
 * REHYDRATION — bringing a task back from disk.
 *
 * The Preload-Before-Publish Rule is why `preloadShoferMessages` exists as its
 * own step: a rehydrated task must have its messages loaded BEFORE it is pushed
 * onto the provider's stack, or a concurrent `postStateToWebview` broadcasts an
 * empty snapshot and the chat renders the home screen.
 *
 * `resumeTaskFromHistory` then has to make the stored conversation SENDABLE
 * again, and that is mostly about interrupted tool calls: a turn that died
 * mid-tool leaves a `tool_use` with no `tool_result`, which a strict provider
 * answers with a 400. Every branch below synthesizes the missing results — and
 * the condensation summary is the one shape that must be left exactly alone,
 * because its metadata is what keeps the condensed messages filtered out.
 */

const STATE = {
	mode: "code",
	customModes: BUILTIN_MODES,
	autoApprovalEnabled: true,
	apiConfiguration: BASE_API_CONFIG,
}

let provider: FakeProvider

beforeEach(() => {
	vi.clearAllMocks()
	resetScriptedEnvironment()
	provider = makeProvider({ state: STATE })
	persistedUiMessages = []
	persistedApiHistory = []
})

/**
 * A `MessagePersistencePort` serving the two module-level arrays. Task reaches
 * its store through this port, so replacing it is the honest seam — the backend
 * behind it (JSONL files, SQLite, a remote store) is not what rehydration is
 * about.
 */
function fakePersistence() {
	const tail = <T>(rows: T[], max: number): [T[], boolean] =>
		rows.length > max ? [rows.slice(-max), true] : [[...rows], false]
	return {
		appendApiMessage: vi.fn().mockResolvedValue(undefined),
		readApiMessages: vi.fn(async () => [...persistedApiHistory] as never),
		readApiMessagesTail: vi.fn(async (_id: string, max: number) => tail(persistedApiHistory as never[], max)),
		saveApiMessages: vi.fn().mockResolvedValue(undefined),
		appendTaskMessage: vi.fn().mockResolvedValue(undefined),
		readTaskMessages: vi.fn(async () => [...persistedUiMessages] as never),
		readTaskMessagesTail: vi.fn(async (_id: string, max: number) => tail(persistedUiMessages as never[], max)),
		saveTaskMessages: vi.fn().mockResolvedValue(undefined),
		disposeAppendHandleForTask: vi.fn().mockResolvedValue(undefined),
	}
}

function build(taskOptions: Record<string, unknown> = {}) {
	const built = makeScriptedTask({ provider, taskOptions: { historyItem: { id: "task-1" }, ...taskOptions } })
	vi.spyOn(built.task as never as { getPersistence: () => Promise<unknown> }, "getPersistence").mockResolvedValue(
		fakePersistence() as never,
	)
	return built
}

const say = (sayType: string, text = "x") => ({ ts: Date.now(), type: "say", say: sayType, text })

describe("preloadShoferMessages", () => {
	it("loads both stores and marks the task preloaded, idempotently", async () => {
		persistedUiMessages = [say("text", "hello")]
		persistedApiHistory = [{ role: "user", content: [{ type: "text", text: "hello" }] }]
		const { task } = build()

		await task.preloadShoferMessages()
		expect(task.isHistoryPreloaded).toBe(true)
		expect(task.shoferMessages).toHaveLength(1)
		expect(task.apiConversationHistory).toHaveLength(1)

		// A second call is a no-op rather than a second read.
		await task.preloadShoferMessages()
		expect(task.shoferMessages).toHaveLength(1)
	})

	it("drops the resume asks a previous rehydration appended", async () => {
		persistedUiMessages = [
			say("text", "real content"),
			{ ts: 2, type: "ask", ask: "resume_task" },
			{ ts: 3, type: "ask", ask: "resume_task" },
		]
		const { task } = build()

		await task.preloadShoferMessages()

		expect(task.shoferMessages).toHaveLength(1)
	})

	it("drops trailing reasoning that never made it into the API conversation", async () => {
		persistedUiMessages = [say("text", "kept"), say("reasoning", "dangling"), say("reasoning", "also dangling")]
		const { task } = build()

		await task.preloadShoferMessages()

		expect(task.shoferMessages.map((m) => m.say)).toEqual(["text"])
	})

	it("reports whether more history remains when only a tail was read", async () => {
		persistedUiMessages = Array.from({ length: 20 }, (_, i) => say("text", `msg ${i}`))
		const { task } = build()

		await task.preloadShoferMessages(5)

		expect(task.shoferMessages.length).toBeLessThanOrEqual(5)
		expect(task.hasMoreShoferMessages).toBe(true)
	})
})

describe("resumeTaskFromHistory — making the stored conversation sendable", () => {
	/** Rehydrate and hand back the history the task will send. */
	async function resume(history: unknown[], ui: unknown[] = [say("text", "prior")]) {
		persistedApiHistory = history
		persistedUiMessages = ui
		const { task } = build()
		// The resume ask is answered by a queued message, which is the path a
		// caller rehydrating a task expressly to deliver one takes.
		task.messageQueueService.addMessage("carry on")
		vi.spyOn(task, "recursivelyMakeShoferRequests").mockResolvedValue(true)

		await (task as never as { resumeTaskFromHistory: () => Promise<void> }).resumeTaskFromHistory()
		return task
	}

	it("closes an assistant turn that died mid-tool-call", async () => {
		const task = await resume([
			{ role: "user", content: [{ type: "text", text: "go" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }] },
		])

		const results = task.apiConversationHistory.flatMap((m) =>
			Array.isArray(m.content) ? m.content.filter((b) => (b as { type: string }).type === "tool_result") : [],
		)
		expect(results).toHaveLength(1)
		expect(JSON.stringify(results[0])).toContain("interrupted before this tool call could be completed")
	})

	it("fills in only the tool results that are MISSING from a partial user turn", async () => {
		const task = await resume([
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "c1", name: "read_file", input: {} },
					{ type: "tool_use", id: "c2", name: "list_files", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] },
		])

		const ids = task.apiConversationHistory
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((b) => (b as { type: string }).type === "tool_result")
			.map((b) => (b as { tool_use_id: string }).tool_use_id)
		expect(new Set(ids)).toEqual(new Set(["c1", "c2"]))
	})

	it("leaves a condensation SUMMARY exactly as it was", async () => {
		const summary = {
			role: "assistant",
			content: [{ type: "text", text: "the summary" }],
			isSummary: true,
			condenseId: "cond-1",
		}
		const task = await resume([{ role: "user", content: [{ type: "text", text: "go" }] }, summary])

		// Rewriting it would strip the metadata `getEffectiveApiHistory` filters
		// on, un-condensing the whole conversation.
		expect(task.apiConversationHistory.at(-1)).toMatchObject({ isSummary: true, condenseId: "cond-1" })
	})

	it("handles an assistant turn that used no tools", async () => {
		const task = await resume([
			{ role: "user", content: [{ type: "text", text: "go" }] },
			{ role: "assistant", content: [{ type: "text", text: "just talking" }] },
		])

		expect(task.apiConversationHistory.length).toBeGreaterThan(0)
	})

	it("handles a trailing user turn with no preceding assistant", async () => {
		const task = await resume([{ role: "user", content: [{ type: "text", text: "only me" }] }])

		expect(task.apiConversationHistory.length).toBeGreaterThan(0)
	})

	it("takes a QUEUED message as the resume answer instead of raising an ask", async () => {
		persistedApiHistory = [{ role: "user", content: [{ type: "text", text: "go" }] }]
		persistedUiMessages = [say("text", "prior")]
		const { task } = build()
		task.messageQueueService.addMessage("carry on")
		const ask = vi.spyOn(task, "ask")
		vi.spyOn(task, "recursivelyMakeShoferRequests").mockResolvedValue(true)

		await (task as never as { resumeTaskFromHistory: () => Promise<void> }).resumeTaskFromHistory()

		// Publishing the ask costs a persist, a state broadcast and a round trip
		// on the latency-critical first hop of a follow-up turn.
		expect(ask).not.toHaveBeenCalledWith("resume_task", expect.anything())
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("raises resume_COMPLETED_task for a task that had finished", async () => {
		persistedApiHistory = [{ role: "user", content: [{ type: "text", text: "go" }] }]
		persistedUiMessages = [{ ts: 1, type: "ask", ask: "completion_result", text: "done" }]
		const { task } = build({ initialState: { lifecycle: "completed" } })
		const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "messageResponse", text: "again" } as never)
		vi.spyOn(task, "recursivelyMakeShoferRequests").mockResolvedValue(true)

		await (task as never as { resumeTaskFromHistory: () => Promise<void> }).resumeTaskFromHistory()

		// Called with the ask type alone — a resume ask carries no payload.
		expect(ask).toHaveBeenCalledWith("resume_completed_task")
	})

	it("refuses LOUDLY to resume a task with no stored conversation at all", async () => {
		// There is nothing to make sendable, and continuing would send a request
		// with an empty history — so this fails rather than degrading.
		persistedApiHistory = []
		persistedUiMessages = [say("text", "prior")]
		const { task } = build()
		task.messageQueueService.addMessage("carry on")

		await expect(
			(task as never as { resumeTaskFromHistory: () => Promise<void> }).resumeTaskFromHistory(),
		).rejects.toThrow(/No existing API conversation history/)
	})
})
