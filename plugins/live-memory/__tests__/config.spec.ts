import { describe, it, expect } from "vitest"

import type { PluginAi, HostFileSystem, FindFilesOptions } from "@shofer/types"

import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_CONTEXT_FILL_THRESHOLD } from "../types.js"

import { LiveMemoryAgent } from "../agent.js"
import { MemoryLlmClient } from "../memory-llm.js"
import { LiveMemoryToolExecutor } from "../tool-executor.js"
import { ContextWindow } from "../context-window.js"

/**
 * Stage-F config parity. The plugin config keys `maxContextTokens` +
 * `contextFillThreshold` must flow through `LiveMemoryAgent` into its
 * {@link ContextWindow} budget/threshold (main.ts reads them from `ctx.config`
 * and passes them here). Also pins the config→window mapping directly on the
 * ContextWindow, and that the manifest defaults equal the shared constants.
 */

const CWD = "/ws"

function makeFs(): HostFileSystem {
	const map = new Map<string, string>()
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

function makeAi(): PluginAi {
	const handler = {
		createMessage() {
			async function* gen() {
				yield { type: "text", text: "ok" }
				yield { type: "usage", inputTokens: 0, outputTokens: 0 }
			}
			return gen()
		},
		getModel: () => ({ id: "test", info: {} }),
	}
	return {
		buildHandler: async () => handler as unknown as never,
		embed: async (texts: string[]) => texts.map(() => [0]),
		hasConsent: () => true,
	}
}

function makeAgent(opts: { maxContextTokens?: number; contextFillThreshold?: number }) {
	const fs = makeFs()
	const agent = new LiveMemoryAgent({
		llm: new MemoryLlmClient(makeAi()),
		executor: new LiveMemoryToolExecutor({ cwd: CWD, fs }),
		workspacePath: CWD,
		readFile: (abs) => fs.readFile(abs),
		...opts,
	})
	agent.initialize()
	return agent
}

describe("Stage-F config parity — maxContextTokens + contextFillThreshold", () => {
	it("threads a configured budget + threshold into the agent's ContextWindow", () => {
		const agent = makeAgent({ maxContextTokens: 32_000, contextFillThreshold: 0.5 })
		expect(agent.maxContextTokens).toBe(32_000)
		expect(agent.contextFillThreshold).toBe(0.5)
		expect(agent.getContextUsage().maxTokens).toBe(32_000)
	})

	it("falls back to the shared defaults when the config keys are omitted", () => {
		const agent = makeAgent({})
		expect(agent.maxContextTokens).toBe(DEFAULT_MAX_CONTEXT_TOKENS)
		expect(agent.contextFillThreshold).toBe(DEFAULT_CONTEXT_FILL_THRESHOLD)
	})

	it("uses the configured threshold to decide 'nearly full' (not the default)", () => {
		// A window ~60% full is nearly-full at threshold 0.5 but not at 0.8.
		const maxContextTokens = 1_000
		const halfWindow = new ContextWindow({ maxContextTokens, contextFillThreshold: 0.5 })
		const eightyWindow = new ContextWindow({ maxContextTokens, contextFillThreshold: 0.8 })
		const filler = "x".repeat(2_400) // ~600 tokens at 4 chars/token
		const msg = {
			id: "m1",
			role: "user" as const,
			content: filler,
			timestamp: 0,
			parts: [{ kind: "text" as const, text: filler }],
		}
		halfWindow.appendMessage(msg)
		eightyWindow.appendMessage({ ...msg, id: "m2" })
		expect(halfWindow.isNearlyFull).toBe(true)
		expect(eightyWindow.isNearlyFull).toBe(false)
	})

	it("manifest defaults equal the shared constants", () => {
		expect(DEFAULT_MAX_CONTEXT_TOKENS).toBe(128_000)
		expect(DEFAULT_CONTEXT_FILL_THRESHOLD).toBe(0.8)
	})
})
