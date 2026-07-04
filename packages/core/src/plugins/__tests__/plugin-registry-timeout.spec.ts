import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInMemoryHost, setHost } from "@shofer/types"

import { PluginRegistry, PLUGIN_HOOK_TIMEOUT_MS } from "../plugin-registry.js"

describe("PluginRegistry per-hook timeout (owner decision #8, step 2.5)", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("aborts a slow registerTools and keeps other plugins' tools", async () => {
		const reg = new PluginRegistry()
		await reg.register({
			name: "slow",
			registerTools: () => new Promise(() => {}), // never resolves
		})
		await reg.register({
			name: "fast",
			registerTools: () => [{ name: "ok", description: "ok", execute: async () => "" }],
		})

		const promise = reg.collectTools()
		await vi.advanceTimersByTimeAsync(PLUGIN_HOOK_TIMEOUT_MS + 10)
		const tools = await promise
		expect(tools.map((t) => t.name)).toEqual(["ok"])
	})

	it("aborts a slow transformSystemPrompt and keeps the prior prompt", async () => {
		const reg = new PluginRegistry()
		await reg.register({ name: "p1", transformSystemPrompt: (p: string) => p + " [p1]" })
		await reg.register({ name: "slow", transformSystemPrompt: () => new Promise<string>(() => {}) })
		await reg.register({ name: "p3", transformSystemPrompt: (p: string) => p + " [p3]" })

		const promise = reg.applySystemPromptTransforms("base")
		await vi.advanceTimersByTimeAsync(PLUGIN_HOOK_TIMEOUT_MS + 10)
		const result = await promise
		// slow contributes nothing; p1 and p3 still apply in order.
		expect(result).toBe("base [p1] [p3]")
	})

	it("unregister removes a plugin so its hooks stop firing", async () => {
		const reg = new PluginRegistry()
		await reg.register({ name: "t", transformSystemPrompt: (p: string) => p + "!" })
		expect(reg.has("t")).toBe(true)
		expect(reg.unregister("t")).toBe(true)
		expect(reg.has("t")).toBe(false)
		expect(await reg.applySystemPromptTransforms("x")).toBe("x")
	})
})
