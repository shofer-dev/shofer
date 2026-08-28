/**
 * The host-side decisions behind `ctx.agent.spawn` and `ctx.agent.deliver` that are
 * worth reading on their own: what a spawned task's ANSWER is, what happens when a
 * caller names a mode the host does not define, what happens at the parallel-task
 * limit, and how a plugin's partial envelope is completed into a real one.
 *
 * Both exist because a plugin driving Shofer as a durable job
 * ([`docs/plugin_system.md`](../../../docs/plugin_system.md) §14) has no user
 * watching the chat. Everything it learns about the run comes back through
 * `PluginTaskResult`, so a value the host declines to put there is a value
 * nobody can recover — and a mode the host quietly substitutes is an agent the
 * caller never asked for, reporting success.
 */

import type { Envelope, PluginDeliverInput, ShoferMessage } from "@shofer/types"
import { PLUGIN_TASK_LIMIT_ERROR, PLUGIN_UNKNOWN_MODE_ERROR } from "@shofer/types"

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

/**
 * The error `ctx.agent.spawn` rejects with when starting the task would exceed the
 * host's global parallel-task limit.
 *
 * Its `name` is the well-known {@link PLUGIN_TASK_LIMIT_ERROR} for the opposite reason
 * {@link unknownModeError}'s exists: this refusal IS transient, and a caller that can
 * recognise it can do the work another way instead of failing the event. shofer-mesh's
 * `spawn` subscriptions catch it and deliver the event as an ordinary notification.
 * The numbers stay in the message for whoever reads the log.
 */
export function taskLimitError(active: number, limit: number): Error {
	const error = new Error(
		`Task limit reached: ${active}/${limit} tasks are currently running, so no new task was started.`,
	)
	error.name = PLUGIN_TASK_LIMIT_ERROR
	return error
}

/**
 * Complete a plugin's {@link PluginDeliverInput} into the {@link Envelope} the mailbox
 * accepts.
 *
 * Three fields are the HOST's and never the plugin's, and each for its own reason:
 * `to`, because a plugin that could address a task it was not given could reach any task
 * on the node; `sent_at`, because only the host knows when it accepted the envelope; and
 * `id` when the caller supplied none. A caller that DID supply one keeps it verbatim —
 * that is its upstream idempotency key (an A2A `message_id`, a Temporal message id), and
 * minting over it would turn every retry into a redelivery.
 *
 * `taskId` is dropped here rather than passed through: it is the plugin's way of naming a
 * target, and once the target is resolved the envelope carries the resolved `to` instead.
 */
export function completeEnvelope(
	input: PluginDeliverInput,
	to: string,
	mintId: () => string,
	now: number = Date.now(),
): Envelope {
	const { taskId: _taskId, id, ...fields } = input
	return { ...fields, id: id ?? mintId(), to, sent_at: now }
}
