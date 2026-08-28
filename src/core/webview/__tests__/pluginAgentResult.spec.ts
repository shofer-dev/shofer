/**
 * The host-side decisions behind `ctx.agent.spawn` and `ctx.agent.deliver`: what a
 * spawned task's answer is, what an unknown mode does, what the parallel-task limit
 * does, and which envelope fields the host owns.
 *
 * Most were silent failures before they were decisions — a settled task with no
 * `output` at all, a mode slug nothing defined quietly becoming the default mode, an
 * unbounded spawn per inbound event — so the tests here are mostly about the NEGATIVE
 * cases staying loud.
 */

import type { PluginDeliverInput, ShoferMessage } from "@shofer/types"
import { PLUGIN_TASK_LIMIT_ERROR, PLUGIN_UNKNOWN_MODE_ERROR } from "@shofer/types"

import { completeEnvelope, lastCompletionResult, taskLimitError, unknownModeError } from "../pluginAgentResult"

function say(name: string, text: string): ShoferMessage {
	return { ts: 0, type: "say", say: name as ShoferMessage["say"], text }
}

describe("lastCompletionResult", () => {
	it("returns the task's completion_result text", () => {
		const task = { shoferMessages: [say("text", "thinking"), say("completion_result", '{"score":9}')] }
		expect(lastCompletionResult(task)).toBe('{"score":9}')
	})

	it("returns the LAST one, which is what a re-prompted session settles on", () => {
		const task = {
			shoferMessages: [
				say("completion_result", '{"score":3}'),
				say("text", "that was rejected"),
				say("completion_result", '{"score":9}'),
			],
		}
		expect(lastCompletionResult(task)).toBe('{"score":9}')
	})

	it("is undefined when the task declared no answer, not an empty string", () => {
		const task = { shoferMessages: [say("text", "started"), say("error", "aborted")] }
		expect(lastCompletionResult(task)).toBeUndefined()
	})

	it("preserves an empty answer as distinct from no answer", () => {
		const task = { shoferMessages: [say("completion_result", "")] }
		expect(lastCompletionResult(task)).toBe("")
	})
})

describe("unknownModeError", () => {
	it("carries the well-known name so a caller can refuse to retry it", () => {
		const err = unknownModeError("reviewer", ["code", "architect"])
		expect(err.name).toBe(PLUGIN_UNKNOWN_MODE_ERROR)
	})

	it("names the mode asked for and the modes that exist", () => {
		const err = unknownModeError("reviewer", ["code", "architect"])
		expect(err.message).toContain('"reviewer"')
		expect(err.message).toContain("code, architect")
	})

	it("says so explicitly when the node defines no modes at all", () => {
		const err = unknownModeError("reviewer", [])
		expect(err.message).toContain("no modes are defined at all")
	})
})

describe("taskLimitError", () => {
	it("carries the well-known name, so a caller can fall back instead of failing", () => {
		expect(taskLimitError(10, 10).name).toBe(PLUGIN_TASK_LIMIT_ERROR)
	})

	it("names the numbers, and says no task was started", () => {
		const err = taskLimitError(10, 10)
		expect(err.message).toContain("10/10")
		expect(err.message).toContain("no new task was started")
	})

	it("is distinguishable from the unknown-mode refusal, which is NOT transient", () => {
		expect(taskLimitError(1, 1).name).not.toBe(unknownModeError("x", []).name)
	})
})

describe("completeEnvelope", () => {
	const input: PluginDeliverInput = {
		from: "tag:system-events:test",
		kind: "notification",
		subject: "vm-12 entered Ready",
		body: "ready",
		deadline: 2_000,
		wake: false,
		plane: "bus",
	}

	it("fills the three fields the host owns", () => {
		const env = completeEnvelope(input, "task-7", () => "minted", 1_234)
		expect(env.to).toBe("task-7")
		expect(env.sent_at).toBe(1_234)
		expect(env.id).toBe("minted")
	})

	it("keeps a caller-supplied id verbatim — it is the upstream idempotency key", () => {
		const env = completeEnvelope({ ...input, id: "a2a-message-id" }, "task-7", () => "minted", 1_234)
		expect(env.id).toBe("a2a-message-id")
	})

	it("drops `taskId`: the resolved target rides on `to`, never twice", () => {
		const env = completeEnvelope({ ...input, taskId: "task-7" }, "task-7", () => "minted", 1_234)
		expect(env).not.toHaveProperty("taskId")
	})

	it("passes every other field through untouched", () => {
		const env = completeEnvelope(input, "task-7", () => "minted", 1_234)
		expect(env.from).toBe(input.from)
		expect(env.kind).toBe("notification")
		expect(env.deadline).toBe(2_000)
		expect(env.wake).toBe(false)
		expect(env.plane).toBe("bus")
	})
})
