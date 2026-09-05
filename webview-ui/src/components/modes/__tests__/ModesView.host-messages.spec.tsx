// npx vitest src/components/modes/__tests__/ModesView.host-messages.spec.tsx
//
// The Modes tab's other half: the host round-trips it drives (system-prompt
// preview, export/import, the delete pre-check that asks whether a mode owns a
// rules folder) and the per-field RESET, which is an explicit instant action
// rather than a staged edit.

import { render, screen, fireEvent, act, waitFor } from "@/utils/test-utils"

import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ModesView from "../ModesView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onChange, onInput, "data-testid": testId, children, placeholder }: any) => (
		<div>
			{children}
			<input
				data-testid={testId}
				placeholder={placeholder}
				value={value ?? ""}
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
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
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
	VSCodeTextArea: ({ value, onChange, "data-testid": testId }: any) => (
		<textarea data-testid={testId} value={value ?? ""} onChange={(e) => onChange?.(e)} />
	),
}))

const postMessage = vi.mocked(vscode.postMessage)
const posted = (type: string) =>
	postMessage.mock.calls.map((c) => c[0] as Record<string, any>).filter((m) => m?.type === type)

const BUILT_IN = [
	{ slug: "code", name: "💻 Code", roleDefinition: "Code role", tools: ["read"], source: "plugin" },
	{ slug: "architect", name: "🏗️ Architect", roleDefinition: "Architect role", tools: ["read"], source: "plugin" },
]

const AUTHORED = {
	slug: "reviewer",
	name: "Reviewer",
	roleDefinition: "Reviews code",
	tools: ["read"],
	source: "global",
}

const baseState = {
	customModePrompts: { code: { roleDefinition: "an override" } },
	listApiConfigMeta: [],
	enhancementApiConfigId: "",
	setEnhancementApiConfigId: vi.fn(),
	mode: "code",
	customModes: BUILT_IN,
	customSupportPrompts: {},
	currentApiConfigName: "",
	customInstructions: "",
	setCustomInstructions: vi.fn(),
	modeApiConfigs: {},
}

const renderModes = (state: Record<string, unknown> = {}) =>
	render(
		<ExtensionStateContext.Provider value={{ ...baseState, ...state } as never}>
			<ModesView onModesDirty={vi.fn()} />
		</ExtensionStateContext.Provider>,
	)

const deliver = (data: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})

Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => vi.clearAllMocks())

describe("the system-prompt preview", () => {
	it("asks the host for the prompt and opens it in a dialog", async () => {
		renderModes()

		fireEvent.click(screen.getByTestId("preview-prompt-button"))
		expect(posted("getSystemPrompt")[0]).toMatchObject({ mode: "code" })

		deliver({ type: "systemPrompt", text: "You are Shofer.", mode: "code" })
		await waitFor(() => expect(screen.getByText(/System Prompt \(code mode\)/)).toBeInTheDocument())
	})

	it("ignores a systemPrompt message carrying no text", () => {
		renderModes()
		deliver({ type: "systemPrompt", mode: "code" })
		expect(screen.queryByText(/System Prompt/)).not.toBeInTheDocument()
	})

	it("asks the host to copy the prompt", () => {
		renderModes()
		fireEvent.click(screen.getByTestId("copy-prompt-button"))
		expect(posted("copySystemPrompt")[0]).toMatchObject({ mode: "code" })
	})
})

describe("per-field reset", () => {
	it("is offered only for a plugin-owned mode, and posts the override removal at once", () => {
		renderModes()

		fireEvent.click(screen.getByTestId("role-definition-reset"))
		expect(posted("updatePrompt")[0]).toMatchObject({ promptMode: "code" })
		expect(posted("updatePrompt")[0].customPrompt.roleDefinition).toBeUndefined()
	})

	it("resets the description and when-to-use fields too", () => {
		renderModes()
		fireEvent.click(screen.getByTestId("description-reset"))
		fireEvent.click(screen.getByTestId("when-to-use-reset"))
		expect(posted("updatePrompt")).toHaveLength(2)
	})

	it("offers no reset for an authored mode — its text IS the mode", () => {
		renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })
		expect(screen.queryByTestId("role-definition-reset")).not.toBeInTheDocument()
	})
})

describe("export and import", () => {
	it("re-enables the export button when the host reports the outcome", async () => {
		renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.click(screen.getByTestId("export-mode-toolbar-button"))
		expect(screen.getByTestId("export-mode-toolbar-button")).toBeDisabled()

		deliver({ type: "exportModeResult", success: true })
		await waitFor(() => expect(screen.getByTestId("export-mode-toolbar-button")).toBeEnabled())
	})

	it("reports an export failure rather than hanging", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.click(screen.getByTestId("export-mode-toolbar-button"))
		deliver({ type: "exportModeResult", success: false, error: "disk full" })

		await waitFor(() => expect(screen.getByTestId("export-mode-toolbar-button")).toBeEnabled())
		expect(error).toHaveBeenCalled()
		error.mockRestore()
	})

	it("switches to the imported mode once the host confirms it", async () => {
		renderModes({ customModes: [...BUILT_IN, AUTHORED] })

		fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
		deliver({ type: "importModeResult", success: true, slug: "reviewer" })
		await waitFor(() => expect(screen.getByTestId("reviewer-prompt-textarea")).toBeInTheDocument())
	})

	it("falls back to the default mode when the imported slug is not in state yet", async () => {
		renderModes()

		fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
		deliver({ type: "importModeResult", success: true, slug: "not-here-yet" })
		await waitFor(() => expect(screen.getByTestId("code-prompt-textarea")).toBeInTheDocument())
	})

	it("stays quiet when the user cancelled the import", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		renderModes()

		fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
		deliver({ type: "importModeResult", success: false, error: "cancelled" })
		await waitFor(() =>
			expect(screen.queryByText("prompts:createModeDialog.buttons.cancel")).not.toBeInTheDocument(),
		)
		expect(error).not.toHaveBeenCalled()
		error.mockRestore()
	})

	it("reports a genuine import failure", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		renderModes()

		fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
		deliver({ type: "importModeResult", success: false, error: "malformed yaml" })
		await waitFor(() => expect(error).toHaveBeenCalled())
		error.mockRestore()
	})
})

describe("the delete pre-check", () => {
	it("opens the confirmation only once the host has answered, carrying the rules path", async () => {
		renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.click(screen.getByTestId("delete-mode-button"))
		expect(posted("deleteCustomMode")[0]).toMatchObject({ slug: "reviewer", checkOnly: true })

		deliver({
			type: "deleteCustomModeCheck",
			slug: "reviewer",
			rulesFolderPath: ".shofer/rules-reviewer",
		})
		await waitFor(() => expect(screen.getAllByText(/prompts:deleteMode/).length).toBeGreaterThan(0))
	})

	it("ignores an answer about a different mode", () => {
		renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })

		fireEvent.click(screen.getByTestId("delete-mode-button"))
		deliver({ type: "deleteCustomModeCheck", slug: "someone-else" })
		expect(screen.queryAllByText(/prompts:deleteMode/)).toHaveLength(0)
	})

	it("records which modes own a rules folder", () => {
		renderModes({ customModes: [...BUILT_IN, AUTHORED], mode: "reviewer" })
		deliver({ type: "checkRulesDirectoryResult", slug: "reviewer", hasContent: true })
		expect(screen.getByTestId("export-mode-toolbar-button")).toBeInTheDocument()
	})
})
