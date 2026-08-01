import { describe, it, expect } from "vitest"

import { LiveMemoryAgent, type LiveMemoryAgentOptions } from "../agent.js"
import { MemoryLlmClient } from "../memory-llm.js"
import { LiveMemoryToolExecutor } from "../tool-executor.js"
import { matchesFileGlobs } from "../main.js"
import type { PluginAi, HostFileSystem, FindFilesOptions } from "@shofer/types"

/**
 * Specs for the KV-cache-preserving frozen volatile block + observation deltas,
 * the verbatim preload docs, the empty-answer guard, and the `fileGlobs`
 * monitoring-scope matcher.
 */

const CWD = "/ws"

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

/** An `ctx.ai` that replays scripted answers and CAPTURES every system prompt. */
function makeCapturingAi(answers: string[]): { ai: PluginAi; systemPrompts: string[] } {
	let i = 0
	const systemPrompts: string[] = []
	const handler = {
		createMessage(systemPrompt: string) {
			systemPrompts.push(systemPrompt)
			const text = answers[Math.min(i, answers.length - 1)]!
			i++
			async function* gen() {
				if (text) yield { type: "text", text }
				yield { type: "usage", inputTokens: 5, outputTokens: 2 }
			}
			return gen()
		},
		getModel: () => ({ id: "test-model", info: {} }),
	}
	return {
		ai: {
			buildHandler: async () => handler as unknown as never,
			embed: async (texts: string[]) => texts.map(() => [0]),
			hasConsent: () => true,
		},
		systemPrompts,
	}
}

function makeAgent(ai: PluginAi, fs: HostFileSystem, overrides: Partial<LiveMemoryAgentOptions> = {}) {
	const agent = new LiveMemoryAgent({
		llm: new MemoryLlmClient(ai),
		executor: new LiveMemoryToolExecutor({ cwd: CWD, fs }),
		workspacePath: CWD,
		readFile: (abs) => fs.readFile(abs),
		...overrides,
	})
	agent.initialize()
	return agent
}

describe("frozen volatile block + observation deltas", () => {
	it("re-sends a byte-identical system prompt across questions while the memory context mutates", async () => {
		let memoryVersion = 0
		const { ai, systemPrompts } = makeCapturingAi(["a1", "a2"])
		const agent = makeAgent(ai, makeFs(), {
			// Mutates on every read — under per-question rendering the prompt would differ.
			memoryContextProvider: () => `memory v${memoryVersion++}`,
			memoryDeltaProvider: () => "",
		})
		await agent.askQuestion("q1")
		await agent.askQuestion("q2")
		expect(systemPrompts).toHaveLength(2)
		expect(systemPrompts[0]).toBe(systemPrompts[1]) // frozen: prefix cache preserved
		expect(systemPrompts[0]).toContain("memory v0") // the freeze-time render
	})

	it("appends a memory-update delta message instead of mutating the frozen block", async () => {
		const { ai, systemPrompts } = makeCapturingAi(["a1", "a2"])
		let delta = ""
		const agent = makeAgent(ai, makeFs(), {
			memoryContextProvider: () => "memory v0",
			memoryDeltaProvider: () => delta,
		})
		await agent.askQuestion("q1")
		delta = "- [edit] docs/a.md (via write_to_file)"
		await agent.askQuestion("q2")

		expect(systemPrompts[0]).toBe(systemPrompts[1]) // block untouched
		const obs = agent.getMessages().filter((m) => m.metadata?.observation === true)
		expect(obs).toHaveLength(1)
		expect(obs[0]!.content).toContain("docs/a.md")
		expect(obs[0]!.content).toContain("Memory update")
	})

	it("re-freezes after invalidateFrozenPrefix (the compactor's summary rewrite)", async () => {
		let memoryVersion = 0
		const { ai, systemPrompts } = makeCapturingAi(["a1", "a2"])
		const agent = makeAgent(ai, makeFs(), {
			memoryContextProvider: () => `memory v${memoryVersion++}`,
		})
		await agent.askQuestion("q1")
		agent.invalidateFrozenPrefix()
		await agent.askQuestion("q2")
		expect(systemPrompts[0]).toContain("memory v0")
		expect(systemPrompts[1]).toContain("memory v1") // fresh render after invalidation
	})
})

describe("preloaded reference documents", () => {
	it("renders preloaded docs verbatim in the system prompt", async () => {
		const { ai, systemPrompts } = makeCapturingAi(["a1"])
		const agent = makeAgent(ai, makeFs(), {
			preloadedDocs: [
				{ filePath: "docs/a.md", content: "# Alpha doc body", contentHash: "h1", tokenEstimate: 5 },
			],
		})
		await agent.askQuestion("q1")
		expect(systemPrompts[0]).toContain("PRE-LOADED REFERENCE DOCUMENTS")
		expect(systemPrompts[0]).toContain("#### docs/a.md")
		expect(systemPrompts[0]).toContain("# Alpha doc body")
		expect(agent.preloadedDocCount).toBe(1)
		expect(agent.preloadedTokenEstimate).toBe(5)
	})

	it("resetContext re-reads the preload docs and clears the window", async () => {
		const { ai, systemPrompts } = makeCapturingAi(["a1", "a2"])
		let version = 1
		const agent = makeAgent(ai, makeFs(), {
			preloadedDocs: [{ filePath: "docs/a.md", content: "v1 body", contentHash: "h", tokenEstimate: 2 }],
			reloadPreloadedDocs: async () => [
				{ filePath: "docs/a.md", content: `v${++version} body`, contentHash: "h2", tokenEstimate: 2 },
			],
		})
		await agent.askQuestion("q1")
		expect(agent.getMessages().length).toBeGreaterThan(0)
		await agent.resetContext()
		expect(agent.getMessages()).toHaveLength(0) // history trail dropped
		await agent.askQuestion("q2")
		expect(systemPrompts[1]).toContain("v2 body") // docs re-read fresh
	})
})

describe("empty-answer guard", () => {
	it("does not persist a question whose answer came back empty", async () => {
		const { ai } = makeCapturingAi([""]) // provider produced no visible text
		const agent = makeAgent(ai, makeFs())
		const result = await agent.askQuestion("q1")
		expect(result.answer).toBe("")
		// The empty user+assistant pair must NOT poison the window (some providers
		// reject a history containing an empty assistant message).
		expect(agent.getMessages().filter((m) => m.role === "assistant" && !m.content.trim())).toHaveLength(0)
		expect(agent.getMessages().filter((m) => m.role === "user")).toHaveLength(0)
	})
})

describe("matchesFileGlobs (monitoring scope)", () => {
	it("matches fnmatch-style with * crossing separators; empty list matches everything", () => {
		expect(matchesFileGlobs("src/main.py", [])).toBe(true)
		expect(matchesFileGlobs("docs/a.md", ["docs/*.md"])).toBe(true)
		expect(matchesFileGlobs("docs/sub/a.md", ["docs/*.md"])).toBe(true) // * crosses /
		expect(matchesFileGlobs("src/main.py", ["docs/*.md"])).toBe(false)
		expect(matchesFileGlobs("README.md", ["docs/*.md", "README.md"])).toBe(true)
		expect(matchesFileGlobs("docs/a.txt", ["docs/*.md"])).toBe(false)
		expect(matchesFileGlobs("docs/x.md", ["docs/?.md"])).toBe(true)
		expect(matchesFileGlobs("docs/xy.md", ["docs/?.md"])).toBe(false)
	})
})
