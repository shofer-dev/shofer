// npx vitest src/components/modes/__tests__/ModesView.spec.tsx

import { createRef } from "react"
import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import ModesView, { type ModesViewRef } from "../ModesView"
import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

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
	customInstructions: "Initial instructions",
	setCustomInstructions: vitest.fn(),
}

const renderPromptsView = (props = {}) => {
	return render(
		<ExtensionStateContext.Provider value={{ ...mockExtensionState, ...props } as any}>
			<ModesView />
		</ExtensionStateContext.Provider>,
	)
}

Element.prototype.scrollIntoView = vitest.fn()

describe("PromptsView", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("displays the current mode name in the select trigger", () => {
		renderPromptsView({ mode: "code" })
		const selectTrigger = screen.getByTestId("mode-select-trigger")
		expect(selectTrigger).toHaveTextContent("Code")
	})

	it("opens the mode selection popover when the trigger is clicked", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")
		fireEvent.click(selectTrigger)
		await waitFor(() => {
			expect(selectTrigger).toHaveAttribute("aria-expanded", "true")
		})
	})

	it("filters mode options based on search input", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")
		fireEvent.click(selectTrigger)

		const searchInput = screen.getByTestId("mode-search-input")
		fireEvent.change(searchInput, { target: { value: "ask" } })

		await waitFor(() => {
			expect(screen.getByTestId("mode-option-ask")).toBeInTheDocument()
			expect(screen.queryByTestId("mode-option-code")).not.toBeInTheDocument()
			expect(screen.queryByTestId("mode-option-architect")).not.toBeInTheDocument()
		})
	})

	it("selects a mode from the dropdown and sends update message", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")
		fireEvent.click(selectTrigger)

		const askOption = await waitFor(() => screen.getByTestId("mode-option-ask"))
		fireEvent.click(askOption)

		expect(mockExtensionState.setEnhancementApiConfigId).not.toHaveBeenCalled() // Ensure this is not called by mode switch
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "mode",
			text: "ask",
		})
		await waitFor(() => {
			expect(selectTrigger).toHaveAttribute("aria-expanded", "false")
		})
	})

	it("buffers prompt changes locally and only persists on commitBuffers", async () => {
		// Per the AGENTS.md "Settings View Pattern", text edits in ModesView are
		// held in a local override map and only flushed to the host on Save (which
		// SettingsView triggers via the ModesViewRef.commitBuffers() handle). This
		// test pins that contract: typing must NOT post, commit MUST post.
		const ref = createRef<ModesViewRef>()
		render(
			<ExtensionStateContext.Provider value={{ ...mockExtensionState } as any}>
				<ModesView ref={ref} />
			</ExtensionStateContext.Provider>,
		)

		const textarea = (await waitFor(() => screen.getByTestId("code-prompt-textarea"))) as HTMLTextAreaElement

		fireEvent.change(textarea, { target: { value: "New prompt value" } })

		// Typing must NOT post — the override is buffered locally.
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updatePrompt" }))

		// Save (simulated via the imperative handle) flushes the buffer.
		ref.current?.commitBuffers()

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: { roleDefinition: "New prompt value" },
		})
	})

	it("discardBuffers drops pending edits without posting", async () => {
		const ref = createRef<ModesViewRef>()
		render(
			<ExtensionStateContext.Provider value={{ ...mockExtensionState } as any}>
				<ModesView ref={ref} />
			</ExtensionStateContext.Provider>,
		)

		const textarea = (await waitFor(() => screen.getByTestId("code-prompt-textarea"))) as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: "throwaway" } })

		ref.current?.discardBuffers()

		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updatePrompt" }))
	})

	it("resets role definition only for built-in modes", async () => {
		const customMode = {
			slug: "custom-mode",
			name: "Custom Mode",
			roleDefinition: "Custom role",
			groups: [],
		}

		// Test with built-in mode (code)
		const { unmount } = render(
			<ExtensionStateContext.Provider
				value={{ ...mockExtensionState, mode: "code", customModes: [customMode] } as any}>
				<ModesView />
			</ExtensionStateContext.Provider>,
		)

		// Find and click the role definition reset button
		const resetButton = screen.getByTestId("role-definition-reset")
		expect(resetButton).toBeInTheDocument()
		await fireEvent.click(resetButton)

		// Verify it only resets role definition
		// When resetting a built-in mode's role definition, the field should be removed entirely
		// from the customPrompt object, not set to undefined.
		// This allows the default role definition from the built-in mode to be used instead.
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: {}, // Empty object because the role definition field is removed entirely
		})

		// Cleanup before testing custom mode
		unmount()

		// Test with custom mode
		render(
			<ExtensionStateContext.Provider
				value={{ ...mockExtensionState, mode: "custom-mode", customModes: [customMode] } as any}>
				<ModesView />
			</ExtensionStateContext.Provider>,
		)

		// Verify reset button is not present for custom mode
		expect(screen.queryByTestId("role-definition-reset")).not.toBeInTheDocument()
	})

	it("description section behavior for different mode types", async () => {
		const customMode = {
			slug: "custom-mode",
			name: "Custom Mode",
			roleDefinition: "Custom role",
			description: "Custom description",
			groups: [],
		}

		// Test with built-in mode (code) - description section should be shown with reset button
		const { unmount } = render(
			<ExtensionStateContext.Provider
				value={{ ...mockExtensionState, mode: "code", customModes: [customMode] } as any}>
				<ModesView />
			</ExtensionStateContext.Provider>,
		)

		// Verify description reset button IS present for built-in modes
		// because built-in modes can have their descriptions customized and reset
		expect(screen.queryByTestId("description-reset")).toBeInTheDocument()

		// Cleanup before testing custom mode
		unmount()

		// Test with custom mode - description section should be shown
		render(
			<ExtensionStateContext.Provider
				value={{ ...mockExtensionState, mode: "custom-mode", customModes: [customMode] } as any}>
				<ModesView />
			</ExtensionStateContext.Provider>,
		)

		// Verify description section is present for custom modes
		// but reset button is NOT present (since custom modes manage their own descriptions)
		expect(screen.queryByTestId("description-reset")).not.toBeInTheDocument()

		// Verify the description text field is present for custom modes
		expect(screen.getByTestId("custom-mode-description-textfield")).toBeInTheDocument()
	})

	it("buffers global custom instructions and persists empty string on commitBuffers", async () => {
		// Clearing global custom instructions follows the same buffered-commit
		// contract as per-mode edits. The empty string must be preserved on commit
		// (not coerced to undefined) so the host can distinguish "explicitly empty"
		// from "unchanged".
		const ref = createRef<ModesViewRef>()
		render(
			<ExtensionStateContext.Provider
				value={{ ...mockExtensionState, customInstructions: "Initial instructions" } as any}>
				<ModesView ref={ref} />
			</ExtensionStateContext.Provider>,
		)

		const textarea = screen.getByTestId("global-custom-instructions-textarea") as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: "" } })

		// Typing/clearing must NOT post immediately.
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "customInstructions" }))

		ref.current?.commitBuffers()

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "customInstructions",
			text: "",
		})
	})

	it("closes the mode selection popover when ESC key is pressed", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")

		// Open the popover
		fireEvent.click(selectTrigger)
		await waitFor(() => {
			expect(selectTrigger).toHaveAttribute("aria-expanded", "true")
		})

		// Press ESC key
		fireEvent.keyDown(window, { key: "Escape" })

		// Verify popover is closed
		await waitFor(() => {
			expect(selectTrigger).toHaveAttribute("aria-expanded", "false")
		})
	})

	it("does not close the popover when ESC is pressed while popover is closed", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")

		// Ensure popover is closed
		expect(selectTrigger).toHaveAttribute("aria-expanded", "false")

		// Press ESC key
		fireEvent.keyDown(window, { key: "Escape" })

		// Verify popover remains closed
		expect(selectTrigger).toHaveAttribute("aria-expanded", "false")
	})

	it("does not revert typed text when extensionState re-renders with a new context value", async () => {
		// Regression for the bug where every host state push (~1s during a task)
		// reset the local text buffer and overwrote in-flight user typing. The
		// override-map design must keep the user's edit visible across context
		// re-renders that do not change the field being edited.
		const ref = createRef<ModesViewRef>()
		const { rerender } = render(
			<ExtensionStateContext.Provider value={{ ...mockExtensionState } as any}>
				<ModesView ref={ref} />
			</ExtensionStateContext.Provider>,
		)

		const textarea = (await waitFor(() => screen.getByTestId("code-prompt-textarea"))) as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: "User typed value" } })

		// Simulate a host state push that produces a brand-new context object
		// reference but does not change the role-definition field for `code`.
		rerender(
			<ExtensionStateContext.Provider value={{ ...mockExtensionState, mode: "code" } as any}>
				<ModesView ref={ref} />
			</ExtensionStateContext.Provider>,
		)

		const textareaAfter = (await waitFor(() => screen.getByTestId("code-prompt-textarea"))) as HTMLTextAreaElement
		expect(textareaAfter.value).toBe("User typed value")
	})

	it("fires onModesDirty the first time any field diverges from source-of-truth", async () => {
		// Save-button enabling in SettingsView is driven by this callback. The
		// previous implementation never mutated cachedState on type, so the
		// callback (then absent) never fired and Save stayed disabled.
		const onModesDirty = vitest.fn()
		render(
			<ExtensionStateContext.Provider value={{ ...mockExtensionState } as any}>
				<ModesView onModesDirty={onModesDirty} />
			</ExtensionStateContext.Provider>,
		)

		const textarea = (await waitFor(() => screen.getByTestId("code-prompt-textarea"))) as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: "dirty" } })

		expect(onModesDirty).toHaveBeenCalled()
	})
})
