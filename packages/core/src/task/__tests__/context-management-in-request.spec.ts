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

vi.mock("../../environment/getEnvironmentDetails.js", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue("<environment_details>mock</environment_details>"),
}))

const manageContext = vi.fn()
vi.mock("../../context-management/index.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	manageContext: (...args: unknown[]) => manageContext(...args),
}))

import { getEnvironmentDetails } from "../../environment/getEnvironmentDetails.js"

import {
	BASE_API_CONFIG,
	drain,
	makeProvider,
	makeScriptedTask,
	resetScriptedEnvironment,
	type FakeProvider,
} from "./helpers/scriptedTask.js"

/**
 * In-request CONTEXT MANAGEMENT — the condensation/truncation pass
 * `attemptApiRequest` runs before it sends, and the recovery pass it runs after
 * the provider refuses an oversized request.
 *
 * The properties worth pinning are about what the USER sees and what the task
 * remembers, not about the summarizer itself:
 *
 *  - the spinner is symmetric. `condenseTaskContextStarted` is posted before the
 *    pass and `condenseTaskContextResponse` after it **even when the pass
 *    throws**, because a spinner nobody dismisses is indistinguishable from a
 *    hang;
 *  - a condensation that FAILED but whose sliding-window fallback succeeded is
 *    logged, not shown — the conversation continued, and an error row would
 *    alarm the user about a recovery that worked. With no fallback it IS shown;
 *  - the expensive inputs are only computed when the pass will actually run:
 *    the workspace digest is a recursive listing, so it must not be built for
 *    the common under-threshold turn.
 */

const STATE = {
	mode: "code",
	customModes: BUILTIN_MODES,
	autoApprovalEnabled: true,
	apiConfiguration: BASE_API_CONFIG,
	autoCondenseContext: true,
	autoCondenseContextPercent: 50,
}

let provider: FakeProvider

/** A task whose token usage is over the condensation threshold. */
function overThreshold(turns: NonNullable<Parameters<typeof makeScriptedTask>[0]>["turns"]) {
	const built = makeScriptedTask({
		provider,
		turns,
		// A small window plus a large reported usage is what trips the gate.
		api: { info: { contextWindow: 1000, maxTokens: 100 }, tokenCount: 10 },
	})
	vi.spyOn(built.task, "getTokenUsage").mockReturnValue({ contextTokens: 900 } as never)
	built.task.apiConversationHistory = [
		{ role: "user", content: [{ type: "text", text: "a".repeat(500) }] },
		{ role: "assistant", content: [{ type: "text", text: "b".repeat(500) }] },
	] as never
	return built
}

beforeEach(() => {
	vi.clearAllMocks()
	resetScriptedEnvironment()
	provider = makeProvider({ state: STATE })
	manageContext.mockResolvedValue({ messages: [], prevContextTokens: 900 })
})

const postedTypes = () =>
	provider.postMessageToWebview.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type)

describe("the pass runs only when it is needed", () => {
	it("skips the workspace digest entirely for an under-threshold turn", async () => {
		const { task } = makeScriptedTask({
			provider,
			turns: [{ chunks: [{ type: "text", text: "ok" } as never] }],
		})

		await drain(task.attemptApiRequest(0))

		// `getTokenUsage()` reports nothing, so context management never engages.
		expect(manageContext).not.toHaveBeenCalled()
		expect(vi.mocked(getEnvironmentDetails)).not.toHaveBeenCalled()
		expect(postedTypes()).not.toContain("condenseTaskContextStarted")
	})

	it("builds the digest and posts the spinner when the turn IS over the threshold", async () => {
		const { task } = overThreshold([{ chunks: [{ type: "text", text: "ok" } as never] }])

		await drain(task.attemptApiRequest(0))

		expect(manageContext).toHaveBeenCalled()
		expect(vi.mocked(getEnvironmentDetails)).toHaveBeenCalled()
		expect(postedTypes()).toContain("condenseTaskContextStarted")
		expect(postedTypes()).toContain("condenseTaskContextResponse")
	})

	it("hands the condenser the same tool catalog the request itself uses", async () => {
		const { task } = overThreshold([{ chunks: [{ type: "text", text: "ok" } as never] }])

		await drain(task.attemptApiRequest(0))

		const passed = manageContext.mock.calls[0]![0] as { metadata: { tools?: unknown[]; tool_choice?: string } }
		expect(passed.metadata.tool_choice).toBe("auto")
		expect(passed.metadata.tools!.length).toBeGreaterThan(0)
	})

	it("dismisses the spinner even when the pass throws", async () => {
		manageContext.mockRejectedValue(new Error("summarizer exploded"))
		const { task } = overThreshold([{ chunks: [{ type: "text", text: "ok" } as never] }])

		await expect(drain(task.attemptApiRequest(0))).rejects.toThrow("summarizer exploded")

		expect(postedTypes()).toContain("condenseTaskContextResponse")
	})
})

describe("what the user is told about the pass", () => {
	it("shows a condense_context row when a summary was produced", async () => {
		manageContext.mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "summary" }] }],
			summary: "we did some things",
			cost: 0.01,
			prevContextTokens: 900,
			newContextTokens: 100,
		})
		const { task } = overThreshold([{ chunks: [{ type: "text", text: "ok" } as never] }])

		await drain(task.attemptApiRequest(0))

		expect(task.shoferMessages.some((m) => m.say === "condense_context")).toBe(true)
	})

	it("shows a sliding_window_truncation row when the fallback was what ran", async () => {
		manageContext.mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "kept" }] }],
			truncationId: "trunc-1",
			messagesRemoved: 3,
			prevContextTokens: 900,
			newContextTokensAfterTruncation: 200,
		})
		const { task } = overThreshold([{ chunks: [{ type: "text", text: "ok" } as never] }])

		await drain(task.attemptApiRequest(0))

		expect(task.shoferMessages.some((m) => m.say === "sliding_window_truncation")).toBe(true)
	})

	it("stays SILENT about a condensation failure the fallback already covered", async () => {
		manageContext.mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "kept" }] }],
			error: "summarizer refused",
			truncationId: "trunc-1",
			messagesRemoved: 2,
			prevContextTokens: 900,
		})
		const { task } = overThreshold([{ chunks: [{ type: "text", text: "ok" } as never] }])

		await drain(task.attemptApiRequest(0))

		// The conversation continued, so the user gets the truncation row and no
		// alarming error about a recovery that worked.
		expect(task.shoferMessages.some((m) => m.say === "condense_context_error")).toBe(false)
		expect(task.shoferMessages.some((m) => m.say === "sliding_window_truncation")).toBe(true)
	})

	it("SURFACES a condensation failure that had no fallback", async () => {
		manageContext.mockResolvedValue({ messages: [], error: "summarizer refused", prevContextTokens: 900 })
		const { task } = overThreshold([{ chunks: [{ type: "text", text: "ok" } as never] }])

		await drain(task.attemptApiRequest(0))

		expect(task.shoferMessages.some((m) => m.say === "condense_context_error")).toBe(true)
	})

	it("drops the loaded-skill set, because the instructions left the history", async () => {
		manageContext.mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "summary" }] }],
			summary: "s",
			prevContextTokens: 900,
			newContextTokens: 10,
		})
		const { task } = overThreshold([{ chunks: [{ type: "text", text: "ok" } as never] }])
		task.loadedSkills.set("verify-mermaid", "/skills/verify-mermaid/SKILL.md")

		await drain(task.attemptApiRequest(0))

		expect(task.loadedSkills.size).toBe(0)
	})

	it("replaces the history only when the pass actually changed it", async () => {
		const { task } = overThreshold([{ chunks: [{ type: "text", text: "ok" } as never] }])
		const original = task.apiConversationHistory
		manageContext.mockResolvedValue({ messages: original, prevContextTokens: 900 })
		const overwrite = vi.spyOn(task, "overwriteApiConversationHistory")

		await drain(task.attemptApiRequest(0))

		expect(overwrite).not.toHaveBeenCalled()
	})
})
