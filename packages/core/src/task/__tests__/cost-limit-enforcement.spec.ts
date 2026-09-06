import * as os from "os"
import * as path from "path"

import type { ProviderSettings } from "@shofer/types"
import { createInMemoryHost, setHost } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

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
	}
	return { ...actual, ...stubs, default: stubs }
})

import { Task } from "../Task.js"

/**
 * The per-ROOT cost cap, exercised on real `Task` instances rather than on a
 * structural shim — the algorithm was already pinned that way, but the
 * behaviour around it (which gate latches, what a pause actually does, how a
 * subtask's spend rolls up) is only true of the real object.
 *
 * The design's load-bearing points:
 *
 *  - the limit belongs to the ROOT of the task tree, so a subtask spends the
 *    root's budget and enforcing it winds the whole tree down;
 *  - there are TWO gates — the post-request one and the in-flight one that
 *    fires on a `usage` chunk — and the in-flight gate exists because a single
 *    expensive completion can blow a tight cap before the request ends. Both
 *    delegate to one enforcement step so they cannot drift;
 *  - "continue without limit" is a real answer: it BYPASSES the cap for the
 *    rest of the task rather than deferring it, and every later check must
 *    honour that.
 */

const BASE_CONFIG: ProviderSettings = {
	apiProvider: "anthropic",
	apiModelId: "claude-3-5-sonnet-20241022",
	apiKey: "test-api-key",
}

/**
 * The provider is duck-typed with spies rather than typed as `TaskProviderLike`:
 * the tests read `log` and `updateTaskHistory` back off it, and those are
 * optional on the interface.
 */

let provider: any

/** History rows keyed by task id, as `aggregateTaskCostsRecursive` reads them. */
function seedHistory(rows: Record<string, { totalCost?: number; childTaskIds?: string[] }>) {
	provider.getTaskWithId.mockImplementation(async (id: string) => {
		const row = rows[id]
		if (!row) throw new Error(`no such task ${id}`)
		return { historyItem: { id, ...row } }
	})
}

function makeTask(overrides: Record<string, unknown> = {}): Task {
	return new Task({
		provider: provider as never,
		apiConfiguration: BASE_CONFIG,
		task: "spend money",
		startTask: false,
		...overrides,
	} as never)
}

beforeEach(() => {
	vi.clearAllMocks()
	setHost(createInMemoryHost())
	if (!TelemetryService.hasInstance()) {
		TelemetryService.createInstance([])
	}

	provider = {
		context: { globalStorageUri: { fsPath: path.join(os.tmpdir(), "shofer-cost-limit") } },
		getState: vi.fn().mockResolvedValue({}),
		log: vi.fn(),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postTaskStateUpdate: vi.fn(),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue([]),
		getTaskWithId: vi.fn(),
	}
})

const checkCostLimit = (task: Task, requestIndex: number) =>
	(task as never as { checkCostLimit: (i: number) => Promise<void> }).checkCostLimit(requestIndex)

const snapshotPrior = (task: Task) =>
	(task as never as { snapshotPriorAggregateForCostLimit: () => Promise<void> }).snapshotPriorAggregateForCostLimit()

const checkInFlight = (task: Task, cost: number | undefined) =>
	(task as never as { checkInFlightCostLimit: (c: number | undefined) => Promise<void> }).checkInFlightCostLimit(cost)

describe("the cost cap belongs to the root of the tree", () => {
	it("resolves a subtask's limit from its root and spends the root's budget", async () => {
		const root = makeTask()
		root.costLimit = { maxUsd: 1, action: "abort" }
		const child = makeTask()
		;(child as never as { parentTask?: Task }).parentTask = root
		seedHistory({ [root.taskId]: { totalCost: 5, childTaskIds: [] } })

		const abortRoot = vi.spyOn(root, "abortTask").mockResolvedValue(undefined)
		const abortChild = vi.spyOn(child, "abortTask").mockResolvedValue(undefined)

		await checkCostLimit(child, 1)

		// Both the spender and the root wind down — the whole tree stops.
		expect(abortChild).toHaveBeenCalledWith(false)
		expect(abortRoot).toHaveBeenCalledWith(false)
	})

	it("does nothing when no limit is configured, or when the limit is not positive", async () => {
		const noLimit = makeTask()
		seedHistory({ [noLimit.taskId]: { totalCost: 999 } })
		const abort = vi.spyOn(noLimit, "abortTask").mockResolvedValue(undefined)

		await checkCostLimit(noLimit, 1)
		expect(abort).not.toHaveBeenCalled()

		noLimit.costLimit = { maxUsd: 0, action: "abort" }
		await checkCostLimit(noLimit, 2)
		expect(abort).not.toHaveBeenCalled()
	})

	it("does nothing while spend is under the cap", async () => {
		const task = makeTask()
		task.costLimit = { maxUsd: 10, action: "abort" }
		seedHistory({ [task.taskId]: { totalCost: 2 } })
		const abort = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)

		await checkCostLimit(task, 1)

		expect(abort).not.toHaveBeenCalled()
	})

	it("does not fail the turn when the history scan fails", async () => {
		const task = makeTask()
		task.costLimit = { maxUsd: 1, action: "abort" }
		provider.getTaskWithId.mockRejectedValue(new Error("history unreadable"))
		const abort = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)

		await expect(checkCostLimit(task, 1)).resolves.toBeUndefined()
		expect(abort).not.toHaveBeenCalled()
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("aggregate failed"))
	})

	it("caches the answer per request index and re-checks on the next one", async () => {
		const task = makeTask()
		task.costLimit = { maxUsd: 10, action: "abort" }
		seedHistory({ [task.taskId]: { totalCost: 1 } })

		await checkCostLimit(task, 1)
		await checkCostLimit(task, 1)
		expect(provider.getTaskWithId).toHaveBeenCalledTimes(1)

		await checkCostLimit(task, 2)
		expect(provider.getTaskWithId).toHaveBeenCalledTimes(2)
	})
})

describe("enforcement action", () => {
	async function enforce(action: "abort" | "kill" | "pause", askResponse?: Record<string, unknown>) {
		const task = makeTask()
		task.costLimit = { maxUsd: 1, action }
		seedHistory({ [task.taskId]: { totalCost: 5 } })
		const abort = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)
		const cancel = vi.spyOn(task, "cancelCurrentRequest").mockImplementation(() => {})
		const ask = vi.spyOn(task, "ask").mockResolvedValue((askResponse ?? {}) as never)

		await checkCostLimit(task, 1)
		return { task, abort, cancel, ask }
	}

	it("abort cancels the in-flight request first, then aborts cleanly", async () => {
		const { abort, cancel } = await enforce("abort")

		expect(cancel).toHaveBeenCalled()
		expect(abort).toHaveBeenCalledWith(false)
	})

	it("kill aborts as ABANDONED, which is what a headless run needs", async () => {
		const { abort } = await enforce("kill")

		expect(abort).toHaveBeenCalledWith(true)
	})

	it("pause asks the user, carrying the spend and the cap in the payload", async () => {
		const { ask, abort } = await enforce("pause", { response: "yesButtonClicked" })

		expect(ask).toHaveBeenCalledWith("budget_limit", expect.any(String))
		expect(JSON.parse(ask.mock.calls[0]![1] as string)).toEqual({
			spentUsd: 5,
			limitUsd: 1,
			action: "pause",
		})
		expect(abort).not.toHaveBeenCalled()
	})

	it("still enforces when cancelling the in-flight request throws", async () => {
		const task = makeTask()
		task.costLimit = { maxUsd: 1, action: "abort" }
		seedHistory({ [task.taskId]: { totalCost: 5 } })
		vi.spyOn(task, "cancelCurrentRequest").mockImplementation(() => {
			throw new Error("no request")
		})
		const abort = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)

		await checkCostLimit(task, 1)

		expect(abort).toHaveBeenCalledWith(false)
	})
})

describe("the pause dialog's three answers", () => {
	async function answer(response: string, text?: string) {
		const task = makeTask()
		task.costLimit = { maxUsd: 1, action: "pause" }
		seedHistory({ [task.taskId]: { totalCost: 5 } })
		const abort = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)
		vi.spyOn(task, "ask").mockResolvedValue({ response, text } as never)

		await checkCostLimit(task, 1)
		return { task, abort }
	}

	it("'continue without limit' bypasses the cap for the rest of the task", async () => {
		const { task, abort } = await answer("yesButtonClicked")

		expect(abort).not.toHaveBeenCalled()
		// Every later check is a no-op, even at a higher spend.
		seedHistory({ [task.taskId]: { totalCost: 500 } })
		await checkCostLimit(task, 2)
		expect(abort).not.toHaveBeenCalled()
	})

	it("'abort task' aborts the root cleanly", async () => {
		const { abort } = await answer("noButtonClicked")

		expect(abort).toHaveBeenCalledWith(false)
	})

	it("a typed dollar amount becomes the new cap and is persisted", async () => {
		const { task, abort } = await answer("messageResponse", "$2.50")

		expect(task.costLimit).toEqual({ maxUsd: 2.5, action: "pause" })
		expect(provider.updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ costLimit: { maxUsd: 2.5, action: "pause" } }),
		)
		expect(abort).not.toHaveBeenCalled()
	})

	it.each([["not a number"], [""], ["-1"], ["0"]])(
		"treats the unparsable amount %j as 'continue without limit'",
		async (text) => {
			const { task, abort } = await answer("messageResponse", text)

			expect(abort).not.toHaveBeenCalled()
			expect(task.costLimit).toEqual({ maxUsd: 1, action: "pause" })
			// Bypassed rather than silently re-asked on the next request.
			seedHistory({ [task.taskId]: { totalCost: 500 } })
			await checkCostLimit(task, 2)
			expect(abort).not.toHaveBeenCalled()
		},
	)

	it("does not fail the answer when persisting the new cap throws", async () => {
		const task = makeTask()
		task.costLimit = { maxUsd: 1, action: "pause" }
		seedHistory({ [task.taskId]: { totalCost: 5 } })
		provider.updateTaskHistory = vi.fn().mockRejectedValue(new Error("disk gone")) as never
		vi.spyOn(task, "ask").mockResolvedValue({ response: "messageResponse", text: "3" } as never)

		await expect(checkCostLimit(task, 1)).resolves.toBeUndefined()
		expect(task.costLimit).toEqual({ maxUsd: 3, action: "pause" })
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("persist failed"))
	})
})

describe("the in-flight gate", () => {
	async function primed(maxUsd = 1, priorCost = 0.5) {
		const task = makeTask()
		task.costLimit = { maxUsd, action: "abort" }
		seedHistory({ [task.taskId]: { totalCost: priorCost } })
		await snapshotPrior(task)
		const abort = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)
		vi.spyOn(task, "cancelCurrentRequest").mockImplementation(() => {})
		return { task, abort }
	}

	it("fires as soon as prior spend plus this request crosses the cap", async () => {
		const { task, abort } = await primed(1, 0.5)

		await checkInFlight(task, 0.4)
		expect(abort).not.toHaveBeenCalled()

		await checkInFlight(task, 0.6)
		expect(abort).toHaveBeenCalledWith(false)
	})

	it("LATCHES, so later chunks of the same request do not re-enforce", async () => {
		const { task, abort } = await primed(1, 0.9)

		await checkInFlight(task, 0.5)
		await checkInFlight(task, 0.9)

		expect(abort).toHaveBeenCalledTimes(1)
	})

	it("is a no-op without a prior snapshot, or with an unusable cost", async () => {
		const task = makeTask()
		task.costLimit = { maxUsd: 1, action: "abort" }
		const abort = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)

		// No snapshot taken yet.
		await checkInFlight(task, 99)
		expect(abort).not.toHaveBeenCalled()

		seedHistory({ [task.taskId]: { totalCost: 0.5 } })
		await snapshotPrior(task)
		await checkInFlight(task, undefined)
		await checkInFlight(task, Number.NaN)
		expect(abort).not.toHaveBeenCalled()
	})

	it("takes no snapshot when the cap was already bypassed", async () => {
		const task = makeTask()
		task.costLimit = { maxUsd: 1, action: "pause" }
		seedHistory({ [task.taskId]: { totalCost: 5 } })
		vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" } as never)
		await checkCostLimit(task, 1)

		provider.getTaskWithId.mockClear()
		await snapshotPrior(task)

		expect(provider.getTaskWithId).not.toHaveBeenCalled()
	})

	it("leaves the gate off when the history scan fails at the request boundary", async () => {
		const task = makeTask()
		task.costLimit = { maxUsd: 1, action: "abort" }
		provider.getTaskWithId.mockRejectedValue(new Error("history unreadable"))
		const abort = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)

		await snapshotPrior(task)
		await checkInFlight(task, 99)

		expect(abort).not.toHaveBeenCalled()
	})

	it("re-arms the latch at the next request boundary", async () => {
		const { task, abort } = await primed(1, 0.9)
		await checkInFlight(task, 0.5)
		expect(abort).toHaveBeenCalledTimes(1)

		await snapshotPrior(task)
		await checkInFlight(task, 0.5)

		expect(abort).toHaveBeenCalledTimes(2)
	})
})

describe("invalidateCostLimitCache", () => {
	it("clears the cached spend and the bypass, so a live limit edit takes effect", async () => {
		const task = makeTask()
		task.costLimit = { maxUsd: 1, action: "pause" }
		seedHistory({ [task.taskId]: { totalCost: 5 } })
		vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" } as never)
		await checkCostLimit(task, 1)

		task.invalidateCostLimitCache()

		const abort = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)
		task.costLimit = { maxUsd: 1, action: "abort" }
		vi.spyOn(task, "cancelCurrentRequest").mockImplementation(() => {})
		await checkCostLimit(task, 1)

		expect(abort).toHaveBeenCalledWith(false)
	})
})
