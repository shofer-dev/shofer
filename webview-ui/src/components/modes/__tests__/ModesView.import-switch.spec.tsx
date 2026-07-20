// npx vitest src/components/modes/__tests__/ModesView.import-switch.spec.tsx

import { render, screen, waitFor } from "@/utils/test-utils"
import ModesView from "../ModesView"
import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { defaultModeSlug } from "@shofer/types"

// Mock vscode API
vitest.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vitest.fn(),
	},
}))

const mockExtensionState = {
	customModePrompts: {},
	listApiConfigMeta: [
		{ id: "config1", name: "Config 1" },
		{ id: "config2", name: "Config 2" },
	],
	enhancementApiConfigId: "",
	setEnhancementApiConfigId: vitest.fn(),
	mode: "code",
	customModes: [],
	customSupportPrompts: [],
	currentApiConfigName: "",
	customInstructions: "",
	setCustomInstructions: vitest.fn(),
}

const renderModesView = (props = {}) => {
	return render(
		<ExtensionStateContext.Provider value={{ ...mockExtensionState, ...props } as any}>
			<ModesView />
		</ExtensionStateContext.Provider>,
	)
}

Element.prototype.scrollIntoView = vitest.fn()

describe("ModesView Import Auto-Switch", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("should auto-select imported mode for editing WITHOUT switching the active mode", async () => {
		const importedModeSlug = "custom-test-mode"
		const customModes = [
			{
				slug: importedModeSlug,
				name: "Custom Test Mode",
				roleDefinition: "Test role",
				tools: [],
			},
		]

		renderModesView({ customModes })

		// Simulate successful import message with the mode already in state
		const importMessage = {
			data: {
				type: "importModeResult",
				success: true,
				slug: importedModeSlug,
			},
		}

		window.dispatchEvent(new MessageEvent("message", importMessage))

		// The imported mode becomes the LOCAL editing selection…
		await waitFor(() => {
			expect(screen.getByTestId("mode-select-trigger")).toHaveTextContent("Custom Test Mode")
		})
		// …but the globally-active mode is untouched (save-gating rule: Settings
		// must not switch the active mode).
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
	})

	it("should fallback to selecting the default mode when imported slug not yet in state (race condition)", async () => {
		const importedModeSlug = "custom-new-mode"

		// Render without the imported mode in customModes (simulating race condition)
		renderModesView({ customModes: [] })

		// Simulate successful import message but mode not yet in state
		const importMessage = {
			data: {
				type: "importModeResult",
				success: true,
				slug: importedModeSlug,
			},
		}

		window.dispatchEvent(new MessageEvent("message", importMessage))

		// The fallback selects the default mode locally for editing; no active-mode
		// switch is posted.
		await waitFor(() => {
			expect(screen.getByTestId(`${defaultModeSlug}-prompt-textarea`)).toBeInTheDocument()
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
	})

	it("should not switch modes on import failure", async () => {
		renderModesView()

		// Simulate failed import message
		const importMessage = {
			data: {
				type: "importModeResult",
				success: false,
				error: "Import failed",
			},
		}

		window.dispatchEvent(new MessageEvent("message", importMessage))

		// Wait a bit to ensure no mode switch happens
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Verify no mode switch message was sent
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "mode",
			}),
		)
	})

	it("should not switch modes on cancelled import", async () => {
		renderModesView()

		// Simulate cancelled import message
		const importMessage = {
			data: {
				type: "importModeResult",
				success: false,
				error: "cancelled",
			},
		}

		window.dispatchEvent(new MessageEvent("message", importMessage))

		// Wait a bit to ensure no mode switch happens
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Verify no mode switch message was sent
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "mode",
			}),
		)
	})
})
