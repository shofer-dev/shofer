// Fork behavior against a scripted client: the feedback call ends the fork; prose
// with no call coerces to silent (never an invented finding); tool rounds dispatch
// through the executor with the grant re-checked per call; the shared/private split
// (system block vs messages) holds; a hung provider is cancelled as a timeout.

import { FEEDBACK_TOOL_NAME, type DetectorDef, type TokenUsage } from "../src/types.js"
import type { ChatMessage, ForkChatResult, ForkClient } from "../src/llm.js"
import type { ToolDispatcher } from "../src/tool-executor.js"
import { buildForkTail, parseFeedback, runFork } from "../src/fork.js"

function detector(overrides: Partial<DetectorDef> = {}): DetectorDef {
	return {
		slug: "default",
		enabled: true,
		system: "You are watching.",
		tools: ["read_file"],
		exec: [],
		cadenceNth: 1,
		confidenceFloor: 0.65,
		deadlineS: 0,
		pilot: false,
		structural: false,
		...overrides,
	}
}

/** A complete usage record — providers always report all four through ForkLlmClient. */
function usage(prompt: number, completion: number, cacheRead = 0, cacheWrite = 0): TokenUsage {
	return { prompt, completion, cacheRead, cacheWrite }
}

function feedbackCall(args: Record<string, unknown>): ForkChatResult {
	return {
		text: "",
		toolCalls: [{ id: "t1", name: FEEDBACK_TOOL_NAME, arguments: JSON.stringify(args) }],
		tokens: usage(10, 5),
		costUsd: 0.001,
	}
}

function scriptedClient(
	replies: ForkChatResult[],
): ForkClient & { requests: ChatMessage[][]; systemPrompts: string[] } {
	const requests: ChatMessage[][] = []
	const systemPrompts: string[] = []
	let i = 0
	return {
		requests,
		systemPrompts,
		async chat(opts) {
			requests.push(opts.messages)
			systemPrompts.push(opts.systemPrompt)
			const reply = replies[Math.min(i, replies.length - 1)]!
			i++
			return reply
		},
	}
}

const noTools: ToolDispatcher = {
	async execute() {
		return { content: "unused", isError: false }
	},
}

describe("runFork", () => {
	it("returns the parsed feedback when the model calls the tool", async () => {
		const client = scriptedClient([
			feedbackCall({ verdict: "advise", headline: "h", evidence: ["e"], confidence: 0.8 }),
		])
		const outcome = await runFork({
			detector: detector(),
			systemPrompt: "sys",
			tail: "tail",
			tools: [],
			client,
			executor: noTools,
			deadlineS: 5,
		})
		expect(outcome.verdictKind).toBe("ok")
		expect(outcome.feedback).toMatchObject({ verdict: "advise", headline: "h", confidence: 0.8 })
		expect(outcome.tokens).toEqual(usage(10, 5))
	})

	it("prose with no tool call coerces to silent", async () => {
		const client = scriptedClient([
			{ text: "everything looks fine to me!", toolCalls: [], tokens: usage(1, 1), costUsd: 0 },
		])
		const outcome = await runFork({
			detector: detector(),
			systemPrompt: "sys",
			tail: "tail",
			tools: [],
			client,
			executor: noTools,
			deadlineS: 5,
		})
		expect(outcome.feedback.verdict).toBe("silent")
	})

	it("dispatches tool rounds through the executor and feeds results back", async () => {
		const executed: string[] = []
		const executor: ToolDispatcher = {
			async execute(_d, name, args) {
				executed.push(`${name}:${args}`)
				return { content: "package health", isError: false }
			},
		}
		const client = scriptedClient([
			{
				text: "",
				toolCalls: [{ id: "r1", name: "read_file", arguments: '{"path":"a.go"}' }],
				tokens: usage(1, 1),
				costUsd: 0,
			},
			feedbackCall({ verdict: "silent" }),
		])
		const outcome = await runFork({
			detector: detector(),
			systemPrompt: "sys",
			tail: "tail",
			tools: [],
			client,
			executor,
			deadlineS: 5,
		})
		expect(executed).toEqual(['read_file:{"path":"a.go"}'])
		expect(outcome.verdictKind).toBe("ok")
		// The second request carries the tool round-trip after the tail.
		const second = client.requests[1]!
		expect(second.length).toBe(3) // user tail, assistant tool_use, user tool_result
	})

	it("sends the shared systemPrompt untouched and puts ONLY the tail in messages", async () => {
		// The cache economics rest on this split: everything shared rides the system
		// block (which every caching provider marks as a breakpoint), and the fork's
		// messages carry nothing but its own private tail.
		const client = scriptedClient([feedbackCall({ verdict: "silent" })])
		await runFork({
			detector: detector(),
			systemPrompt: "SHARED PROMPT + DIGEST",
			tail: "my private tail",
			tools: [],
			client,
			executor: noTools,
			deadlineS: 5,
		})
		expect(client.systemPrompts).toEqual(["SHARED PROMPT + DIGEST"])
		expect(client.requests[0]).toEqual([{ role: "user", content: "my private tail" }])
	})

	it("a hung provider is cancelled at the hard deadline and reported as timeout", async () => {
		const client: ForkClient = {
			chat(opts) {
				return new Promise((_resolve, reject) => {
					opts.signal?.addEventListener("abort", () => {
						const err = new Error("aborted")
						err.name = "AbortError"
						reject(err)
					})
				})
			},
		}
		const outcome = await runFork({
			detector: detector(),
			systemPrompt: "sys",
			tail: "tail",
			tools: [],
			client,
			executor: noTools,
			// deadline -8 + grace 8 ⇒ aborts almost immediately, keeping the test fast.
			deadlineS: -7.9,
		})
		expect(outcome.verdictKind).toBe("timeout")
		expect(outcome.feedback.verdict).toBe("silent")
	})
})

describe("parseFeedback", () => {
	it("accepts the full envelope with outcomes", () => {
		const parsed = parseFeedback(
			JSON.stringify({
				verdict: "silent",
				outcomes: [{ advice_id: "a1", verdict: "adopted", evidence: ["go test @ 14:22"] }],
			}),
		)
		expect(parsed.outcomes).toEqual([{ adviceId: "a1", verdict: "adopted", evidence: ["go test @ 14:22"] }])
	})

	it("malformed json / unknown verdicts coerce to silent", () => {
		expect(parseFeedback("{oops").verdict).toBe("silent")
		expect(parseFeedback('{"verdict":"panic"}').verdict).toBe("silent")
	})
})

describe("buildForkTail", () => {
	it("states budgets, grant, config and open advisories", () => {
		const tail = buildForkTail(
			detector({ exec: ["git status --short"], tools: ["read_file", "execute_command"], config: { q: 1 } }),
			[
				{
					id: "a1",
					taskId: "t",
					detector: "default",
					headline: "old advice",
					body: "",
					confidence: 0.7,
					evidence: [],
					dedupKey: "k",
					staleIf: [],
					humanOnly: false,
					finishGate: false,
					generatedAt: 0,
					deliveredAt: 1,
				},
			],
			12,
			700,
		)
		expect(tail).toContain("~12s")
		expect(tail).toContain("~700 characters")
		expect(tail).toContain("read_file, execute_command")
		expect(tail).toContain("git status --short")
		expect(tail).toContain('{"q":1}')
		expect(tail).toContain('a1: "old advice"')
	})
})
