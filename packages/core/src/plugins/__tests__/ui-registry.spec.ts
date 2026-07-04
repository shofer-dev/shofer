import { describe, it, expect, vi } from "vitest"

import { PluginUiRegistry, buildPluginUiRegistry, type UiContributingPlugin } from "../ui-registry.js"

// Silence the shown warning path (permission refusals warn); assert on it where relevant.
vi.mock("../plugin-warnings.js", () => ({
	warnPlugin: vi.fn(),
	warnPluginConflict: vi.fn(),
}))
import { warnPlugin } from "../plugin-warnings.js"

describe("PluginUiRegistry (§6.8, Phase 4)", () => {
	it("maps a granted contribution into its region with a namespaced componentId", () => {
		const reg = new PluginUiRegistry()
		expect(reg.add("ci", "task-header", ["task-header", "chat-input-toolbar"])).toBe(true)
		expect(reg.getForRegion("task-header")).toEqual([
			{ pluginName: "ci", region: "task-header", componentId: "ci:task-header", source: undefined },
		])
		// A different region the plugin was granted but did not add yet is empty.
		expect(reg.getForRegion("chat-input-toolbar")).toEqual([])
	})

	it("refuses (permission-gates) a contribution to a region not in permissions.ui", () => {
		const reg = new PluginUiRegistry()
		const ok = reg.add("rogue", "sidebar-panel", ["chat-input-toolbar"])
		expect(ok).toBe(false)
		expect(reg.getForRegion("sidebar-panel")).toEqual([])
		expect(reg.all()).toEqual([])
		expect(warnPlugin).toHaveBeenCalledWith(expect.stringContaining('refused UI contribution to region "sidebar-panel"'))
	})

	it("preserves insertion order per region (install-rank) across plugins", () => {
		const reg = new PluginUiRegistry()
		reg.add("a", "chat-input-toolbar", ["chat-input-toolbar"])
		reg.add("b", "chat-input-toolbar", ["chat-input-toolbar"])
		expect(reg.getForRegion("chat-input-toolbar").map((c) => c.pluginName)).toEqual(["a", "b"])
	})

	it("carries an optional source URL for external/dynamic-import loading", () => {
		const reg = new PluginUiRegistry()
		reg.add("ext", "sidebar-panel", ["sidebar-panel"], "vscode-webview://x/ui.js")
		expect(reg.getForRegion("sidebar-panel")[0]?.source).toBe("vscode-webview://x/ui.js")
	})

	it("clear() drops every contribution", () => {
		const reg = new PluginUiRegistry()
		reg.add("a", "task-header", ["task-header"])
		reg.clear()
		expect(reg.all()).toEqual([])
		expect(reg.regions()).toEqual([])
	})

	describe("buildPluginUiRegistry", () => {
		it("produces one contribution per granted region, in plugin order", () => {
			const plugins: UiContributingPlugin[] = [
				{ name: "ci", grantedRegions: ["chat-input-toolbar", "task-header"] },
				{ name: "metrics", grantedRegions: ["task-header"] },
			]
			const reg = buildPluginUiRegistry(plugins)
			expect(reg.all().map((c) => c.componentId)).toEqual([
				"ci:chat-input-toolbar",
				"ci:task-header",
				"metrics:task-header",
			])
			expect(reg.getForRegion("task-header").map((c) => c.pluginName)).toEqual(["ci", "metrics"])
		})

		it("yields nothing for a plugin with no granted regions", () => {
			const reg = buildPluginUiRegistry([{ name: "declarative", grantedRegions: [] }])
			expect(reg.all()).toEqual([])
		})
	})
})
