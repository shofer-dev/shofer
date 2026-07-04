import { fireEvent, render, screen } from "@testing-library/react"

import type { PluginsState } from "@shofer/types"

import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

import { PluginsTab } from "../PluginsTab"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts?.name ? `${key}:${opts.name}` : key),
	}),
}))

function renderTab(plugins?: PluginsState) {
	return render(
		<ExtensionStateContext.Provider value={{ plugins } as never}>
			<PluginsTab />
		</ExtensionStateContext.Provider>,
	)
}

const samplePlugins: PluginsState = {
	plugins: [
		{
			name: "alpha",
			version: "1.0.0",
			description: "Alpha plugin",
			scope: "global",
			enabled: false,
			hasCode: false,
			contributionCounts: { modes: 1, skills: 0, commands: 0, mcpServers: 0, rules: 0 },
		},
		{
			name: "beta",
			version: "2.0.0",
			scope: "project",
			enabled: true,
			hasCode: true,
			contributionCounts: { modes: 0, skills: 2, commands: 0, mcpServers: 0, rules: 0 },
		},
	],
}

describe("PluginsTab (Phase 5.3)", () => {
	beforeEach(() => vi.clearAllMocks())

	it("requests the plugin list on mount", () => {
		renderTab(samplePlugins)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "plugin", plugin: { action: "list" } })
	})

	it("shows an empty state with no plugins", () => {
		renderTab({ plugins: [] })
		expect(screen.getByText("marketplace:plugins.empty")).toBeInTheDocument()
	})

	it("renders a row per discovered plugin", () => {
		renderTab(samplePlugins)
		expect(screen.getByText("alpha")).toBeInTheDocument()
		expect(screen.getByText("beta")).toBeInTheDocument()
		expect(screen.getByText("Alpha plugin")).toBeInTheDocument()
	})

	it("toggling a plugin posts setEnabled", () => {
		renderTab(samplePlugins)
		const toggle = screen.getByLabelText("settings:plugins.toggleAria:alpha")
		fireEvent.click(toggle)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "plugin",
			plugin: { action: "setEnabled", name: "alpha", enabled: true },
		})
	})

	it("install-from-file posts installFromFile", () => {
		renderTab(samplePlugins)
		fireEvent.click(screen.getByText("marketplace:plugins.installFromFile"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "plugin",
			plugin: { action: "installFromFile" },
		})
	})

	it("uninstall requires a confirmation step before posting", () => {
		renderTab(samplePlugins)
		// First click reveals the confirm button; nothing is posted yet.
		const trashButtons = screen.getAllByTitle("marketplace:plugins.uninstall")
		fireEvent.click(trashButtons[0])
		expect(vscode.postMessage).not.toHaveBeenCalledWith({
			type: "plugin",
			plugin: { action: "uninstall", name: "alpha" },
		})
		// The confirm button now posts the uninstall.
		fireEvent.click(screen.getByText("marketplace:plugins.uninstall"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "plugin",
			plugin: { action: "uninstall", name: "alpha" },
		})
	})
})
