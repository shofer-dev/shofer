import { describe, it, expect, vi } from "vitest"

import { LiveMemoryAgent, MAX_AGENT_ITERATIONS, buildPluginToolCatalog, type LiveMemoryAgentOptions } from "../agent.js"
import { MemoryLlmClient } from "../memory-llm.js"
import { LiveMemoryToolExecutor } from "../tool-executor.js"
import { LIVE_MEMORY_PLUGIN_READ_TOOLS } from "../tool-executor.js"
import type { PluginAi, HostFileSystem, FindFilesOptions } from "@shofer/types"

/**
 * Stage-C agent-loop parity tests. A **stub `ctx.ai` handler** replays a fixed tool-use
 * transcript (deterministic) so we can assert the loop does tool round-trips + terminates,
 * caps at {@link MAX_AGENT_ITERATIONS}, accrues + evicts context, serializes + times out
 * via the QuestionQueue, accumulates cost, and that clearContext resets — all against the
 * REAL {@link MemoryLlmClient} / {@link LiveMemoryToolExecutor} / ContextWindow / QuestionQueue.
 */

interface Turn {
	text?: string
	reasoning?: string
	toolCalls?: Array<{ id: string; name: string; args: string }>
	usage?: { input: number; output: number }
}

/** A scripted `ctx.ai`: each `createMessage` (one agent iteration) replays the next turn. */
function makeScriptedAi(
	turns: Turn[],
	opts: { model?: { id: string; info?: Record<string, unknown> } } = {},
): { ai: PluginAi; callCount: () => number; systemPrompts: string[]; userTurns: string[] } {
	let i = 0
	const systemPrompts: string[] = []
	const userTurns: string[] = []
	const handler = {
		createMessage(systemPrompt: string, messages: Array<{ role: string; content: unknown }>) {
			systemPrompts.push(systemPrompt)
			const last = messages[messages.length - 1]
			if (typeof last?.content === "string") userTurns.push(last.content)
			const turn = turns[Math.min(i, turns.length - 1)]!
			i++
			async function* gen() {
				if (turn.reasoning) yield { type: "reasoning", text: turn.reasoning }
				if (turn.text) yield { type: "text", text: turn.text }
				for (const tc of turn.toolCalls ?? []) {
					yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.args }
				}
				const u = turn.usage ?? { input: 0, output: 0 }
				yield { type: "usage", inputTokens: u.input, outputTokens: u.output }
			}
			return gen()
		},
		getModel: () => opts.model ?? { id: "test-model", info: {} },
	}
	const ai: PluginAi = {
		buildHandler: async () => handler as unknown as never,
		embed: async (texts: string[]) => texts.map(() => [0]),
		hasConsent: () => true,
	}
	return { ai, callCount: () => i, systemPrompts, userTurns }
}

/** An echo `ctx.ai`: yields `echo:<last user message>` so we can trace question order. */
function makeEchoAi(): PluginAi {
	const handler = {
		createMessage(_systemPrompt: string, messages: Array<{ role: string; content: unknown }>) {
			const last = messages[messages.length - 1]
			const q = typeof last?.content === "string" ? last.content : "(structured)"
			async function* gen() {
				yield { type: "text", text: `echo:${q}` }
				yield { type: "usage", inputTokens: 1, outputTokens: 1 }
			}
			return gen()
		},
		getModel: () => ({ id: "echo", info: {} }),
	}
	return {
		buildHandler: async () => handler as unknown as never,
		embed: async (texts: string[]) => texts.map(() => [0]),
		hasConsent: () => true,
	}
}

/** A never-terminating `ctx.ai` that keeps streaming until the AbortSignal fires. */
function makeHangingAi(): PluginAi {
	const handler = {
		createMessage() {
			async function* gen() {
				yield { type: "text", text: "start" }
				for (;;) {
					await new Promise((r) => setTimeout(r, 5))
					yield { type: "text", text: "." }
				}
			}
			return gen()
		},
		getModel: () => ({ id: "hang", info: {} }),
	}
	return {
		buildHandler: async () => handler as unknown as never,
		embed: async (texts: string[]) => texts.map(() => [0]),
		hasConsent: () => true,
	}
}

const CWD = "/ws"

/** Minimal in-memory {@link HostFileSystem} keyed by absolute path. */
function makeFs(files: Record<string, string> = {}): HostFileSystem {
	const map = new Map(Object.entries(files))
	return {
		async readFile(p) {
			const c = map.get(p)
			if (c === undefined) throw new Error(`ENOENT: ${p}`)
			return c
		},
		async writeFile(p, content) {
			map.set(p, content)
		},
		async exists(p) {
			return map.has(p)
		},
		async mkdir() {},
		async delete(p) {
			map.delete(p)
		},
		async findFiles(_pattern: string, _opts: FindFilesOptions) {
			return [...map.keys()]
		},
	}
}

function makeExecutor(fs: HostFileSystem): LiveMemoryToolExecutor {
	return new LiveMemoryToolExecutor({ cwd: CWD, fs })
}

function makeAgent(ai: PluginAi, fs: HostFileSystem, overrides: Partial<LiveMemoryAgentOptions> = {}) {
	const agent = new LiveMemoryAgent({
		llm: new MemoryLlmClient(ai),
		executor: makeExecutor(fs),
		workspacePath: CWD,
		// Wire contextFiles loading to the in-memory fs (default is node fs).
		readFile: (abs) => fs.readFile(abs),
		...overrides,
	})
	agent.initialize()
	return agent
}

describe("LiveMemoryAgent (Stage-C agent loop)", () => {
	it("exposes the read-tool catalog (parity with LIVE_MEMORY_PLUGIN_READ_TOOLS)", () => {
		const catalog = buildPluginToolCatalog()
		expect(catalog.map((t) => t.function.name).sort()).toEqual([...LIVE_MEMORY_PLUGIN_READ_TOOLS].sort())
		for (const t of catalog) {
			expect(t.type).toBe("function")
			expect(t.function.parameters).toBeTruthy()
		}
	})

	it("initializes to Ready and reports availability", () => {
		const agent = makeAgent(makeEchoAi(), makeFs())
		expect(agent.state).toBe("Ready")
		expect(agent.isLiveMemoryAvailable).toBe(true)
	})

	it("does tool round-trips then terminates when the model answers with no tool calls", async () => {
		const { ai, callCount } = makeScriptedAi([
			{
				toolCalls: [{ id: "t1", name: "read_file", args: JSON.stringify({ path: "a.ts" }) }],
				usage: { input: 10, output: 2 },
			},
			{ text: "The file defines `foo`.", usage: { input: 8, output: 5 } },
		])
		const fs = makeFs({ [`${CWD}/a.ts`]: "export const foo = 1\n" })
		const agent = makeAgent(ai, fs)

		const result = await agent.askQuestion("What is in a.ts?")
		expect(result.answer).toBe("The file defines `foo`.")
		// Exactly 2 iterations: one tool round-trip + the terminating answer.
		expect(callCount()).toBe(2)
		// The tool_call/result round-trip is recorded on the assistant message.
		const assistant = agent.getMessages().find((m) => m.role === "assistant")!
		const toolPart = assistant.parts?.find((p) => p.kind === "tool_call")
		expect(toolPart && toolPart.kind === "tool_call" && toolPart.result).toContain("export const foo = 1")
		expect(agent.state).toBe("Ready")
	})

	it("caps the loop at MAX_AGENT_ITERATIONS (25) when the model never stops calling tools", async () => {
		const { ai, callCount } = makeScriptedAi([
			{
				toolCalls: [{ id: "loop", name: "read_file", args: JSON.stringify({ path: "a.ts" }) }],
				usage: { input: 1, output: 1 },
			},
		])
		const fs = makeFs({ [`${CWD}/a.ts`]: "x" })
		const agent = makeAgent(ai, fs)

		const result = await agent.askQuestion("never ends")
		expect(callCount()).toBe(MAX_AGENT_ITERATIONS)
		expect(result.answer).toContain(`${MAX_AGENT_ITERATIONS} tool iterations`)
		expect(agent.state).toBe("Ready")
	})

	it("accrues context files and evicts at the token threshold", async () => {
		const big = "x".repeat(200) // ~50 tokens each
		const fs = makeFs({
			[`${CWD}/f1.ts`]: big,
			[`${CWD}/f2.ts`]: big,
			[`${CWD}/f3.ts`]: big,
		})
		const { ai } = makeScriptedAi([{ text: "done", usage: { input: 1, output: 1 } }])
		const agent = makeAgent(ai, fs, { maxContextTokens: 120 })

		await agent.askQuestion("q", ["f1.ts", "f2.ts", "f3.ts"])
		// 3×50 tokens exceeds the 120-token budget → LRU eviction trimmed the window.
		expect(agent.contextFiles.length).toBeLessThan(3)
		expect(agent.contextFiles.length).toBeGreaterThanOrEqual(1)
		const usage = agent.getContextUsage()
		expect(usage.maxTokens).toBe(120)
		expect(usage.currentTokens).toBeLessThanOrEqual(120)
		expect(usage.isNearlyFull).toBe(true)
	})

	it("accumulates cost across iterations", async () => {
		const { ai } = makeScriptedAi([
			{
				toolCalls: [{ id: "t1", name: "read_file", args: JSON.stringify({ path: "a.ts" }) }],
				usage: { input: 100, output: 50 },
			},
			{ text: "answer", usage: { input: 80, output: 40 } },
		])
		const fs = makeFs({ [`${CWD}/a.ts`]: "x" })
		const agent = makeAgent(ai, fs)

		const result = await agent.askQuestion("q")
		expect(result.tokensUsed).toEqual({ prompt: 180, completion: 90, total: 270 })
		const cost = agent.getCostSnapshot()
		expect(cost.sessionInputTokens).toBe(180)
		expect(cost.sessionOutputTokens).toBe(90)
		expect(cost.sessionEstimatedCostUSD).toBeGreaterThan(0)
	})

	it("serializes questions through the queue (FIFO) and returns a full QuestionResult", async () => {
		const agent = makeAgent(makeEchoAi(), makeFs())
		const [a, b, c] = await Promise.all([
			agent.askQuestion("alpha"),
			agent.askQuestion("beta"),
			agent.askQuestion("gamma"),
		])
		expect(a.answer).toContain("echo:alpha")
		expect(b.answer).toContain("echo:beta")
		expect(c.answer).toContain("echo:gamma")
		// QuestionResult shape parity with the built-in.
		expect(a.contextUsage.maxTokens).toBeGreaterThan(0)
		expect(a.costSnapshot).toHaveProperty("sessionEstimatedCostUSD")
		expect(typeof a.durationMs).toBe("number")
	})

	it("times out a question via the per-entry timeout (aborts the in-flight call)", async () => {
		const agent = makeAgent(makeHangingAi(), makeFs())
		await expect(agent.askQuestion("slow", undefined, { timeoutMs: 40 })).rejects.toThrow(/aborted/i)
		// After an abort the agent returns to Ready so future questions can proceed.
		expect(agent.state).toBe("Ready")
	})

	it("clearContext resets the window and returns to Ready", async () => {
		const rebuild = vi.fn(async () => "TREE")
		const agent = makeAgent(makeEchoAi(), makeFs(), { rebuildDirectoryTree: rebuild })
		await agent.askQuestion("q")
		expect(agent.getMessages().length).toBeGreaterThan(0)

		await agent.clearContext()
		expect(agent.getMessages().length).toBe(0)
		expect(agent.contextFiles.length).toBe(0)
		expect(rebuild).toHaveBeenCalled()
		expect(agent.state).toBe("Ready")
	})

	it("drains recentlyModifiedFiles into a re-read hint on the next question, then clears it", async () => {
		const { ai, userTurns } = makeScriptedAi([{ text: "ok", usage: { input: 1, output: 1 } }])
		const agent = makeAgent(ai, makeFs())
		agent.notifyFileModified("src/changed.ts")
		agent.notifyFileModified(".shofer/ignored.ts") // filtered out (.shofer/ prefix)
		agent.notifyFileModified(".worktrees/wt-1/also-ignored.ts") // filtered out (embedded worktree)

		await agent.askQuestion("did anything change?")
		// The hint rides the trailing question turn (cache-friendly), naming the changed file.
		expect(userTurns[0]).toContain("src/changed.ts")
		expect(userTurns[0]).toContain("modified since you last read them")
		expect(userTurns[0]).not.toContain(".shofer/ignored.ts")
		expect(userTurns[0]).not.toContain(".worktrees/wt-1/also-ignored.ts")

		// The set was drained — a second question carries no stale hint.
		await agent.askQuestion("anything else?")
		expect(userTurns[1]).not.toContain("src/changed.ts")
	})

	it("streams conversation updates to the UI callback", async () => {
		const updates: number[] = []
		const { ai } = makeScriptedAi([{ text: "streamed", usage: { input: 1, output: 1 } }])
		const agent = makeAgent(ai, makeFs(), {
			onConversationUpdate: (msgs) => updates.push(msgs.length),
		})
		await agent.askQuestion("q")
		// At least the user+assistant append + the streaming-text fire.
		expect(updates.length).toBeGreaterThanOrEqual(2)
	})

	it("fires state-change callbacks across the Busy→Ready transition", async () => {
		const states: string[] = []
		const { ai } = makeScriptedAi([{ text: "ok", usage: { input: 1, output: 1 } }])
		const agent = new LiveMemoryAgent({
			llm: new MemoryLlmClient(ai),
			executor: makeExecutor(makeFs()),
			workspacePath: CWD,
			onStateChange: (e) => states.push(e.state),
		})
		agent.initialize()
		await agent.askQuestion("q")
		expect(states).toContain("Ready")
		expect(states).toContain("Busy")
	})
})
