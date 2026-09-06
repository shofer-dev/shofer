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

// The loop parks on `pWaitFor(() => this.userMessageContentReady)` between the
// stream ending and the next turn; in-process that is resolved by the tool
// dispatcher completing. Resolving it immediately is what the other Task specs
// do — it keeps the test about the CONSUMER rather than about the dispatcher's
// scheduling.
vi.mock("p-wait-for", () => ({ default: vi.fn().mockImplementation(async () => Promise.resolve()) }))

// The workspace digest shells out to ripgrep; the loop only needs it to exist.
vi.mock("../../environment/getEnvironmentDetails.js", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue("<environment_details>mock</environment_details>"),
}))

import { ShoferEventName } from "@shofer/types"

import {
	BASE_API_CONFIG,
	makeProvider,
	makeScriptedTask,
	resetScriptedEnvironment,
	type FakeProvider,
} from "./helpers/scriptedTask.js"

/**
 * The agent loop's STREAM CONSUMER — `recursivelyMakeShoferRequests` driven over
 * a real `attemptApiRequest`, with the provider client as the only fake.
 *
 * This is the half of the loop that turns provider chunks into task state, and
 * every chunk kind is a separate contract:
 *
 *  - `text` accumulates into ONE partial block that is updated in place, not a
 *    block per chunk — the block carries a stable id precisely so the streaming
 *    → finalization handoff does not render "Shofer said" twice;
 *  - `tool_call_partial` is reassembled by the task's OWN parser instance (one
 *    per task, so two concurrently streaming tasks cannot splice each other's
 *    arguments), and a DUPLICATE `tool_call_start` for an id already seen is
 *    dropped — two `tool_use` blocks with one id is an API 400;
 *  - `usage` is the in-flight cost gate's trigger, and the gate must be awaited
 *    so an abort lands before the next chunk is pulled;
 *  - `response_metadata` merges into the `api_req_started` entry immediately, so
 *    the failover the router performed is visible while the turn is still live.
 */

const STATE = {
	mode: "code",
	customModes: BUILTIN_MODES,
	autoApprovalEnabled: true,
	apiConfiguration: BASE_API_CONFIG,
	alwaysAllowSubtasks: true,
}

let provider: FakeProvider

beforeEach(() => {
	vi.clearAllMocks()
	resetScriptedEnvironment()
	provider = makeProvider({ state: STATE })
})

function build(opts: Parameters<typeof makeScriptedTask>[0] = {}) {
	const built = makeScriptedTask({ provider, ...opts })
	// Running out of scripted turns unwinds the loop through the non-retryable
	// path, which tears the task down; the teardown itself is not what these
	// tests are about, so it is neutered.
	vi.spyOn(built.task, "dispose").mockImplementation(() => {})
	return built
}

const USER = [{ type: "text" as const, text: "do the thing" }]

/**
 * Drive ONE turn. The agentic loop re-requests after a tool-free reply, so a
 * single-turn script always ends by unwinding — that unwinding is the harness's
 * stop signal, not a failure, and the state it leaves behind is what the tests
 * assert on.
 */
async function runTurn(task: import("../Task.js").Task): Promise<void> {
	await task.recursivelyMakeShoferRequests(USER, false).catch(() => {})
}

/** Stream a complete native tool call the way a provider does. */
function toolCallChunks(id: string, name: string, args: Record<string, unknown>) {
	const json = JSON.stringify(args)
	return [
		{ type: "tool_call_partial", index: 0, id, name, arguments: undefined },
		{ type: "tool_call_partial", index: 0, id: undefined, name: undefined, arguments: json },
		{ type: "tool_call_end", id },
	] as never[]
}

describe("the stream consumer — text", () => {
	it("accumulates text chunks into ONE assistant turn, not one per chunk", async () => {
		const { task } = build({
			turns: [
				{
					chunks: [
						{ type: "text", text: "Hello, " },
						{ type: "text", text: "world." },
					] as never,
				},
				{ chunks: toolCallChunks("call-1", "attempt_completion", { result: "done" }) },
			],
		})

		await runTurn(task)

		const assistantTexts = task.apiConversationHistory
			.filter((m) => m.role === "assistant")
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((b) => (b as { type: string }).type === "text")
			.map((b) => (b as { text: string }).text)

		expect(assistantTexts).toContain("Hello, world.")
		// One block for the whole reply — the chunks were merged in place.
		expect(assistantTexts.filter((t) => t.startsWith("Hello"))).toHaveLength(1)
	})

	it("nudges a tool-free reply on the agentic path, and re-requests with the nudge", async () => {
		const { task, api } = build({ turns: [{ chunks: [{ type: "text", text: "no tool here" }] as never }] })

		await runTurn(task)

		// The loop does not end on a tool-free reply: it asks again, carrying the
		// nudge as the next user turn.
		expect(api.calls).toHaveLength(2)
		expect(JSON.stringify(api.calls[1]!.messages)).toContain("did not use a tool")
	})

	it("records the assistant turn in the API history", async () => {
		const { task } = build({ turns: [{ chunks: [{ type: "text", text: "an answer" }] as never }] })

		await runTurn(task)

		const assistant = task.apiConversationHistory.filter((m) => m.role === "assistant")
		expect(JSON.stringify(assistant)).toContain("an answer")
	})
})

describe("the stream consumer — reasoning", () => {
	it("streams reasoning as a partial say, breaking a run-on section header", async () => {
		const { task } = build({
			turns: [
				{
					chunks: [
						{ type: "reasoning", text: "First I check the file." },
						{ type: "reasoning", text: "**Next step**" },
						{ type: "text", text: "done thinking" },
					] as never,
				},
			],
		})

		await runTurn(task)

		const reasoning = task.shoferMessages.filter((m) => m.say === "reasoning")
		expect(reasoning.length).toBeGreaterThan(0)
		// The formatter inserts a break after sentence-ending punctuation so the
		// header does not run on from the previous sentence.
		expect(reasoning.at(-1)!.text).toContain("file.\n\n**Next step**")
	})
})

describe("the stream consumer — usage and cost", () => {
	it("records the turn's usage onto its own api_req_started entry", async () => {
		const { task } = build({
			turns: [
				{
					chunks: [
						{ type: "usage", inputTokens: 100, outputTokens: 10, cacheWriteTokens: 5, cacheReadTokens: 3 },
						{ type: "text", text: "ok" },
					] as never,
				},
				{ chunks: toolCallChunks("call-1", "attempt_completion", { result: "done" }) },
			],
		})

		await runTurn(task)

		const payload = JSON.parse(task.shoferMessages.find((m) => m.say === "api_req_started")!.text!)
		expect(payload.tokensIn).toBeGreaterThanOrEqual(100)
		expect(payload.cacheWrites).toBe(5)
		expect(payload.cacheReads).toBe(3)
	})

	it("enforces the cost cap MID-STREAM rather than waiting for the request to end", async () => {
		const capped = makeProvider({ state: STATE, history: { root: { totalCost: 0 } } })
		const { task } = makeScriptedTask({
			provider: capped,
			turns: [
				{
					chunks: [
						{ type: "usage", inputTokens: 1, outputTokens: 1, totalCost: 5 },
						{ type: "text", text: "should never be reached" },
					] as never,
				},
			],
		})
		capped.getTaskWithId.mockResolvedValue({ historyItem: { id: task.taskId, totalCost: 0 } })
		task.costLimit = { maxUsd: 1, action: "abort" }
		const abort = vi.spyOn(task, "abortTask").mockImplementation(async () => {
			task.abort = true
		})

		await runTurn(task)

		expect(abort).toHaveBeenCalled()
	})
})

describe("the stream consumer — router diagnostics and progress rows", () => {
	it("merges response_metadata into api_req_started while the turn is still live", async () => {
		const { task } = build({
			turns: [
				{
					chunks: [
						{
							type: "response_metadata",
							actualModel: "claude-sonnet-4",
							ttfbMs: 120,
							ttlbMs: 900,
							attempts: 2,
						},
						{ type: "text", text: "ok" },
					] as never,
				},
			],
		})

		await runTurn(task)

		const payload = JSON.parse(task.shoferMessages.find((m) => m.say === "api_req_started")!.text!)
		expect(payload.actualModel).toBe("claude-sonnet-4")
		expect(payload.attempts).toBe(2)
	})

	it("renders a tool_preparing row while arguments stream, then dismisses it", async () => {
		const { task } = build({
			turns: [
				{
					chunks: [
						{ type: "tool_preparing", toolName: "read_file", byteCount: 12 },
						...toolCallChunks("call-1", "read_file", { path: "a.ts" }),
					] as never,
				},
			],
		})

		await runTurn(task)

		expect(task.shoferMessages.some((m) => m.say === "tool_preparing")).toBe(true)
	})

	it("collects grounding sources without putting them in the assistant content", async () => {
		const { task } = build({
			turns: [
				{
					chunks: [
						{ type: "grounding", sources: [{ title: "Docs", url: "https://example.com" }] },
						{ type: "text", text: "per the docs" },
					] as never,
				},
			],
		})

		await runTurn(task)

		expect(JSON.stringify(task.assistantMessageContent)).not.toContain("https://example.com")
		expect(task.shoferMessages.some((m) => m.say === "text" || m.say === "completion_result")).toBe(true)
	})
})

describe("the stream consumer — native tool calls", () => {
	it("reassembles a streamed tool call into a typed tool_use block with its arguments", async () => {
		const { task } = build({
			turns: [{ chunks: toolCallChunks("call-1", "read_file", { path: "src/a.ts" }) }],
		})

		await runTurn(task)

		const toolUse = task.assistantMessageContent.find((b) => b.type === "tool_use") as {
			name: string
			id: string
			nativeArgs?: { path?: string }
		}
		expect(toolUse).toMatchObject({ name: "read_file", id: "call-1" })
		// The arguments arrived as a separate fragment and were reassembled.
		expect(toolUse.nativeArgs?.path).toBe("src/a.ts")
	})

	it("writes the reassembled call into the API history as a tool_use block", async () => {
		const { task } = build({
			turns: [{ chunks: toolCallChunks("call-1", "read_file", { path: "src/a.ts" }) }],
		})

		await runTurn(task)

		const blocks = task.apiConversationHistory
			.filter((m) => m.role === "assistant")
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		expect(blocks.some((b) => (b as { type: string }).type === "tool_use")).toBe(true)
	})

	it("drops a DUPLICATE tool_call_start for an id it has already seen", async () => {
		// Two tool_use blocks with one id is an API 400 on the next request.
		const { task } = build({
			turns: [
				{
					chunks: [
						...toolCallChunks("call-1", "attempt_completion", { result: "done" }),
						{ type: "tool_call_partial", index: 0, id: "call-1", name: "attempt_completion" },
					] as never,
				},
			],
		})

		await runTurn(task)

		const ids = task.assistantMessageContent
			.filter((b) => b.type === "tool_use")
			.map((b) => (b as { id: string }).id)
		expect(ids).toEqual(["call-1"])
	})

	it("uses the task's OWN parser instance, so two tasks cannot splice each other", async () => {
		const a = build({ turns: [{ chunks: toolCallChunks("call-1", "attempt_completion", { result: "A" }) }] })
		const b = build({ turns: [{ chunks: toolCallChunks("call-1", "attempt_completion", { result: "B" }) }] })

		await Promise.all([runTurn(a.task), runTurn(b.task)])

		// Same wire id in both streams; each task reassembled its own arguments.
		const argsOf = (t: typeof a.task) =>
			(t.assistantMessageContent.find((x) => x.type === "tool_use") as { nativeArgs?: { result?: string } })
				?.nativeArgs?.result
		expect(argsOf(a.task)).toBe("A")
		expect(argsOf(b.task)).toBe("B")
	})
})

describe("the loop's own gates", () => {
	it("asks the user once the consecutive-mistake limit is reached, then resets the counter", async () => {
		const { task } = build({ turns: [{ chunks: [{ type: "text", text: "still no tool" }] as never }] })
		task.consecutiveMistakeCount = 3
		task.consecutiveMistakeLimit = 3
		const ask = vi
			.spyOn(task, "ask")
			.mockResolvedValue({ response: "messageResponse", text: "try harder" } as never)

		await runTurn(task)

		expect(ask).toHaveBeenCalledWith("mistake_limit_reached", expect.any(String))
		// The user's typed guidance is folded into the turn rather than discarded.
		expect(task.shoferMessages.some((m) => m.say === "user_feedback")).toBe(true)
	})

	it("skips the mistake gate entirely under the disable-mistake-limit experiment", async () => {
		const relaxed = makeProvider({ state: { ...STATE, experiments: { disableMistakeLimitChecks: true } } })
		const { task } = makeScriptedTask({
			provider: relaxed,
			turns: [{ chunks: [{ type: "text", text: "no tool again" }] as never }],
		})
		task.consecutiveMistakeCount = 99
		task.consecutiveMistakeLimit = 3
		const ask = vi.spyOn(task, "ask")

		await runTurn(task)

		expect(ask).not.toHaveBeenCalledWith("mistake_limit_reached", expect.anything())
	})

	it("refuses to start a turn on an already-aborted task", async () => {
		const { task } = build({ turns: [{ chunks: [{ type: "text", text: "never" }] as never }] })
		task.abort = true

		await expect(task.recursivelyMakeShoferRequests(USER, false)).rejects.toThrow(/aborted/)
	})

	it("stops consuming the stream as soon as the task is aborted mid-flight", async () => {
		const { task } = build({
			turns: [
				{
					chunks: [
						{ type: "reasoning", text: "first" },
						{ type: "reasoning", text: "second" },
						{ type: "reasoning", text: "third" },
					] as never,
				},
			],
		})
		const seen: string[] = []
		// A PASSTHROUGH spy: `say` really runs, because the loop reads back the
		// `api_req_started` entry it writes. Replacing it outright breaks the turn
		// before the stream is consumed at all.
		const realSay = task.say.bind(task)
		vi.spyOn(task, "say").mockImplementation(async (...args: unknown[]) => {
			if (args[0] === "reasoning") {
				seen.push(String(args[1] ?? ""))
				// Press Stop while the second reasoning chunk is rendering.
				if (seen.length === 2) task.abort = true
			}

			return (realSay as any)(...args)
		})

		await runTurn(task)

		// The third chunk never reached the consumer.
		expect(seen).toHaveLength(2)
	})
})

describe("the loop's error handling", () => {
	it("retries a mid-stream failure with the same content rather than losing the turn", async () => {
		const { task, api } = build({
			turns: [
				{ chunks: [{ type: "text", text: "partial" }] as never, thenThrows: new Error("socket hang up") },
				{ chunks: toolCallChunks("call-1", "attempt_completion", { result: "recovered" }) },
			],
		})

		await runTurn(task)

		// The same user content is pushed back onto the loop's stack, so the
		// second request is a retry of the same turn.
		expect(api.calls).toHaveLength(2)
		expect(JSON.stringify(api.calls[1]!.messages)).toContain("do the thing")
	})

	it("aborts the task on a NON-retryable mid-stream failure instead of looping", async () => {
		const { task } = build({
			turns: [
				{
					chunks: [{ type: "text", text: "partial" }] as never,
					thenThrows: Object.assign(new Error("No auth credentials"), { status: 401 }),
				},
			],
		})

		await runTurn(task)

		expect(task.abort).toBe(true)
		expect(task.abortReason).toBe("streaming_failed")
	})
})
