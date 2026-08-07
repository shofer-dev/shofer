/**
 * The two host-side decisions behind `ctx.agent.spawn` that are worth reading on
 * their own: what a spawned task's ANSWER is, and what happens when a caller
 * names a mode the host does not define.
 *
 * Both exist because a plugin driving Shofer as a durable job
 * ([`docs/plugin_system.md`](../../../docs/plugin_system.md) §14) has no user
 * watching the chat. Everything it learns about the run comes back through
 * `PluginTaskResult`, so a value the host declines to put there is a value
 * nobody can recover — and a mode the host quietly substitutes is an agent the
 * caller never asked for, reporting success.
 */

import type { ShoferMessage } from "@shofer/types"
import { PLUGIN_UNKNOWN_MODE_ERROR } from "@shofer/types"

/**
 * The final answer of a task, as `attempt_completion` rendered it.
 *
 * `attempt_completion` writes the result as a `completion_result` say BEFORE it
 * emits `TaskCompleted` (and its streaming half updates that same row in
 * place), so the last such message on the task is the settled answer. Reading
 * the live message list rather than the persisted history is deliberate: the
 * history write and the completion event are not ordered against each other on
 * every path, and a result that arrives one write too early is indistinguishable
 * from no result at all.
 *
 * `undefined` when the task ended without declaring one — an abort, or a loop
 * that stopped for another reason. The caller must be able to tell "no answer"
 * from "an empty answer", which is why this returns `undefined` rather than "".
 */
export function lastCompletionResult(task: { shoferMessages: ShoferMessage[] }): string | undefined {
	const messages = task.shoferMessages
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.type === "say" && message.say === "completion_result") {
			return message.text
		}
	}
	return undefined
}

/**
 * The error `ctx.agent.spawn` rejects with when `opts.mode` names a mode the
 * host does not define.
 *
 * It carries the available slugs because the caller is a plugin, not a person
 * at a settings panel: the whole diagnosis has to fit in the rejection. Its
 * `name` is the well-known {@link PLUGIN_UNKNOWN_MODE_ERROR}, which is what lets
 * a caller distinguish "this configuration can never work" from a transient
 * failure worth retrying.
 */
export function unknownModeError(mode: string, available: readonly string[]): Error {
	const known = available.length > 0 ? available.join(", ") : "(none — no modes are defined at all)"
	const error = new Error(
		`ctx.agent.spawn: no mode "${mode}" is defined on this node. Available modes: ${known}. ` +
			`The task was NOT started: running it in a different mode would give it a different tool set ` +
			`and a different provider profile than the caller asked for.`,
	)
	error.name = PLUGIN_UNKNOWN_MODE_ERROR
	return error
}
