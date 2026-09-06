import { BUILTIN_MODES } from "../../__fixtures__/builtin-config.js"

// The four mocks that keep a Task off the machine. They must be declared per
// file (vitest hoists `vi.mock`); everything else comes from the shared
// scripted-task harness.
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

import {
	BASE_API_CONFIG,
	drain,
	makeProvider,
	makeScriptedTask,
	resetScriptedEnvironment,
	type FakeProvider,
} from "./helpers/scriptedTask.js"

/**
 * `Task.attemptApiRequest` — the whole path between "the loop wants a turn" and
 * "bytes leave for the provider", driven with the LLM as the only fake.
 *
 * Four properties here are contractual rather than incidental:
 *
 *  - the **system prompt and tool array are really built**, and both are cached
 *    behind keys that must invalidate on the inputs that change them (H15/H16).
 *    A stale tool cache is the bug where a plugin's tool is in the prompt but
 *    not in the catalog, so the model calls a tool the request never offered;
 *  - the **wire request is snapshotted into `api_req_started`** before the
 *    first chunk, which is what the JSON export reads. The Wire-Capture Anchor
 *    Rule pins the ordering: emit `api_req_started`, snapshot, then create the
 *    message;
 *  - a **context-window error retries by TRUNCATING**, not by re-sending the
 *    same oversized history — and only up to a bound;
 *  - the **retry budget is a COUNT**, because a connection error carries no
 *    evidence that a retry will help; a non-retryable auth failure is re-thrown
 *    immediately rather than spun behind a backoff.
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
})

function build(opts: Parameters<typeof makeScriptedTask>[0] = {}) {
	return makeScriptedTask({ provider, ...opts })
}

describe("attemptApiRequest — a successful turn", () => {
	it("really assembles a system prompt and a tool catalog, and passes both to the provider", async () => {
		const { task, api } = build({ turns: [{ chunks: [{ type: "text", text: "hello" } as never] }] })

		const chunks = await drain(task.attemptApiRequest(0))

		expect(chunks).toEqual([{ type: "text", text: "hello" }])
		expect(api.calls).toHaveLength(1)
		const [call] = api.calls
		// Not a stub: the real SYSTEM_PROMPT ran.
		expect(call!.systemPrompt.length).toBeGreaterThan(200)
		expect(call!.metadata.taskId).toBe(task.taskId)
		expect(call!.metadata.tool_choice).toBe("auto")
		expect((call!.metadata.tools as unknown[]).length).toBeGreaterThan(0)
	})

	it("snapshots the wire request onto the api_req_started entry for the export", async () => {
		const { task } = build({ turns: [{ chunks: [{ type: "text", text: "ok" } as never] }] })
		// The Wire-Capture Anchor Rule: the snapshot merges into the most recent
		// `api_req_started`, so one must exist first.
		await task.say("api_req_started", JSON.stringify({ request: "" }))

		await drain(task.attemptApiRequest(0))

		const entry = [...task.shoferMessages].reverse().find((m) => m.say === "api_req_started")!
		const payload = JSON.parse(entry.text!)
		expect(payload.wireRequest).toBeDefined()
		const wire = JSON.parse(payload.wireRequest)
		expect(wire.model).toBe("test-model")
		expect(wire.systemPromptLength).toBeGreaterThan(200)
		expect(wire.toolCount).toBeGreaterThan(0)
	})

	it("offers NO tools for a conversational turn, and says so by omitting tool_choice", async () => {
		const { task, api } = build({
			apiConfiguration: { ...BASE_API_CONFIG, toolCallingEnabled: false },
			turns: [{ chunks: [{ type: "text", text: "just talking" } as never] }],
		})

		await drain(task.attemptApiRequest(0))

		expect(api.calls[0]!.metadata.tools).toBeUndefined()
		expect(api.calls[0]!.metadata.tool_choice).toBeUndefined()
	})

	it("sends allowedFunctionNames to Gemini only", async () => {
		// Gemini sees every tool in history but may call only the allowed ones,
		// so the restriction rides alongside the catalog. No other provider gets
		// the field.
		const gemini = makeProvider({
			state: { ...STATE, apiConfiguration: { ...BASE_API_CONFIG, apiProvider: "gemini" } },
		})
		const geminiTask = makeScriptedTask({
			provider: gemini,
			apiConfiguration: { ...BASE_API_CONFIG, apiProvider: "gemini" },
			turns: [{ chunks: [{ type: "text", text: "ok" } as never] }],
		})
		await drain(geminiTask.task.attemptApiRequest(0))
		expect(Array.isArray(geminiTask.api.calls[0]!.metadata.allowedFunctionNames)).toBe(true)

		const anthropic = build({ turns: [{ chunks: [{ type: "text", text: "ok" } as never] }] })
		await drain(anthropic.task.attemptApiRequest(0))
		expect(anthropic.api.calls[0]!.metadata.allowedFunctionNames).toBeUndefined()
	})

	it("streams every chunk after the first, unchanged", async () => {
		const { task } = build({
			turns: [
				{
					chunks: [
						{ type: "text", text: "a" },
						{ type: "reasoning", text: "b" },
						{ type: "usage", inputTokens: 1, outputTokens: 2 },
					] as never,
				},
			],
		})

		expect(await drain(task.attemptApiRequest(0))).toEqual([
			{ type: "text", text: "a" },
			{ type: "reasoning", text: "b" },
			{ type: "usage", inputTokens: 1, outputTokens: 2 },
		])
	})
})

describe("attemptApiRequest — the prompt and tool caches", () => {
	it("reuses both caches across two requests with identical inputs", async () => {
		const { task, api } = build({
			turns: [
				{ chunks: [{ type: "text", text: "a" } as never] },
				{ chunks: [{ type: "text", text: "b" } as never] },
			],
		})

		await drain(task.attemptApiRequest(0))
		await drain(task.attemptApiRequest(0))

		expect(api.calls[0]!.systemPrompt).toBe(api.calls[1]!.systemPrompt)
		// Byte-identical prompts are the condition for the provider's prefix cache.
		expect(api.calls[0]!.metadata.tools).toBe(api.calls[1]!.metadata.tools)
	})

	it("rebuilds the prompt when a cache-key input changes", async () => {
		const { task, api } = build({
			turns: [
				{ chunks: [{ type: "text", text: "a" } as never] },
				{ chunks: [{ type: "text", text: "b" } as never] },
			],
		})

		await drain(task.attemptApiRequest(0))
		provider.getState.mockResolvedValue({ ...STATE, customInstructions: "Always answer in haiku." })
		await drain(task.attemptApiRequest(0))

		expect(api.calls[1]!.systemPrompt).not.toBe(api.calls[0]!.systemPrompt)
		expect(api.calls[1]!.systemPrompt).toContain("haiku")
	})

	it("rebuilds the tool catalog when the disabled-tool set changes", async () => {
		const { task, api } = build({
			turns: [
				{ chunks: [{ type: "text", text: "a" } as never] },
				{ chunks: [{ type: "text", text: "b" } as never] },
			],
		})

		await drain(task.attemptApiRequest(0))
		const before = (api.calls[0]!.metadata.tools as Array<{ function: { name: string } }>).map(
			(t) => t.function.name,
		)

		provider.getState.mockResolvedValue({ ...STATE, disabledTools: ["execute_command"] })
		await drain(task.attemptApiRequest(0))
		const after = (api.calls[1]!.metadata.tools as Array<{ function: { name: string } }>).map(
			(t) => t.function.name,
		)

		expect(before).toContain("execute_command")
		expect(after).not.toContain("execute_command")
	})
})

describe("attemptApiRequest — a subtask's prompt", () => {
	it("appends the subtask constraints, naming the parent as the decision-maker", async () => {
		const parent = build().task
		const { task, api } = build({
			taskOptions: { parentTask: parent, rootTask: parent },
			turns: [{ chunks: [{ type: "text", text: "ok" } as never] }],
		})

		await drain(task.attemptApiRequest(0))

		const prompt = api.calls[0]!.systemPrompt
		expect(prompt).toContain("SUBTASK CONSTRAINTS")
		expect(prompt).toContain("synchronous sub-task")
		expect(prompt).toContain("Do not ask the user follow-up questions")
	})

	it("tells a BACKGROUND child its question routes to the parent, and that it may be cancelled", async () => {
		const parent = build().task
		const { task, api } = build({
			taskOptions: { parentTask: parent, rootTask: parent, isBackground: true },
			turns: [{ chunks: [{ type: "text", text: "ok" } as never] }],
		})

		await drain(task.attemptApiRequest(0))

		const prompt = api.calls[0]!.systemPrompt
		expect(prompt).toContain("routed to the parent task (NOT the user)")
		expect(prompt).toContain("cancel_tasks")
	})

	it("carries the soft result-length and timeout guidance, with the hard cap named", async () => {
		const parent = build().task
		const { task, api } = build({
			taskOptions: {
				parentTask: parent,
				rootTask: parent,
				isBackground: true,
				softResultLength: 500,
				softTimeoutSec: 120,
			},
			turns: [{ chunks: [{ type: "text", text: "ok" } as never] }],
		})

		await drain(task.attemptApiRequest(0))

		const prompt = api.calls[0]!.systemPrompt
		expect(prompt).toContain("Result length suggestion: 500 characters")
		expect(prompt).toContain("Hard safety cap")
		expect(prompt).toContain("Estimated timeout: 120 seconds")
	})

	it("names the peers a child may write to", async () => {
		const parent = build().task
		const { task, api } = build({
			taskOptions: {
				parentTask: parent,
				rootTask: parent,
				isBackground: true,
			},
			turns: [{ chunks: [{ type: "text", text: "ok" } as never] }],
		})
		task.knownPeers = new Set([parent.taskId, "peer-1"])

		await drain(task.attemptApiRequest(0))

		expect(api.calls[0]!.systemPrompt).toContain("Known peer task IDs: peer-1")
	})

	it("still tells a parent-only child that it can message its parent", async () => {
		const parent = build().task
		const { task, api } = build({
			taskOptions: { parentTask: parent, rootTask: parent, isBackground: true },
			turns: [{ chunks: [{ type: "text", text: "ok" } as never] }],
		})
		task.knownPeers = new Set([parent.taskId])

		await drain(task.attemptApiRequest(0))

		expect(api.calls[0]!.systemPrompt).toContain(`send_message to write to your parent (task ID: ${parent.taskId})`)
	})
})

describe("attemptApiRequest — first-chunk failures", () => {
	it("re-throws a non-retryable auth failure instead of spinning the backoff", async () => {
		const authError = Object.assign(new Error("No auth credentials found"), { status: 401 })
		const { task, api } = build({ turns: [{ throws: authError }] })

		await expect(drain(task.attemptApiRequest(0))).rejects.toThrow(/No auth credentials/)
		// One attempt, not a retry storm.
		expect(api.calls).toHaveLength(1)
	})

	it("retries a transient failure and succeeds on the next attempt", async () => {
		const { task, api } = build({
			turns: [
				{ throws: new Error("Connection error") },
				{ chunks: [{ type: "text", text: "recovered" } as never] },
			],
		})

		expect(await drain(task.attemptApiRequest(0))).toEqual([{ type: "text", text: "recovered" }])
		expect(api.calls).toHaveLength(2)
	})

	it("records the failure onto api_req_started so the export can show it", async () => {
		const { task } = build({
			turns: [{ throws: new Error("Connection error") }, { chunks: [{ type: "text", text: "ok" } as never] }],
		})
		await task.say("api_req_started", JSON.stringify({ request: "" }))

		await drain(task.attemptApiRequest(0))

		const entry = [...task.shoferMessages].reverse().find((m) => m.say === "api_req_started")!
		expect(JSON.parse(entry.text!).error).toMatchObject({ message: expect.stringContaining("Connection error") })
	})

	it("asks the user to retry when auto-approval is off, and honours a refusal", async () => {
		const manual = makeProvider({ state: { ...STATE, autoApprovalEnabled: false } })
		const { task } = makeScriptedTask({
			provider: manual,
			turns: [{ throws: new Error("boom") }, { chunks: [{ type: "text", text: "after retry" } as never] }],
		})
		const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" } as never)

		expect(await drain(task.attemptApiRequest(0))).toEqual([{ type: "text", text: "after retry" }])
		expect(ask).toHaveBeenCalledWith("api_req_failed", expect.stringContaining("boom"))
		expect(task.shoferMessages.some((m) => m.say === "api_req_retried")).toBe(true)

		const refusing = makeScriptedTask({ provider: manual, turns: [{ throws: new Error("boom") }] })
		vi.spyOn(refusing.task, "ask").mockResolvedValue({ response: "noButtonClicked" } as never)
		await expect(drain(refusing.task.attemptApiRequest(0))).rejects.toThrow("API request failed")
	})

	it("gives up on COUNT once the retry budget is spent", async () => {
		// A connection error carries no evidence a retry will help, so the bound
		// is the number of consecutive failures with no success in between.
		const failures = Array.from({ length: 12 }, () => ({ throws: new Error("Connection error") }))
		const { task } = build({ turns: failures })

		await expect(drain(task.attemptApiRequest(0))).rejects.toThrow(/Connection error/)
	})
})

describe("attemptApiRequest — context-window recovery", () => {
	function contextWindowError() {
		return Object.assign(new Error("Input is too long for requested model. context window exceeded"), {
			status: 400,
		})
	}

	it("truncates and retries rather than re-sending the oversized history", async () => {
		const { task, api } = build({
			turns: [{ throws: contextWindowError() }, { chunks: [{ type: "text", text: "fits now" } as never] }],
			api: { tokenCount: 10 },
		})
		task.apiConversationHistory = [
			{ role: "user", content: [{ type: "text", text: "a".repeat(200) }] },
			{ role: "assistant", content: [{ type: "text", text: "b".repeat(200) }] },
			{ role: "user", content: [{ type: "text", text: "c".repeat(200) }] },
		] as never

		expect(await drain(task.attemptApiRequest(0))).toEqual([{ type: "text", text: "fits now" }])
		expect(api.calls).toHaveLength(2)
		// The webview is told the recovery started AND finished, so no spinner is
		// left hanging.
		const posted = provider.postMessageToWebview.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type)
		expect(posted).toContain("condenseTaskContextStarted")
		expect(posted).toContain("condenseTaskContextResponse")
	})

	it("stops retrying a context-window error at the bound instead of looping", async () => {
		const failures = Array.from({ length: 6 }, () => ({ throws: contextWindowError() }))
		const { task } = build({ turns: failures })

		// Past the bound it falls through to the ordinary retry path, which ends
		// in a thrown error rather than an unbounded truncate/retry cycle.
		await expect(drain(task.attemptApiRequest(0))).rejects.toThrow()
	})

	it("drops the loaded-skill set when history is truncated", async () => {
		const { task } = build({
			turns: [{ throws: contextWindowError() }, { chunks: [{ type: "text", text: "ok" } as never] }],
			api: { tokenCount: 10 },
		})
		task.apiConversationHistory = [
			{ role: "user", content: [{ type: "text", text: "a".repeat(200) }] },
			{ role: "assistant", content: [{ type: "text", text: "b".repeat(200) }] },
			{ role: "user", content: [{ type: "text", text: "c".repeat(200) }] },
		] as never
		task.loadedSkills.set("verify-mermaid", "/skills/verify-mermaid/SKILL.md")

		await drain(task.attemptApiRequest(0))

		// The instructions those skills carried are no longer in the history, so
		// the set must not claim they are still loaded.
		expect(task.loadedSkills.size).toBe(0)
	})
})

describe("attemptApiRequest — provider rate limiting", () => {
	it("counts down before the request when a rate limit is configured", async () => {
		const limited = makeProvider({
			state: { ...STATE, apiConfiguration: { ...BASE_API_CONFIG, rateLimitSeconds: 3 } },
		})
		const { task } = makeScriptedTask({
			provider: limited,
			turns: [
				{ chunks: [{ type: "text", text: "ok" } as never] },
				{ chunks: [{ type: "text", text: "ok" } as never] },
			],
		})

		// The first request seeds the global timestamp; the second is the one
		// that waits.
		await drain(task.attemptApiRequest(0))
		await drain(task.attemptApiRequest(0))

		expect(task.shoferMessages.some((m) => m.say === "api_req_rate_limit_wait")).toBe(true)
	})

	it("skips the wait when the caller already paid it", async () => {
		const limited = makeProvider({
			state: { ...STATE, apiConfiguration: { ...BASE_API_CONFIG, rateLimitSeconds: 3 } },
		})
		const { task } = makeScriptedTask({
			provider: limited,
			turns: [
				{ chunks: [{ type: "text", text: "ok" } as never] },
				{ chunks: [{ type: "text", text: "ok" } as never] },
			],
		})

		// The rate-limit clock is a PROCESS-wide static, so the count before the
		// skipping request is what this compares against — not zero.
		await drain(task.attemptApiRequest(0))
		const before = task.shoferMessages.filter((m) => m.say === "api_req_rate_limit_wait").length

		await drain(task.attemptApiRequest(0, { skipProviderRateLimit: true }))

		expect(task.shoferMessages.filter((m) => m.say === "api_req_rate_limit_wait")).toHaveLength(before)
	})
})

describe("attemptApiRequest — cancellation", () => {
	/** Cancel as soon as the request actually has a controller to cancel. */
	async function cancelWhenInFlight(task: import("../Task.js").Task) {
		await vi.waitFor(() => {
			expect((task as any).currentRequestAbortController).toBeDefined()
		})
		task.cancelCurrentRequest()
	}

	it("cancels the HTTP request WITHOUT ending the task — the retry path takes over", async () => {
		// The Dual Cancellation-Path Rule: `cancelCurrentRequest` aborts the
		// in-flight request only. It does not set `abort`, so the first-chunk
		// failure it produces is handled like any other and the request is retried.
		const { task, api } = build({
			turns: [{ hangs: true }, { chunks: [{ type: "text", text: "retried" } as never] }],
		})

		const pending = drain(task.attemptApiRequest(0))
		await cancelWhenInFlight(task)

		expect(await pending).toEqual([{ type: "text", text: "retried" }])
		expect(api.calls).toHaveLength(2)
	})

	it("refuses to retry once the TASK was aborted during the backoff", async () => {
		const { task } = build({ turns: [{ hangs: true }, { chunks: [{ type: "text", text: "never" } as never] }] })

		const pending = drain(task.attemptApiRequest(0))
		await cancelWhenInFlight(task)
		// The user pressed Stop, not just "cancel this request".
		task.abort = true

		await expect(pending).rejects.toThrow(/aborted during retry/)
	})
})
