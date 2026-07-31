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

// The real `vscode-text-field` is a web component with no value setter under jsdom, so a
// plain <input> stands in — enough to assert what the field is TYPED as and what it shows.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onInput, placeholder, type, disabled, readOnly, children }: any) => (
		<>
			{children}
			<input
				type={type ?? "text"}
				value={value ?? ""}
				placeholder={placeholder}
				// Forwarded so a test can assert a field is genuinely not editable —
				// the real component supports both.
				disabled={disabled}
				readOnly={readOnly}
				onChange={(e) => onInput?.(e)}
			/>
		</>
	),
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

	it("renders a secret config property as a password field that never shows the stored value", async () => {
		const ref = createRef<PluginsSettingsRef>()
		renderPlugins(ref, {
			enabled: true,
			configSchema: {
				type: "object",
				properties: {
					qdrantUrl: { type: "string", default: "http://localhost:6333" },
					qdrantApiKey: { type: "string", secret: true },
				},
			},
			// The host sends the NAMES of stored secrets, never their values.
			config: { qdrantUrl: "http://qdrant:6333" },
			configSecretsSet: ["qdrantApiKey"],
		})

		fireEvent.click(await waitFor(() => screen.getByText("settings:plugins.configure")))

		const secretField = await waitFor(() =>
			screen.getByPlaceholderText<HTMLInputElement>("settings:plugins.secretSet"),
		)
		// A password field, empty: the key exists, and the panel cannot read it.
		expect(secretField.type).toBe("password")
		expect(secretField.value).toBe("")

		fireEvent.change(secretField, { target: { value: "replacement-key" } })
		ref.current?.commitConfigBuffers()

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "plugin",
			plugin: {
				action: "setConfig",
				name: "live-memory",
				config: { qdrantUrl: "http://qdrant:6333", qdrantApiKey: "replacement-key" },
			},
		})
	})

	it("renders a file-managed plugin's config read-only, with no reset affordance", async () => {
		const ref = createRef<PluginsSettingsRef>()
		renderPlugins(ref, {
			configManagedBy: "file-layer",
			configSchema: { properties: { minIntervalS: { type: "number", default: 90 }, mute: { type: "boolean" } } },
			config: { minIntervalS: 120 },
		})

		fireEvent.click(await waitFor(() => screen.getByText("settings:plugins.configure")))

		// The value the plugin is actually running with is shown…
		const field = screen.getByDisplayValue("120") as HTMLInputElement
		expect(field).toBeDisabled()
		// …and it says where it comes from, instead of inviting an edit that the
		// overlay would silently shadow.
		expect(screen.getByText("settings:plugins.configManaged")).toBeInTheDocument()
		// A role="switch" div cannot be `disabled`; it announces the state and, more
		// importantly, does not act on a click.
		const toggle = screen.getByLabelText("mute")
		expect(toggle).toHaveAttribute("aria-disabled", "true")
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-checked", "false")
		// Nothing local to reset while the file layer supplies the values.
		expect(screen.getByText("settings:plugins.resetDefaults")).toHaveAttribute("hidden")
	})

	it("leaves an unmanaged plugin's config editable", async () => {
		const ref = createRef<PluginsSettingsRef>()
		renderPlugins(ref, {
			configSchema: { properties: { minIntervalS: { type: "number", default: 90 } } },
			config: { minIntervalS: 120 },
		})

		fireEvent.click(await waitFor(() => screen.getByText("settings:plugins.configure")))
		expect(screen.getByDisplayValue("120")).not.toBeDisabled()
		expect(screen.queryByText("settings:plugins.configManaged")).not.toBeInTheDocument()
	})
})
