// npx vitest src/components/settings/__tests__/PluginsSettings.save-gating.spec.tsx

import { createRef } from "react"
import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"

import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import { PluginsSettings, type PluginsSettingsRef } from "../PluginsSettings"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("../../plugins/PluginSlot", () => ({
	PluginSlot: () => null,
}))

const plugin = {
	name: "live-memory",
	version: "1.0.0",
	scope: "bundled" as const,
	firstParty: true,
	enabled: false,
	usesAi: true,
	aiConsented: false,
	config: {},
	contributionCounts: {},
}

const renderPlugins = (ref: React.Ref<PluginsSettingsRef>, overrides: Record<string, unknown> = {}) =>
	render(
		<ExtensionStateContext.Provider value={{ plugins: { plugins: [{ ...plugin, ...overrides }] } } as any}>
			<PluginsSettings ref={ref} />
		</ExtensionStateContext.Provider>,
	)

describe("PluginsSettings save-gating", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("stages the enable toggle and only persists on commitConfigBuffers", async () => {
		const ref = createRef<PluginsSettingsRef>()
		renderPlugins(ref)

		const toggle = await waitFor(() => screen.getByLabelText("settings:plugins.toggleAria"))
		fireEvent.click(toggle)

		// Toggling must NOT post — the change is staged until Save.
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ plugin: expect.objectContaining({ action: "setEnabled" }) }),
		)
		// …but it renders immediately (staged-first).
		expect(toggle).toHaveAttribute("aria-checked", "true")

		ref.current?.commitConfigBuffers()

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "plugin",
			plugin: { action: "setEnabled", name: "live-memory", enabled: true },
		})
	})

	it("stages the AI-consent toggle and only persists on commitConfigBuffers", async () => {
		const ref = createRef<PluginsSettingsRef>()
		renderPlugins(ref, { enabled: true })

		const toggle = await waitFor(() => screen.getByLabelText("settings:plugins.aiConsentAria"))
		fireEvent.click(toggle)

		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ plugin: expect.objectContaining({ action: "setAiConsent" }) }),
		)

		ref.current?.commitConfigBuffers()

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "plugin",
			plugin: { action: "setAiConsent", name: "live-memory", consented: true },
		})
	})

	it("drops staged toggles on discardConfigBuffers", async () => {
		const ref = createRef<PluginsSettingsRef>()
		renderPlugins(ref)

		const toggle = await waitFor(() => screen.getByLabelText("settings:plugins.toggleAria"))
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-checked", "true")

		ref.current?.discardConfigBuffers()

		// Reverts to the live value, and nothing was persisted.
		await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ plugin: expect.objectContaining({ action: "setEnabled" }) }),
		)
	})
})
