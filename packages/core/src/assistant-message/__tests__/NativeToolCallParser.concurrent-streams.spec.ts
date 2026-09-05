import type { ToolName } from "@shofer/types"

import { NativeToolCallParser } from "../NativeToolCallParser.js"

/**
 * Two tasks streaming at once in ONE process must assemble their tool-call
 * arguments independently.
 *
 * A headless worker (the L2 worker, `shofer serve`) runs many tasks per
 * process, and an OpenAI-compatible tool-call stream keys its argument
 * fragments by a per-stream wire `index` that starts at 0 for EVERY stream —
 * so two concurrent streams both say `index: 0`. Assembly state shared across
 * tasks therefore collides on that key, and the collision is not a dropped
 * chunk: the second stream's fragments are re-emitted under the FIRST
 * stream's tool-call id and appended to the first stream's accumulator,
 * splicing one tool call's payload character-by-character through another's.
 *
 * Reproduces integration-tests/bugs_found.md § "2026-08-25 — l2-subtasks
 * (a background child's tool-call arguments splice into its parent's)".
 */

/** The wire shape every OpenAI-compatible provider yields as `tool_call_partial`. */
interface RawToolCallChunk {
	index: number
	id?: string
	name?: string
	arguments?: string
}

/**
 * One task's half of the streaming pipeline, exactly as `Task.ts` drives it:
 * raw chunk → start/delta/end events → per-tool-call argument accumulation.
 *
 * Each consumer owns its own parser, which is the invariant under test — a
 * shared one is what splices.
 */
class StreamConsumer {
	private readonly parser = new NativeToolCallParser()
	/** Finalized tool calls, in the order the stream completed them. */
	public readonly finalized: Array<{ id: string; name: string; args: unknown }> = []
	/** Ids this consumer was told a tool call started for. */
	public readonly started: string[] = []

	public feed(chunk: RawToolCallChunk): void {
		for (const event of this.parser.processRawChunk(chunk)) {
			if (event.type === "tool_call_start") {
				this.started.push(event.id)
				this.parser.startStreamingToolCall(event.id, event.name as ToolName)
			} else if (event.type === "tool_call_delta") {
				this.parser.processStreamingChunk(event.id, event.delta)
			} else if (event.type === "tool_call_end") {
				this.finalizeOne(event.id)
			}
		}
	}

	/** The end-of-stream drain `Task.ts` performs after the last chunk. */
	public finish(): void {
		for (const event of this.parser.finalizeRawChunks()) {
			if (event.type === "tool_call_end") {
				this.finalizeOne(event.id)
			}
		}
	}

	/** A new API request on the SAME task clears only that task's state. */
	public startNewRequest(): void {
		this.parser.clearAllStreamingToolCalls()
		this.parser.clearRawChunkState()
	}

	private finalizeOne(id: string): void {
		const toolUse = this.parser.finalizeStreamingToolCall(id)
		if (!toolUse || toolUse.type !== "tool_use") {
			return
		}
		this.finalized.push({ id, name: toolUse.name, args: toolUse.nativeArgs })
	}
}

/** Split a JSON payload into the ~8-character fragments a provider streams. */
function fragments(json: string, size = 8): string[] {
	const out: string[] = []
	for (let i = 0; i < json.length; i += size) {
		out.push(json.slice(i, i + size))
	}
	return out
}

describe("NativeToolCallParser — concurrent streams in one process", () => {
	const parentArgs = {
		mode: "orchestrator",
		message: "Call wait once and wait for a message. When it arrives, immediately call report.",
	}
	const childArgs = {
		question: "Which codeword should I report?",
		follow_up: [{ text: "The attempt_completion one" }],
	}

	it("keeps a parent's new_task arguments free of a concurrent child's ask_followup_question payload", () => {
		const parent = new StreamConsumer()
		const child = new StreamConsumer()

		// Both streams open a tool call at wire index 0 — every stream's first
		// tool call does, which is precisely why the index cannot be a
		// process-wide key.
		parent.feed({ index: 0, id: "call_parent", name: "new_task" })
		child.feed({ index: 0, id: "call_child", name: "ask_followup_question" })

		const parentFragments = fragments(JSON.stringify(parentArgs))
		const childFragments = fragments(JSON.stringify(childArgs))
		const rounds = Math.max(parentFragments.length, childFragments.length)

		// Interleave fragment-by-fragment: the two tasks are advancing their
		// own streams on the same event loop.
		for (let i = 0; i < rounds; i++) {
			if (i < parentFragments.length) {
				parent.feed({ index: 0, arguments: parentFragments[i] })
			}
			if (i < childFragments.length) {
				child.feed({ index: 0, arguments: childFragments[i] })
			}
		}

		parent.finish()
		child.finish()

		expect(parent.started).toEqual(["call_parent"])
		expect(child.started).toEqual(["call_child"])

		expect(parent.finalized).toHaveLength(1)
		expect(parent.finalized[0]!.name).toBe("new_task")
		expect(parent.finalized[0]!.args).toMatchObject({
			mode: parentArgs.mode,
			message: parentArgs.message,
		})

		expect(child.finalized).toHaveLength(1)
		expect(child.finalized[0]!.name).toBe("ask_followup_question")
		expect(child.finalized[0]!.args).toMatchObject({
			question: childArgs.question,
			follow_up: childArgs.follow_up,
		})
	})

	it("does not let one task's new request clear another task's in-flight assembly", () => {
		// A fragment chunk carries only `index` — id and name arrive on the
		// first fragment alone — so a tracker wiped mid-stream drops every
		// remaining fragment silently, truncating the arguments.
		const streaming = new StreamConsumer()
		const other = new StreamConsumer()

		streaming.feed({ index: 0, id: "call_streaming", name: "new_task" })
		const parts = fragments(JSON.stringify(parentArgs))
		streaming.feed({ index: 0, arguments: parts[0] })

		// A second task begins an API request while the first is mid-stream.
		other.startNewRequest()

		for (const part of parts.slice(1)) {
			streaming.feed({ index: 0, arguments: part })
		}
		streaming.finish()

		expect(streaming.finalized).toHaveLength(1)
		expect(streaming.finalized[0]!.args).toMatchObject({
			mode: parentArgs.mode,
			message: parentArgs.message,
		})
	})
})
