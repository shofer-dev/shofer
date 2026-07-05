import { describe, it, expect } from "vitest"

import { buildLiveMemorySection } from "../system-section.js"
import type { MemoryData } from "../memory-store.js"
import type { ContextUsage } from "../context-window.js"

function makeData(overrides: Partial<MemoryData> = {}): MemoryData {
	return {
		version: 2,
		workspacePath: "/ws",
		updatedAt: 0,
		observations: [
			{ at: 1, kind: "edit", subject: "src/a.ts", via: "write_to_file" },
			{ at: 2, kind: "read", subject: "src/b.ts", via: "read_file" },
		],
		qa: [],
		stats: { totalObservations: 2, totalQuestions: 3 },
		messages: [],
		fileContexts: [],
		costTracking: { totalInputTokens: 0, totalOutputTokens: 0, totalTokensTruncated: 0, estimatedCostUSD: 0, lastUpdated: 0 },
		...overrides,
	}
}

const usage = (currentTokens: number, maxTokens: number, isNearlyFull: boolean): ContextUsage => ({
	currentTokens,
	maxTokens,
	fillFraction: maxTokens > 0 ? currentTokens / maxTokens : 0,
	isNearlyFull,
})

describe("buildLiveMemorySection (Stage-C prompt-section parity)", () => {
	it("advertises the tool and the retained-observation stats", () => {
		const section = buildLiveMemorySection(makeData(), { aiReady: true })
		expect(section).toContain("LIVE MEMORY")
		expect(section).toContain("ask_live_memory")
		expect(section).toContain("2 (of 2 seen) across 2 file(s)")
		expect(section).toContain("Questions answered so far:** 3")
	})

	it("shows the model label when known", () => {
		const section = buildLiveMemorySection(makeData(), { aiReady: true, modelLabel: "deepseek-flash" })
		expect(section).toContain("runs on deepseek-flash")
	})

	it("reports the context-window fill % from the live ContextWindow", () => {
		const section = buildLiveMemorySection(makeData(), { aiReady: true, contextUsage: usage(64_000, 128_000, false) })
		expect(section).toContain("Context window:")
		expect(section).toContain("~50% of 128,000 tokens")
		expect(section).not.toContain("nearly full")
	})

	it("adds the nearly-full ⚠️ when the window is near capacity", () => {
		const section = buildLiveMemorySection(makeData(), { aiReady: true, contextUsage: usage(120_000, 128_000, true) })
		expect(section).toContain("⚠️ nearly full")
		expect(section).toContain("~94% of 128,000 tokens")
	})

	it("omits the context line before the agent has run (no usage)", () => {
		const section = buildLiveMemorySection(makeData(), { aiReady: true })
		expect(section).not.toContain("Context window:")
	})

	it("gates on consent — warns when not AI-consented", () => {
		const section = buildLiveMemorySection(makeData(), { aiReady: false })
		expect(section).toContain("Not yet AI-consented")
		const ready = buildLiveMemorySection(makeData(), { aiReady: true })
		expect(ready).not.toContain("Not yet AI-consented")
	})
})
