/**
 * The two host-side decisions behind `ctx.agent.spawn`: what a spawned task's
 * answer is, and what an unknown mode does.
 *
 * Both were silent failures before they were decisions — a settled task with no
 * `output` at all, and a mode slug nothing defined quietly becoming the default
 * mode — so the tests here are mostly about the NEGATIVE cases staying loud.
 */

import type { ShoferMessage } from "@shofer/types"
import { PLUGIN_UNKNOWN_MODE_ERROR } from "@shofer/types"

import { lastCompletionResult, unknownModeError } from "../pluginAgentResult"

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
