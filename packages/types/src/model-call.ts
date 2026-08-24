import { z } from "zod"

/**
 * The question core broadcasts to every plugin immediately before it starts one
 * request to a MODEL API, so a plugin can supply transport headers for **that**
 * request.
 *
 * This is the LLM-side twin of {@link McpCallHeadersQuestion}, and it exists for
 * the same reason. A provider's HTTP client is built ONCE, from the API
 * configuration, and is then shared by every task the host runs; its headers are
 * therefore the HOST's. A value that belongs to the RUN — a short-lived
 * credential re-minted per run, an attribution or correlation header a caller
 * expects to see on the request it caused — has no way in. Hence the question:
 * every plugin is offered it and the answers are merged (see
 * `resolveModelCallHeaders` in `@shofer/core`).
 *
 * Two things a resolver must know about the shape of this seam, because both
 * differ from the MCP one and both are deliberate:
 *
 * - **The question names no URL.** Each provider owns its own base-url setting
 *   and builds its client privately, so there is no endpoint core can state at
 *   the layer where the request begins. A resolver therefore decides from the
 *   PROFILE — `provider` and `model` — which is the same thing the operator
 *   configured when they pointed this host at that endpoint.
 * - **An answer can never authorize.** The merge refuses the credential and
 *   transport header names outright, and a header already on the request always
 *   wins over an answered one, so a plugin annotates a model call and can never
 *   re-point or re-authenticate it. That is what makes it safe to answer without
 *   a URL.
 */
export interface ModelCallHeadersQuestion {
	/**
	 * Which call this is: `chat` for a streaming conversation turn
	 * (`ApiHandler.createMessage`), `complete` for a one-shot completion
	 * (`SingleCompletionHandler.completePrompt` — condensing, prompt enhancement,
	 * title generation).
	 */
	operation: "chat" | "complete"
	/** The configured provider id (`anthropic`, `openrouter`, …), when one is set. */
	provider?: string
	/** The model the request asks for, as the handler resolves it. */
	model?: string
	/** The run the request belongs to — the same id the task carries everywhere else. */
	taskId?: string
	/** The run's parent, when it was spawned by another. */
	parentTaskId?: string
	/** The root of the run's task tree. */
	rootTaskId?: string
}

/**
 * A plugin's answer to {@link ModelCallHeadersQuestion}: the headers to add to
 * this one request.
 *
 * There is deliberately **no error channel**, for the same reason the MCP answer
 * has none: a header is additive attribution, and a resolver that cannot produce
 * one must degrade to the request going out exactly as it did before the plugin
 * existed. Turning its absence into a failed model call would invent a new
 * outage where the design promises a lossless fallback. So "no headers" is
 * spelled `{ headers: {} }`, and a plugin that does not recognise the question
 * throws — which the broadcast reads as no answer.
 */
export const modelCallHeadersAnswerSchema = z.object({
	headers: z.record(z.string()),
})

export type ModelCallHeadersAnswer = z.infer<typeof modelCallHeadersAnswerSchema>
