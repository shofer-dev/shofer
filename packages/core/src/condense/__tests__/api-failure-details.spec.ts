vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { instance: { captureContextCondensed: vi.fn() } },
}))

import type { ApiHandler } from "../../api/api-handler-types.js"
import type { ApiMessage } from "../../task-persistence/apiMessages.js"

import { summarizeConversation } from "../index.js"

/**
 * What a FAILED condense hands back.
 *
 * Condensing runs at the worst possible moment — the context window is already
 * full — so its failure is the one a user meets as "the task stopped working",
 * and the report has to be diagnosable from the chat row alone. Two rules
 * follow, and both are asserted here:
 *
 *  - **it never throws.** The caller's turn is mid-flight; a rejection would
 *    tear the task down over an optimization. The failure comes back as
 *    `{ ...response, error }` with the ORIGINAL messages intact, so the caller
 *    can decide to truncate instead;
 *  - **`errorDetails` carries the provider's own diagnosis**, not just the
 *    message: the status, the vendor error code, and whatever body the SDK
 *    attached. A bare "condense failed" is indistinguishable between a bad key,
 *    a rate limit and a model that does not exist — three different fixes.
 *
 * The cost already streamed before the failure is preserved: the tokens were
 * spent whether or not a summary came back, and dropping them under-reports
 * the task's spend against its budget.
 */

const CONVERSATION: ApiMessage[] = [
	{ role: "user", content: "Hello", ts: 1 },
	{ role: "assistant", content: "Hi there", ts: 2 },
	{ role: "user", content: "Do the thing", ts: 3 },
	{ role: "assistant", content: "Done", ts: 4 },
]

/** An api handler whose stream yields `chunks` and then throws `error`. */
function failingHandler(error: unknown, chunks: unknown[] = []): ApiHandler {
	return {
		createMessage: vi.fn(() =>
			(async function* () {
				for (const chunk of chunks) yield chunk
				throw error
			})(),
		),
		countTokens: vi.fn().mockResolvedValue(100),
		getModel: vi.fn().mockReturnValue({ id: "test-model", info: { contextWindow: 8000, maxTokens: 4000 } }),
	} as unknown as ApiHandler
}

const condense = (apiHandler: ApiHandler) =>
	summarizeConversation({ messages: CONVERSATION, apiHandler, systemPrompt: "You are helpful.", taskId: "t1" })

describe("an API failure during condensing", () => {
	it("comes back as an error rather than a rejection, with the conversation untouched", async () => {
		const result = await condense(failingHandler(new Error("upstream exploded")))

		expect(result.error).toBeTruthy()
		expect(result.errorDetails).toContain("upstream exploded")
		expect(result.messages).toEqual(CONVERSATION)
		expect(result.summary).toBe("")
	})

	it("keeps the cost already streamed before the failure", async () => {
		const result = await condense(
			failingHandler(new Error("cut off"), [
				{ type: "text", text: "partial" },
				{ type: "usage", totalCost: 0.02, outputTokens: 40 },
			]),
		)

		// The tokens were spent; dropping them under-reports the task's spend.
		expect(result.cost).toBe(0.02)
		expect(result.error).toBeTruthy()
	})

	it("records the HTTP status the provider answered with", async () => {
		const result = await condense(failingHandler(Object.assign(new Error("Too Many Requests"), { status: 429 })))

		expect(result.errorDetails).toContain("HTTP Status: 429")
	})

	it("records the vendor error code", async () => {
		const result = await condense(
			failingHandler(Object.assign(new Error("Invalid key"), { code: "invalid_api_key" })),
		)

		expect(result.errorDetails).toContain("Error Code: invalid_api_key")
	})

	it("serializes whatever response and body the SDK attached", async () => {
		const result = await condense(
			failingHandler(
				Object.assign(new Error("bad request"), {
					response: { status: 400, headers: { "x-request-id": "req-1" } },
					body: { error: { type: "invalid_request_error", message: "context too long" } },
				}),
			),
		)

		expect(result.errorDetails).toContain("API Response:")
		expect(result.errorDetails).toContain("req-1")
		expect(result.errorDetails).toContain("Response Body:")
		expect(result.errorDetails).toContain("context too long")
	})

	it("says so plainly when a response or body cannot be serialized", async () => {
		// A circular payload is ordinary in SDK errors (a response referencing
		// its own request); it must not turn a diagnosable failure into a
		// SECOND, unrelated throw inside the error handler.
		const circular: Record<string, unknown> = {}
		circular.self = circular

		const result = await condense(
			failingHandler(Object.assign(new Error("weird"), { response: circular, body: circular })),
		)

		expect(result.errorDetails).toContain("API Response: [Unable to serialize]")
		expect(result.errorDetails).toContain("Response Body: [Unable to serialize]")
	})

	it("stringifies a rejection that is not an Error at all", async () => {
		const result = await condense(failingHandler("the provider rejected with a bare string"))

		expect(result.errorDetails).toBe("the provider rejected with a bare string")
		expect(result.error).toBeTruthy()
	})

	it("carries no details section for a plain Error with nothing attached", async () => {
		const result = await condense(failingHandler(new Error("just a message")))

		expect(result.errorDetails).toBe("Error: just a message")
	})
})
