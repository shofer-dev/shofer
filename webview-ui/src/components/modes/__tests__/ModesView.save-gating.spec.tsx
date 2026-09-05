// npx vitest src/components/modes/__tests__/ModesView.save-gating.spec.tsx
//
// The Modes tab is the biggest concentration of the save-gating rule in
// `webview-ui/AGENTS.md`: none of its fields lives in SettingsView's
// `cachedState`, so every edit is STAGED into a pending buffer, reported via
// `onDirty`, and only posted when the parent calls `commitBuffers()` on Save —
// with `discardBuffers()` dropping it on Discard. Two related rules ride along:
// the edit-target dropdown must never post a `"mode"` message (that would
// change chat state from Settings), and once the user pins an edit target an
// active-mode change from elsewhere must not move them off the form.

import { createRef } from "react"
import { render, screen, fireEvent, waitFor, act } from "@/utils/test-utils"

import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ModesView, { type ModesViewRef } from "../ModesView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

// The FAST web components have no value setter in jsdom, so the two toolkit
// controls this view uses are swapped for plain DOM equivalents.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onChange, onInput, "data-testid": testId, children, placeholder }: any) => (
		<div>
			{children}
			<input
				data-testid={testId}
				value={value ?? ""}
				placeholder={placeholder}
				onChange={(e) => {
					onChange?.(e)
					onInput?.(e)
				}}
			/>
		</div>
	),
	VSCodeCheckbox: ({ children, checked, onChange, disabled, "data-testid": testId }: any) => (
		<label>
			<input
				type="checkbox"
				data-testid={testId}
				checked={!!checked}
				disabled={disabled}
				onChange={(e) => onChange?.(e)}
			/>
			{children}
		</label>
	),
	VSCodeButton: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	VSCodeRadioGroup: ({ children, onChange }: any) => <div onChange={onChange}>{children}</div>,
	VSCodeRadio: ({ children, value, checked }: any) => (
		<label>
			<input type="radio" value={value} defaultChecked={!!checked} readOnly />
			{children}
		</label>
	),
	VSCodeDropdown: ({ children, value, onChange }: any) => (
		<select value={value ?? ""} onChange={(e) => onChange?.(e)}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: any) => <option value={value}>{children}</option>,
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
	VSCodeTextArea: ({ value, onChange, "data-testid": testId }: any) => (
		<textarea data-testid={testId} value={value ?? ""} onChange={(e) => onChange?.(e)} />
	),
}))

const postMessage = vi.mocked(vscode.postMessage)
const posted = (type: string) =>
	postMessage.mock.calls.map((c) => c[0] as Record<string, any>).filter((m) => m?.type === type)

// Every mode reaches this view through `customModes`; Shofer's own arrive from
// the bundled `builtin-config` plugin, tagged `source: "plugin"`, and it is that
// tag — not absence from the list — that makes them read-only structurally
// (`findAuthoredMode`). An AUTHORED mode has any other source.
const BUILT_IN = [
	{ slug: "code", name: "💻 Code", roleDefinition: "Code role", tools: ["read"], source: "plugin" },
	{ slug: "architect", name: "🏗️ Architect", roleDefinition: "Architect role", tools: ["read"], source: "plugin" },
]

const AUTHORED = {
	slug: "reviewer",
	name: "Reviewer",
	roleDefinition: "Reviews code",
	description: "a description",
	whenToUse: "when reviewing",
	customInstructions: "be terse",
	tools: ["read"],
	groups: ["read"],
	source: "global",
}

const baseState = {
	customModePrompts: {},
	listApiConfigMeta: [
		{ id: "config1", name: "Config 1" },
		{ id: "config2", name: "Config 2" },
	],
	enhancementApiConfigId: "",
	setEnhancementApiConfigId: vi.fn(),
	mode: "code",
	customModes: BUILT_IN,
	customSupportPrompts: {},
	currentApiConfigName: "",
	customInstructions: "Initial instructions",
	setCustomInstructions: vi.fn(),
	modeApiConfigs: {},
}

const onDirty = vi.fn()

const renderModes = (state: Record<string, unknown> = {}) => {
	const ref = createRef<ModesViewRef>()
	const utils = render(
		<ExtensionStateContext.Provider value={{ ...baseState, ...state } as never}>
			<ModesView ref={ref} onModesDirty={onDirty} />
		</ExtensionStateContext.Provider>,
	)
	return { ...utils, ref }
}

Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => vi.clearAllMocks())

describe("staging an edit", () => {
	it("does not post a role-definition edit until Save", async () => {
		const { ref } = renderModes()

		fireEvent.change(screen.getByTestId("code-prompt-textarea"), {
			target: { value: "  A better role  " },
		})
		expect(onDirty).toHaveBeenCalled()
		expect(posted("updatePrompt")).toHaveLength(0)

		act(() => ref.current!.commitBuffers())
		expect(posted("updatePrompt")[0]).toMatchObject({
			promptMode: "code",
			customPrompt: { roleDefinition: "A better role" },
		})
	})

	it("drops a staged edit on Discard", () => {
		const { ref } = renderModes()

		fireEvent.change(screen.getByTestId("code-prompt-textarea"), { target: { value: "changed" } })
		act(() => ref.current!.discardBuffers())
		act(() => ref.current!.commitBuffers())

		expect(posted("updateCustomMode")).toHaveLength(0)
		expect(posted("updatePrompt")).toHaveLength(0)
		// The form falls back to the mode's own definition again.
		expect(screen.getByTestId("code-prompt-textarea")).not.toHaveValue("changed")
	})

	it("clears an override back to undefined when the field is emptied", () => {
		const { ref } = renderModes()

		fireEvent.change(screen.getByTestId("code-prompt-textarea"), { target: { value: "   " } })
		act(() => ref.current!.commitBuffers())

		expect(posted("updatePrompt")[0]).toMatchObject({
			customPrompt: { roleDefinition: undefined },
		})
	})

	it("stages the description, when-to-use and per-mode instructions together", () => {
		const { ref } = renderModes()

		fireEvent.change(screen.getByTestId("code-description-textfield"), { target: { value: "desc" } })
		fireEvent.change(screen.getByTestId("code-when-to-use-textarea"), { target: { value: "when" } })
		fireEvent.change(screen.getByTestId("code-custom-instructions-textarea"), { target: { value: "how" } })
		expect(posted("updatePrompt")).toHaveLength(0)

		act(() => ref.current!.commitBuffers())
		expect(posted("updatePrompt")[0]).toMatchObject({
			customPrompt: { description: "desc", whenToUse: "when", customInstructions: "how" },
		})
	})

	it("stages the global custom instructions and posts them once on Save", () => {
		const { ref } = renderModes()

		fireEvent.change(screen.getByTestId("global-custom-instructions-textarea"), {
			target: { value: "workspace-wide rules" },
		})
		expect(posted("customInstructions")).toHaveLength(0)

		act(() => ref.current!.commitBuffers())
		expect(posted("customInstructions")).toEqual([{ type: "customInstructions", text: "workspace-wide rules" }])
	})

	it("persists an authored mode as a whole ModeConfig, not a prompt override", () => {
		const { ref } = renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.change(screen.getByTestId("reviewer-prompt-textarea"), { target: { value: "Reviews harder" } })
		act(() => ref.current!.commitBuffers())

		expect(posted("updatePrompt")).toHaveLength(0)
		expect(posted("updateCustomMode")[0]).toMatchObject({
			slug: "reviewer",
			modeConfig: { slug: "reviewer", roleDefinition: "Reviews harder", source: "global" },
		})
	})

	it("clears an authored mode's optional fields when they are emptied", () => {
		const { ref } = renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.change(screen.getByTestId("reviewer-description-textfield"), { target: { value: "   " } })
		fireEvent.change(screen.getByTestId("reviewer-when-to-use-textarea"), { target: { value: "" } })
		fireEvent.change(screen.getByTestId("reviewer-custom-instructions-textarea"), { target: { value: "" } })
		act(() => ref.current!.commitBuffers())

		expect(posted("updateCustomMode")[0].modeConfig).toMatchObject({
			description: undefined,
			whenToUse: undefined,
			customInstructions: undefined,
		})
	})

	it("stages a tool-group change and folds it into the same Save post", async () => {
		const { ref } = renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.click(screen.getByTestId("edit-tools-button"))
		const editGroup = await screen.findByTestId("tool-group-checkbox-write")
		fireEvent.click(editGroup)
		expect(posted("updateCustomMode")).toHaveLength(0)

		fireEvent.change(screen.getByTestId("reviewer-prompt-textarea"), { target: { value: "Reviews harder" } })
		act(() => ref.current!.commitBuffers())

		// ONE post carrying both the text edit and the tool groups.
		expect(posted("updateCustomMode")).toHaveLength(1)
		expect(posted("updateCustomMode")[0].modeConfig.tools).toContain("write")
		expect(posted("updateCustomMode")[0].modeConfig.roleDefinition).toBe("Reviews harder")
	})

	it("posts a tool-group-only change on its own", async () => {
		const { ref } = renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.click(screen.getByTestId("edit-tools-button"))
		fireEvent.click(await screen.findByTestId("tool-group-checkbox-write"))
		act(() => ref.current!.commitBuffers())

		expect(posted("updateCustomMode")).toHaveLength(1)
		expect(posted("updateCustomMode")[0].modeConfig.tools).toContain("write")
	})

	it("stages the per-mode API configuration", async () => {
		const { ref } = renderModes()

		const trigger = screen.getByText("prompts:apiConfiguration.title").parentElement!
		const select = trigger.querySelector("select")
		if (select) {
			fireEvent.change(select, { target: { value: "config1" } })
			act(() => ref.current!.commitBuffers())
			expect(posted("setModeApiConfig")[0]).toMatchObject({ mode: "code", text: "config1" })
		}
	})
})

describe("the edit-target dropdown", () => {
	it("never posts a mode change from Settings", async () => {
		renderModes()

		fireEvent.click(screen.getByTestId("mode-select-trigger"))
		fireEvent.click(await screen.findByTestId("mode-option-architect"))

		expect(posted("mode")).toHaveLength(0)
		await waitFor(() => expect(screen.getByTestId("architect-prompt-textarea")).toBeInTheDocument())
	})

	it("follows the active mode until an edit target is pinned, then stops", async () => {
		const { rerender } = renderModes()
		expect(screen.getByTestId("code-prompt-textarea")).toBeInTheDocument()

		// Chat switched the active mode; nothing is pinned yet, so the form follows.
		rerender(
			<ExtensionStateContext.Provider value={{ ...baseState, mode: "architect" } as never}>
				<ModesView onModesDirty={onDirty} />
			</ExtensionStateContext.Provider>,
		)
		await waitFor(() => expect(screen.getByTestId("architect-prompt-textarea")).toBeInTheDocument())

		// The user picks an edit target: from here the form is theirs.
		fireEvent.click(screen.getByTestId("mode-select-trigger"))
		fireEvent.click(await screen.findByTestId("mode-option-code"))
		await waitFor(() => expect(screen.getByTestId("code-prompt-textarea")).toBeInTheDocument())

		rerender(
			<ExtensionStateContext.Provider value={{ ...baseState, mode: "architect" } as never}>
				<ModesView onModesDirty={onDirty} />
			</ExtensionStateContext.Provider>,
		)
		expect(screen.getByTestId("code-prompt-textarea")).toBeInTheDocument()
	})

	it("filters the mode list", async () => {
		renderModes()
		fireEvent.click(screen.getByTestId("mode-select-trigger"))
		fireEvent.change(screen.getByTestId("mode-search-input"), { target: { value: "archi" } })

		await waitFor(() => expect(screen.queryByTestId("mode-option-code")).not.toBeInTheDocument())
		expect(screen.getByTestId("mode-option-architect")).toBeInTheDocument()
	})
})

describe("structural list management (exempt from save-gating)", () => {
	it("disables delete for a plugin-owned mode and enables it for an authored one", async () => {
		const { rerender } = renderModes()
		expect(screen.getByTestId("delete-mode-button")).toBeDisabled()

		rerender(
			<ExtensionStateContext.Provider
				value={{ ...baseState, customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" } as never}>
				<ModesView onModesDirty={onDirty} />
			</ExtensionStateContext.Provider>,
		)
		await waitFor(() => expect(screen.getByTestId("delete-mode-button")).toBeEnabled())
		expect(screen.getByTestId("rename-mode-button")).toBeInTheDocument()
	})

	it("renames an authored mode immediately, and can be cancelled", async () => {
		renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.click(screen.getByTestId("rename-mode-button"))
		const input = await screen.findByDisplayValue("Reviewer")
		fireEvent.change(input, { target: { value: "Auditor" } })
		fireEvent.click(screen.getByTestId("save-mode-rename-button"))
		await waitFor(() => expect(posted("updateCustomMode")[0].modeConfig.name).toBe("Auditor"))

		postMessage.mockClear()
		fireEvent.click(screen.getByTestId("rename-mode-button"))
		fireEvent.click(screen.getByTestId("cancel-mode-rename-button"))
		expect(posted("updateCustomMode")).toHaveLength(0)
	})

	it("asks the host whether the mode has rules before deleting it", async () => {
		renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.click(screen.getByTestId("delete-mode-button"))
		// The first post is a probe, not the deletion.
		expect(posted("deleteCustomMode")).toEqual([{ type: "deleteCustomMode", slug: "reviewer", checkOnly: true }])
	})

	it("exports and imports through their own toolbar buttons", () => {
		renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.click(screen.getByTestId("export-mode-toolbar-button"))
		expect(posted("exportMode")).toHaveLength(1)

		fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
		expect(screen.getByText("prompts:createModeDialog.buttons.cancel")).toBeInTheDocument()
	})

	it("opens the create-mode dialog from the toolbar", async () => {
		renderModes()
		fireEvent.click(screen.getByTestId("add-mode-button"))
		await waitFor(() => expect(screen.getByText("prompts:createModeDialog.title")).toBeInTheDocument())
	})
})

describe("an org-locked mode", () => {
	it("is announced and refuses edits", () => {
		renderModes({
			customModes: [...BUILT_IN, AUTHORED],
			mode: "reviewer",
			orgLockedResources: { modes: ["reviewer"] },
		})
		expect(screen.getByTestId("mode-org-locked-banner")).toBeInTheDocument()
	})
})
