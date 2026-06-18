import { type CompletionRating } from "@shofer/types"

import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { attemptCompletionTool, AttemptCompletionCallbacks } from "./AttemptCompletionTool"

interface WaitParams {
	rating?: string
	reason?: string
}

const ALLOWED_RATINGS = new Set<string>(["poor", "well", "excellent"])
const DEFAULT_WAIT_RATING: CompletionRating = "well"
const DEFAULT_WAIT_REASON = "waiting"

/**
 * `wait_for_message` is a thin convenience alias for `attempt_completion`.
 *
 * The agent calls `wait_for_message` (required `rating`, optional `reason`) to
 * yield control as a self-declared terminal state — specifically when it has
 * nothing to do but wait for a message/reply/signal from another task, a peer,
 * or the orchestrator (use `sleep` to wait on anything else, e.g. time or an
 * external process). It does this without having to formulate a full result.
 * We map the params onto `attempt_completion`'s params and delegate to its
 * handler, so all of the terminal/delegation/peer-sync logic lives in exactly
 * one place:
 *
 *   - reason -> result   (the human/orchestrator-facing completion message)
 *   - rating -> rating   (self-assessment of the work completed so far)
 *
 * `rating` is required by the schema; the "well" fallback below is only a
 * defensive safety net for providers that don't enforce strict schemas (e.g.
 * vscode-lm), mirroring how `attempt_completion` itself defaults a missing
 * rating (it defaults to "poor", so we must resolve the `wait_for_message`
 * default ourselves before delegating). `reason` is optional and defaults to "waiting".
 */
export class WaitTool extends BaseTool<"wait_for_message"> {
	readonly name = "wait_for_message" as const

	async execute(params: WaitParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const rating: CompletionRating =
			params.rating && ALLOWED_RATINGS.has(params.rating)
				? (params.rating as CompletionRating)
				: DEFAULT_WAIT_RATING
		const reason = params.reason?.trim() ? params.reason.trim() : DEFAULT_WAIT_REASON

		try {
			// attempt_completion is terminal: it emits TaskCompleted and sets
			// task.abort. Delegating reuses its full completion pipeline.
			await attemptCompletionTool.execute(
				{ result: reason, rating },
				task,
				callbacks as AttemptCompletionCallbacks,
			)
		} finally {
			this.resetPartialState()
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"wait_for_message">): Promise<void> {
		// Mirror attempt_completion's streaming UI: render the reason as the
		// (partial) completion result so the invocation is visible while it streams.
		const reason: string = block.params.reason ?? ""
		await task.say("completion_result", reason, undefined, block.partial)
	}
}

export const waitTool = new WaitTool()
