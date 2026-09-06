// npx vitest src/core/webview/__tests__/timelineRewindHandler.test.ts

/**
 * Timeline rewind — "take this conversation back to an earlier message".
 *
 * The ORDERING is the whole design, and it is invisible when it breaks: plugins
 * are told BEFORE the messages disappear, because a plugin's state (a workspace
 * snapshot, an external job) is anchored to a message, and a plugin that rolled
 * back afterwards would be restoring to an anchor the host has already
 * forgotten. Nothing throws when that order is reversed — the restore simply
 * lands somewhere else.
 *
 * Three more decisions are pinned here because each has a plausible-looking
 * wrong answer:
 *
 *  - **A chat-only rewind (`restoreState: false`) does NOT reinitialize the
 *    task.** It only lost messages, so re-running it would restart work the user
 *    did not ask to redo — plugins are still told so they can drop anchors.
 *  - **An EDIT does not abort the task itself**; it stashes a pending edit and
 *    cancels, and the reinitialization that follows is what applies it. Aborting
 *    here as well would destroy the task the pending edit is meant to restart.
 *  - **A failure is re-thrown after being reported.** The caller is a webview
 *    message handler that must not answer "done" to a rewind that did not
 *    happen.
 */

const hoisted = vi.hoisted(() => ({
	notifyTimelineRewind: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	saveTaskMessages: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	notifierError: vi.fn(),
	logs: [] as string[],
	/** Every step that mutates or reports, in the order it happened. */
	order: [] as string[],
}))

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn(async (predicate: () => boolean) => {
		if (!predicate()) throw new Error("timed out")
	}),
}))

vi.mock("../ShoferProvider", () => ({ ShoferProvider: class {} }))

vi.mock("../../task-persistence", () => ({
	saveTaskMessages: (...args: unknown[]) => {
		hoisted.order.push("saveMessages")
		return hoisted.saveTaskMessages(...args)
	},
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	Task: class {},
	pluginRegistry: {
		notifyTimelineRewind: (...args: unknown[]) => {
			hoisted.order.push("notifyPlugins")
			return hoisted.notifyTimelineRewind(...args)
		},
	},
	webviewLog: {
		error: (m: string) => hoisted.logs.push(m),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}))

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({ notifier: { error: hoisted.notifierError, warn: vi.fn(), info: vi.fn() } }),
}))

import { handleTimelineRewind, type TimelineRewindConfig } from "../timelineRewindHandler"

function makeTask(overrides: Record<string, unknown> = {}) {
	return {
		taskId: "t-1",
		abort: false,
		shoferMessages: [{ ts: 1 }, { ts: 2 }],
		abortTask: vi.fn(function (this: { abort: boolean }) {
			hoisted.order.push("abortTask")
			this.abort = true
		}),
		messageManager: {
			rewindToTimestamp: vi.fn(async (..._args: unknown[]) => {
				hoisted.order.push("truncate")
			}),
		},
		...overrides,
	}
}

function makeProvider(overrides: Record<string, unknown> = {}) {
	return {
		contextProxy: { globalStorageUri: { fsPath: "/global" } },
		setPendingEditOperation: vi.fn(() => hoisted.order.push("setPendingEdit")),
		cancelTask: vi.fn(async () => void hoisted.order.push("cancelTask")),
		getTaskWithId: vi.fn(async () => ({ historyItem: { id: "t-1", ts: 1 } })),
		createTaskWithHistoryItem: vi.fn(async () => void hoisted.order.push("reinitialize")),
		postInitState: vi.fn(async () => void hoisted.order.push("postInitState")),
		...overrides,
	}
}

function makeConfig(overrides: Partial<TimelineRewindConfig> = {}): TimelineRewindConfig {
	return {
		provider: makeProvider() as never,
		currentShofer: makeTask() as never,
		messageTs: 2,
		messageIndex: 1,
		operation: "delete",
		restoreState: true,
		...overrides,
	} as TimelineRewindConfig
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.order = []
	hoisted.logs = []
})

describe("the plugins-first ordering", () => {
	it("tells plugins BEFORE the messages they anchored to are truncated", async () => {
		await handleTimelineRewind(makeConfig())

		expect(hoisted.order.indexOf("notifyPlugins")).toBeLessThan(hoisted.order.indexOf("truncate"))
	})

	it("passes plugins the anchor, the task and WHETHER out-of-band state should come back", async () => {
		await handleTimelineRewind(makeConfig({ restoreState: false }))

		expect(hoisted.notifyTimelineRewind).toHaveBeenCalledWith({
			ts: 2,
			taskId: "t-1",
			operation: "delete",
			restoreState: false,
		})
	})

	it("still tells plugins on a CHAT-ONLY rewind, so they can drop their anchors", async () => {
		await handleTimelineRewind(makeConfig({ restoreState: false }))

		expect(hoisted.notifyTimelineRewind).toHaveBeenCalled()
	})
})

describe("a delete rewind", () => {
	it("aborts the running task first when out-of-band state is coming back", async () => {
		const task = makeTask()
		await handleTimelineRewind(makeConfig({ currentShofer: task as never }))

		expect(task.abortTask).toHaveBeenCalled()
		expect(hoisted.order.indexOf("abortTask")).toBeLessThan(hoisted.order.indexOf("truncate"))
	})

	it("does NOT abort a task that has already aborted", async () => {
		const task = makeTask({ abort: true })

		await handleTimelineRewind(makeConfig({ currentShofer: task as never }))

		expect(task.abortTask).not.toHaveBeenCalled()
	})

	it("does not abort for a CHAT-ONLY rewind — nothing outside the conversation moved", async () => {
		const task = makeTask()

		await handleTimelineRewind(makeConfig({ currentShofer: task as never, restoreState: false }))

		expect(task.abortTask).not.toHaveBeenCalled()
	})

	it("KEEPS the target message — a delete rewinds TO it", async () => {
		const task = makeTask()

		await handleTimelineRewind(makeConfig({ currentShofer: task as never }))

		expect(task.messageManager.rewindToTimestamp).toHaveBeenCalledWith(2, { includeTargetMessage: false })
	})

	it("persists the truncated history and REINITIALIZES when state was rolled back", async () => {
		const provider = makeProvider()

		await handleTimelineRewind(makeConfig({ provider: provider as never }))

		expect(hoisted.saveTaskMessages).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "t-1", globalStoragePath: "/global" }),
		)
		expect(provider.createTaskWithHistoryItem).toHaveBeenCalled()
		expect(provider.postInitState).not.toHaveBeenCalled()
	})

	it("only RE-RENDERS for a chat-only rewind — restarting work nobody asked to redo is the bug", async () => {
		const provider = makeProvider()

		await handleTimelineRewind(makeConfig({ provider: provider as never, restoreState: false }))

		expect(provider.postInitState).toHaveBeenCalled()
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("proceeds even when the abort never settles within the timeout", async () => {
		const task = makeTask({ abortTask: vi.fn(() => undefined) })

		await expect(handleTimelineRewind(makeConfig({ currentShofer: task as never }))).resolves.toBeUndefined()

		expect(task.messageManager.rewindToTimestamp).toHaveBeenCalled()
	})
})

describe("an edit rewind", () => {
	const editData = { editedContent: "the corrected prompt", images: ["img"], apiConversationHistoryIndex: 3 }

	it("stashes the pending edit for the reinitialization to apply", async () => {
		const provider = makeProvider()

		await handleTimelineRewind(makeConfig({ provider: provider as never, operation: "edit", editData }))

		expect(provider.setPendingEditOperation).toHaveBeenCalledWith("task-t-1", {
			messageTs: 2,
			editedContent: "the corrected prompt",
			images: ["img"],
			messageIndex: 1,
			apiConversationHistoryIndex: 3,
		})
	})

	it("DROPS the target message — the edited text replaces it", async () => {
		const task = makeTask()

		await handleTimelineRewind(makeConfig({ currentShofer: task as never, operation: "edit", editData }))

		expect(task.messageManager.rewindToTimestamp).toHaveBeenCalledWith(2, { includeTargetMessage: true })
	})

	it("cancels rather than aborting, and does not persist or re-render itself", async () => {
		const task = makeTask()
		const provider = makeProvider()

		await handleTimelineRewind(
			makeConfig({ provider: provider as never, currentShofer: task as never, operation: "edit", editData }),
		)

		// The pending-edit reinitialization does the cancelling; a second abort
		// here would destroy the task that edit is meant to restart.
		expect(task.abortTask).not.toHaveBeenCalled()
		expect(provider.cancelTask).toHaveBeenCalled()
		expect(hoisted.saveTaskMessages).not.toHaveBeenCalled()
		expect(provider.postInitState).not.toHaveBeenCalled()
	})

	it("falls through to the delete path when the edit carries no data", async () => {
		const provider = makeProvider()

		await handleTimelineRewind(makeConfig({ provider: provider as never, operation: "edit" }))

		expect(provider.setPendingEditOperation).not.toHaveBeenCalled()
		expect(provider.cancelTask).toHaveBeenCalled()
	})
})

describe("failure", () => {
	it("REPORTS to the user and RE-THROWS — the caller must not answer 'done'", async () => {
		hoisted.notifyTimelineRewind.mockRejectedValueOnce(new Error("snapshot restore failed"))

		await expect(handleTimelineRewind(makeConfig())).rejects.toThrow("snapshot restore failed")

		expect(hoisted.notifierError).toHaveBeenCalledWith(expect.stringContaining("snapshot restore failed"))
		expect(hoisted.logs.join(" ")).toContain("Error in timeline rewind")
	})
})
