// npx vitest src/integrations/misc/__tests__/export-json.trace.test.ts

/**
 * The JSON export's trace builder. Per the Export Schema Co-Evolution Rule the
 * three representations — `ShoferApiReqInfo` (written by `Task`),
 * `UiApiReqStartedPayload` (parsed here) and `JsonExportCall` (emitted) — must
 * stay in lock-step, so this file drives a realistic `api_req_started` payload
 * end to end and asserts each field ARRIVES rather than asserting the shape of
 * the parser: a write-side field with no matching read key is silently dropped
 * from every export, and that is exactly what this catches.
 *
 * The partitioning itself is the other half: a call is "user message(s) →
 * assistant message", tool results live on the FOLLOWING user message, and an
 * `api_req_started` with no assistant reply (a connection failure, a rate limit,
 * an empty stream) must still appear — otherwise an error-only task exports as
 * an empty `calls[]` and looks like nothing happened.
 */

const hoisted = vi.hoisted(() => ({
	showSaveDialog: vi.fn(),
	showTextDocument: vi.fn(),
	showInformationMessage: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	executeCommand: vi.fn(async () => undefined),
	stringifyJsonToFile: vi.fn(async () => 1024),
}))

vi.mock("vscode", () => ({
	Uri: { file: (p: string) => ({ fsPath: p }) },
	ProgressLocation: { Notification: 15 },
	window: {
		showSaveDialog: hoisted.showSaveDialog,
		showTextDocument: hoisted.showTextDocument,
		showInformationMessage: hoisted.showInformationMessage,
		withProgress: async (_options: unknown, task: () => Promise<number>) => task(),
	},
	commands: { executeCommand: hoisted.executeCommand },
}))

vi.mock("../../../utils/exportJsonWorker", () => ({ stringifyJsonToFile: hoisted.stringifyJsonToFile }))

import type { Anthropic } from "@anthropic-ai/sdk"

import { buildJsonTrace, downloadJsonTask, getJsonExportFileName, type JsonExportTrace } from "../export-json"

function apiReqStarted(payload: Record<string, unknown>, ts = 1) {
	return { type: "say", say: "api_req_started", ts, text: JSON.stringify(payload) }
}

const CREATED_AT = "2026-06-13T00:00:00.000Z"

function trace(
	history: Anthropic.Messages.MessageParam[],
	uiMessages: Array<Record<string, unknown>> = [],
	options?: { title?: string },
) {
	return buildJsonTrace("t-1", "the task", "code", CREATED_AT, history, uiMessages as never, options)
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.stringifyJsonToFile.mockResolvedValue(1024)
})

describe("getJsonExportFileName", () => {
	it("renders a lowercase month, a 12-hour clock and an am/pm suffix", () => {
		const name = getJsonExportFileName(new Date(2026, 5, 13, 14, 5, 9).getTime())

		expect(name).toBe("shofer_task_jun-13-2026_2-05-09-pm.json")
	})

	it("renders MIDNIGHT as 12am rather than 0am", () => {
		const name = getJsonExportFileName(new Date(2026, 0, 1, 0, 0, 0).getTime())

		expect(name).toContain("_12-00-00-am.json")
	})

	it("renders NOON as 12pm", () => {
		expect(getJsonExportFileName(new Date(2026, 0, 1, 12, 30, 0).getTime())).toContain("_12-30-00-pm.json")
	})
})

describe("buildJsonTrace — call partitioning", () => {
	it("produces no calls for an empty conversation", () => {
		const result = trace([])

		expect(result.calls).toEqual([])
		expect(result).toMatchObject({ version: 1, taskId: "t-1", task: "the task", mode: "code", totalCalls: 0 })
	})

	it("closes a call on each ASSISTANT message, carrying the preceding user turns", () => {
		const result = trace([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "reply one" },
			{ role: "user", content: "second" },
			{ role: "assistant", content: "reply two" },
		])

		expect(result.calls).toHaveLength(2)
		expect(result.calls[0].index).toBe(1)
		expect(result.calls[0].messages).toHaveLength(2)
		expect(result.calls[1].index).toBe(2)
	})

	it("leaves a trailing user message OUT of any call — nothing has answered it yet", () => {
		const result = trace([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "reply" },
			{ role: "user", content: "unanswered" },
		])

		expect(result.calls).toHaveLength(1)
	})
})

describe("buildJsonTrace — per-call metadata round-trips", () => {
	it("carries EVERY field the write side records", () => {
		const payload = {
			apiProtocol: "openai",
			model: "gpt-5.1",
			tokensIn: 100,
			tokensOut: 20,
			cacheWrites: 5,
			cacheReads: 7,
			cost: 0.12,
			cancelled: true,
			cancelReason: "user_cancelled",
			streamingFailedMessage: "stream ended",
			retryAttempt: 2,
			durationMs: 1500,
			firstChunkMs: 300,
			thinkingMs: 200,
			reasoningIntervalsMs: [10, 20],
			error: { message: "boom" },
			wireRequest: { body: "{}" },
		}

		const result = trace(
			[
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			[apiReqStarted(payload)],
		)

		expect(result.calls[0]).toMatchObject({
			apiProtocol: "openai",
			model: "gpt-5.1",
			inputTokens: 100,
			outputTokens: 20,
			cacheWriteTokens: 5,
			cacheReadTokens: 7,
			costUsd: 0.12,
			cancelled: true,
			cancelReason: "user_cancelled",
			streamingFailedMessage: "stream ended",
			retryAttempt: 2,
			durationMs: 1500,
			firstChunkMs: 300,
			thinkingMs: 200,
			reasoningIntervalsMs: [10, 20],
			error: { message: "boom" },
			wireRequest: { body: "{}" },
		})
	})

	it("zero-fills the cost/cache fields when the payload omits them", () => {
		const result = trace(
			[
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			[apiReqStarted({ model: "m" })],
		)

		// The token counts are then filled in by the char/4 fallback below, since
		// a call reporting zero of both is indistinguishable from a provider that
		// emitted no `usage` chunk at all.
		expect(result.calls[0]).toMatchObject({ cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0 })
	})

	it("survives an UNPARSEABLE api_req_started payload rather than losing the call", () => {
		const result = trace(
			[
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			[{ type: "say", say: "api_req_started", ts: 1, text: "{not json" }],
		)

		expect(result.calls).toHaveLength(1)
		expect(result.calls[0].model).toBeUndefined()
	})

	it("ignores UI messages that are not api_req_started", () => {
		const result = trace(
			[
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			[
				{ type: "say", say: "text", ts: 1, text: "chatter" },
				{ type: "ask", ask: "tool", ts: 2 },
				apiReqStarted({ model: "m" }, 3),
			],
		)

		expect(result.calls[0].model).toBe("m")
	})
})

describe("buildJsonTrace — tool calls", () => {
	it("pairs a tool_use with the tool_result on the NEXT user message", () => {
		const result = trace([
			{ role: "user", content: "read it" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } }],
			} as never,
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body", is_error: false }],
			} as never,
			{ role: "assistant", content: "done" },
		])

		expect(result.calls[0].toolCalls).toEqual([
			{
				name: "read_file",
				id: "call_1",
				input: { path: "a.ts" },
				result: { content: "file body", isError: false },
			},
		])
		expect(result.totalToolCalls).toBe(1)
	})

	it("records a FAILED tool result as such", () => {
		const result = trace([
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] } as never,
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "c1", content: "denied", is_error: true }],
			} as never,
			{ role: "assistant", content: "ok" },
		])

		expect(result.calls[0].toolCalls[0].result).toEqual({ content: "denied", isError: true })
	})

	it("defaults a result with no is_error flag to a SUCCESS", () => {
		const result = trace([
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] } as never,
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] } as never,
			{ role: "assistant", content: "done" },
		])

		expect(result.calls[0].toolCalls[0].result).toMatchObject({ isError: false })
	})

	it("leaves the result UNDEFINED when the tool never answered", () => {
		const result = trace([
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] } as never,
		])

		expect(result.calls[0].toolCalls[0].result).toBeUndefined()
	})

	it("substitutes an empty input object rather than emitting null", () => {
		const result = trace([
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: undefined }] } as never,
		])

		expect(result.calls[0].toolCalls[0].input).toEqual({})
	})

	it("does not pair a result whose tool_use_id belongs to a DIFFERENT call", () => {
		const result = trace([
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] } as never,
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "other", content: "x" }] } as never,
			{ role: "assistant", content: "done" },
		])

		expect(result.calls[0].toolCalls[0].result).toBeUndefined()
	})
})

describe("buildJsonTrace — reasoning", () => {
	it("concatenates `reasoning` blocks", () => {
		const result = trace([
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "first " },
					{ type: "reasoning", text: "second" },
				],
			} as never,
		])

		expect(result.calls[0].reasoning).toBe("first second")
	})

	it("also reads Anthropic's extended-`thinking` shape", () => {
		const result = trace([{ role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] } as never])

		expect(result.calls[0].reasoning).toBe("pondering")
	})

	it("leaves reasoning UNDEFINED — never an empty string — when there was none", () => {
		const result = trace([{ role: "assistant", content: "plain" }])

		expect(result.calls[0].reasoning).toBeUndefined()
	})
})

describe("buildJsonTrace — calls with no assistant reply", () => {
	it("still EXPORTS an api_req_started that never produced a response", () => {
		const result = trace([], [apiReqStarted({ model: "m", error: { message: "connection refused" } })])

		expect(result.calls).toHaveLength(1)
		expect(result.calls[0]).toMatchObject({ index: 1, model: "m", messages: [], toolCalls: [] })
		expect(result.calls[0].error).toEqual({ message: "connection refused" })
	})

	it("numbers the orphan call AFTER the answered ones", () => {
		const result = trace(
			[
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			[apiReqStarted({ model: "m" }, 1), apiReqStarted({ model: "m", error: { message: "boom" } }, 2)],
		)

		expect(result.calls.map((c) => c.index)).toEqual([1, 2])
		expect(result.calls[1].messages).toEqual([])
	})

	it("survives an unparseable orphan payload", () => {
		const result = trace([], [{ type: "say", say: "api_req_started", ts: 1, text: "{nope" }])

		expect(result.calls).toHaveLength(1)
	})
})

describe("buildJsonTrace — token estimation fallback", () => {
	it("ESTIMATES tokens when the provider reported none, and marks them as estimates", () => {
		const result = trace([
			{ role: "user", content: "a".repeat(40) },
			{ role: "assistant", content: "b".repeat(20) },
		])

		expect(result.calls[0]).toMatchObject({ inputTokens: 10, outputTokens: 5, _tokensEstimated: true })
		expect(result.totalTokens).toMatchObject({ input: 10, output: 5 })
	})

	it("does NOT estimate when the provider reported real numbers", () => {
		const result = trace(
			[
				{ role: "user", content: "a".repeat(40) },
				{ role: "assistant", content: "b".repeat(20) },
			],
			[apiReqStarted({ tokensIn: 3, tokensOut: 4 })],
		)

		expect(result.calls[0]).toMatchObject({ inputTokens: 3, outputTokens: 4 })
		expect(result.calls[0]._tokensEstimated).toBeUndefined()
	})

	it("estimates a tool_use block from its serialized input", () => {
		const result = trace([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c1", name: "t", input: { path: "a.ts" } }],
			} as never,
		])

		expect(result.calls[0].outputTokens).toBeGreaterThan(0)
	})

	it("counts a string tool_result's content", () => {
		const result = trace([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "x".repeat(8) }] } as never,
			{ role: "assistant", content: [{ type: "image" }] } as never,
		])

		expect(result.calls[0].inputTokens).toBe(2)
	})

	it("counts an unrecognised block as ZERO rather than guessing", () => {
		const result = trace([{ role: "assistant", content: [{ type: "image", source: {} }] } as never])

		expect(result.calls[0].outputTokens).toBe(0)
	})
})

describe("buildJsonTrace — aggregates", () => {
	it("sums tokens, cost and tool calls across every call", () => {
		const result = trace(
			[
				{ role: "user", content: "a" },
				{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] } as never,
				{ role: "user", content: "b" },
				{ role: "assistant", content: "c" },
			],
			[
				apiReqStarted({ tokensIn: 10, tokensOut: 1, cacheWrites: 2, cacheReads: 3, cost: 0.5 }, 1),
				apiReqStarted({ tokensIn: 5, tokensOut: 2, cacheWrites: 1, cacheReads: 1, cost: 0.25 }, 2),
			],
		)

		expect(result.totalTokens).toEqual({ input: 15, output: 3, cacheWrite: 3, cacheRead: 4 })
		expect(result.totalCostUsd).toBe(0.75)
		expect(result.totalCalls).toBe(2)
		expect(result.totalToolCalls).toBe(1)
	})

	it("keeps the curated title distinct from the full task text, and omits it when absent", () => {
		expect(trace([], [], { title: "Fix auth" })).toMatchObject({ title: "Fix auth", task: "the task" })
		expect("title" in trace([])).toBe(false)
	})
})

describe("downloadJsonTask", () => {
	const emptyTrace = { version: 1, taskId: "t-1" } as unknown as JsonExportTrace

	it("returns undefined and writes NOTHING when the user cancels the save dialog", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce(undefined)

		await expect(downloadJsonTask(0, emptyTrace, { fsPath: "/d.json" } as never)).resolves.toBeUndefined()
		expect(hoisted.stringifyJsonToFile).not.toHaveBeenCalled()
	})

	it("writes OFF the extension-host thread and auto-opens a small export", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/out.json" })

		await expect(downloadJsonTask(0, emptyTrace, { fsPath: "/d.json" } as never)).resolves.toEqual({
			fsPath: "/out.json",
		})

		expect(hoisted.stringifyJsonToFile).toHaveBeenCalledWith(emptyTrace, "/out.json")
		expect(hoisted.showTextDocument).toHaveBeenCalledWith({ fsPath: "/out.json" }, { preview: true })
	})

	it("does NOT auto-open a multi-megabyte export — tokenizing it would freeze the UI", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/big.json" })
		hoisted.stringifyJsonToFile.mockResolvedValueOnce(6 * 1024 * 1024)

		await downloadJsonTask(0, emptyTrace, { fsPath: "/d.json" } as never)

		expect(hoisted.showTextDocument).not.toHaveBeenCalled()
		expect(hoisted.showInformationMessage).toHaveBeenCalled()
	})

	it("opens a large export NON-preview when the user asks", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/big.json" })
		hoisted.stringifyJsonToFile.mockResolvedValueOnce(6 * 1024 * 1024)
		hoisted.showInformationMessage.mockImplementationOnce(async (...args: unknown[]) => args[1])

		await downloadJsonTask(0, emptyTrace, { fsPath: "/d.json" } as never)
		await vi.waitFor(() =>
			expect(hoisted.showTextDocument).toHaveBeenCalledWith({ fsPath: "/big.json" }, { preview: false }),
		)
	})

	it("reveals a large export in the OS file manager when the user asks", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/big.json" })
		hoisted.stringifyJsonToFile.mockResolvedValueOnce(6 * 1024 * 1024)
		hoisted.showInformationMessage.mockImplementationOnce(async (...args: unknown[]) => args[2])

		await downloadJsonTask(0, emptyTrace, { fsPath: "/d.json" } as never)
		await vi.waitFor(() =>
			expect(hoisted.executeCommand).toHaveBeenCalledWith("revealFileInOS", { fsPath: "/big.json" }),
		)
	})

	it("does nothing further when the user dismisses the large-export prompt", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/big.json" })
		hoisted.stringifyJsonToFile.mockResolvedValueOnce(6 * 1024 * 1024)
		hoisted.showInformationMessage.mockResolvedValueOnce(undefined)

		await downloadJsonTask(0, emptyTrace, { fsPath: "/d.json" } as never)

		expect(hoisted.showTextDocument).not.toHaveBeenCalled()
		expect(hoisted.executeCommand).not.toHaveBeenCalled()
	})
})
