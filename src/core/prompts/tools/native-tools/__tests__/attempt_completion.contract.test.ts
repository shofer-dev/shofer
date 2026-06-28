import { describe, it, expect } from "vitest"
import type OpenAI from "openai"

import { getNativeTools } from "../index"

/**
 * §3: attempt_completion is defined via defineNativeTool, whose strict pre-bake
 * lists every property (incl. optional `feedback`) in `required`. The
 * output-contract variant (completionSchema) must still keep `feedback` optional
 * — only `result` and `rating` are required — so this locks that.
 */
const completionTool = (completionSchema?: Record<string, unknown>) =>
	getNativeTools({ completionSchema }).find(
		(t): t is OpenAI.Chat.ChatCompletionFunctionTool =>
			(t as OpenAI.Chat.ChatCompletionFunctionTool).function?.name === "attempt_completion",
	)!.function.parameters as { properties: Record<string, unknown>; required: string[] }

describe("attempt_completion output-contract variant", () => {
	it("replaces `result` with the contract schema and keeps feedback optional", () => {
		const contract = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
		const params = completionTool(contract)
		expect(params.properties.result).toEqual(contract)
		expect(params.properties.rating).toBeDefined()
		expect(params.properties.feedback).toBeDefined()
		expect([...params.required].sort()).toEqual(["rating", "result"])
		expect(params.required).not.toContain("feedback")
	})

	it("base (no contract) lists all properties required under the strict pre-bake", () => {
		const params = completionTool()
		expect([...params.required].sort()).toEqual(["feedback", "rating", "result"])
	})
})
