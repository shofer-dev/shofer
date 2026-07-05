import { describe, it, expect, vi } from "vitest"
import type { ShoferPlugin } from "@shofer/types"

import { PluginRegistry } from "../plugin-registry.js"

describe("PluginRegistry (§10)", () => {
	it("registers plugins, runs initialize, and rejects duplicate names", async () => {
		const reg = new PluginRegistry()
		const init = vi.fn()
		await reg.register({ name: "a", initialize: init })
		expect(reg.list()).toEqual(["a"])
		expect(init).toHaveBeenCalledOnce()
		await expect(reg.register({ name: "a" })).rejects.toThrow(/already registered/)
	})

	it("collects tools from all plugins in registration order", async () => {
		const reg = new PluginRegistry()
		const tool = (name: string) => ({ name, description: name, execute: async () => "" })
		await reg.register({ name: "p1", registerTools: () => [tool("t1")] })
		await reg.register({ name: "p2", registerTools: async () => [tool("t2")] })
		const tools = await reg.collectTools()
		expect(tools.map((t: { name: string }) => t.name)).toEqual(["t1", "t2"])
	})

	it("threads system-prompt transforms in order", async () => {
		const reg = new PluginRegistry()
		await reg.register({ name: "p1", transformSystemPrompt: (p: string) => p + " [p1]" })
		await reg.register({ name: "p2", transformSystemPrompt: async (p: string) => p + " [p2]" })
		expect(await reg.applySystemPromptTransforms("base")).toBe("base [p1] [p2]")
	})

	it("skips a throwing transform without breaking the chain", async () => {
		const reg = new PluginRegistry()
		await reg.register({
			name: "bad",
			transformSystemPrompt: () => {
				throw new Error("boom")
			},
		})
		await reg.register({ name: "good", transformSystemPrompt: (p: string) => p + "!" })
		expect(await reg.applySystemPromptTransforms("x")).toBe("x!")
	})

	it("dispatches events to onEvent and swallows observer errors", () => {
		const reg = new PluginRegistry()
		const seen: string[] = []
		const plugins: ShoferPlugin[] = [
			{ name: "obs", onEvent: (e) => seen.push(e.name) },
			{
				name: "throws",
				onEvent: () => {
					throw new Error("nope")
				},
			},
		]
		return Promise.all(plugins.map((p) => reg.register(p))).then(() => {
			expect(() => reg.dispatchEvent({ name: "task.created" })).not.toThrow()
			expect(seen).toEqual(["task.created"])
		})
	})

	it("dispatchUiMessage delivers only to the named plugin (namespaced)", async () => {
		const reg = new PluginRegistry()
		const aSeen: unknown[] = []
		const bSeen: unknown[] = []
		await reg.register({ name: "a", onUiMessage: (m) => void aSeen.push(m) })
		await reg.register({ name: "b", onUiMessage: (m) => void bSeen.push(m) })

		await reg.dispatchUiMessage("a", { hello: 1 })
		expect(aSeen).toEqual([{ hello: 1 }])
		expect(bSeen).toEqual([]) // b must not observe a's channel

		await reg.dispatchUiMessage("b", { world: 2 })
		expect(bSeen).toEqual([{ world: 2 }])
		expect(aSeen).toEqual([{ hello: 1 }])
	})

	it("dispatchUiMessage isolates a throwing onUiMessage and no-ops unknown/absent", async () => {
		const reg = new PluginRegistry()
		await reg.register({
			name: "throws",
			onUiMessage: () => {
				throw new Error("boom")
			},
		})
		await reg.register({ name: "noHook" })
		// Throwing receiver never rejects to the caller.
		await expect(reg.dispatchUiMessage("throws", {})).resolves.toBeUndefined()
		// Plugin with no onUiMessage, and an unknown plugin, are no-ops.
		await expect(reg.dispatchUiMessage("noHook", {})).resolves.toBeUndefined()
		await expect(reg.dispatchUiMessage("ghost", {})).resolves.toBeUndefined()
	})
})
