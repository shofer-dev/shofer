// npx vitest src/components/settings/providers/__tests__/OpenAICompatible.headers.spec.tsx
//
// The openai-compatible panel is the one provider form with real internal
// state: a custom-header table it holds locally and debounces back into
// `openAiHeaders`, the Azure api-version reveal, and the custom model-info
// capability fields.

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import type { OrganizationAllowList, ProviderSettings } from "@shofer/types"

import { OpenAICompatible } from "../OpenAICompatible"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} />
			{children}
		</label>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, placeholder, type }: any) => (
		<div>
			{children}
			<input
				aria-label={placeholder}
				placeholder={placeholder}
				type={type === "password" ? "text" : "text"}
				value={value ?? ""}
				onChange={(e) => onInput?.(e)}
			/>
		</div>
	),
	VSCodeButton: ({ children, onClick, appearance }: any) => (
		<button data-appearance={appearance} onClick={onClick}>
			{children}
		</button>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

const setApiConfigurationField = vi.fn()
const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }

const renderPanel = (apiConfiguration: ProviderSettings = {}) =>
	render(
		<OpenAICompatible
			apiConfiguration={apiConfiguration}
			setApiConfigurationField={setApiConfigurationField}
			organizationAllowList={organizationAllowList}
		/>,
	)

const staged = (field: string) => setApiConfigurationField.mock.calls.filter((c) => c[0] === field).map((c) => c[1])

const field = (placeholder: string) => screen.getByPlaceholderText(placeholder)

// The add/remove header buttons are icon-only (labelled by a tooltip).
const iconButton = (icon: string, index = 0) =>
	Array.from(document.querySelectorAll(`.codicon-${icon}`))[index].closest("button") as HTMLButtonElement

/** The header table is debounced back into the configuration. */
const settleHeaders = async () =>
	act(async () => {
		vi.advanceTimersByTime(1000)
		await Promise.resolve()
	})

beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers()
})

afterEach(() => vi.useRealTimers())

describe("the base fields", () => {
	it("stages the base url, key and model id", () => {
		renderPanel()

		fireEvent.change(field("settings:placeholders.baseUrl"), { target: { value: "https://x/v1" } })
		fireEvent.change(field("settings:placeholders.apiKey"), { target: { value: "k" } })
		fireEvent.change(field("settings:providers.openAiModelIdPlaceholder"), { target: { value: "gpt-x" } })

		expect(staged("openAiBaseUrl")).toEqual(["https://x/v1"])
		expect(staged("openAiApiKey")).toEqual(["k"])
		expect(staged("openAiModelId")).toEqual(["gpt-x"])
	})

	it("stages the streaming and R1-format toggles", () => {
		renderPanel({ openAiStreamingEnabled: true })
		const boxes = Array.from(document.querySelectorAll("input[type=checkbox]")) as HTMLInputElement[]
		fireEvent.click(boxes[0])
		expect(setApiConfigurationField).toHaveBeenCalled()
	})
})

describe("the Azure api version", () => {
	it("reveals its field only once the box is checked, and clears it when unchecked", () => {
		const { rerender } = renderPanel()
		expect(screen.queryByPlaceholderText(/^Default: /)).not.toBeInTheDocument()

		const azureBox = screen.getByText("settings:modelInfo.azureApiVersion").parentElement!
		fireEvent.click(azureBox.querySelector("input")!)
		expect(screen.getByPlaceholderText(/^Default: /)).toBeInTheDocument()

		fireEvent.click(azureBox.querySelector("input")!)
		expect(staged("azureApiVersion")).toContain("")

		rerender(
			<OpenAICompatible
				apiConfiguration={{ azureApiVersion: "2024-01-01" }}
				setApiConfigurationField={setApiConfigurationField}
				organizationAllowList={organizationAllowList}
			/>,
		)
	})

	it("opens pre-checked when a version is already configured", () => {
		renderPanel({ azureApiVersion: "2024-01-01" })
		expect(screen.getByPlaceholderText(/^Default: /)).toHaveValue("2024-01-01")
	})
})

describe("custom headers", () => {
	it("says so when there are none", () => {
		renderPanel()
		expect(screen.getByText("settings:providers.noCustomHeaders")).toBeInTheDocument()
	})

	it("adds an empty row, fills it, and pushes it into the configuration", async () => {
		renderPanel()

		fireEvent.click(iconButton("add"))
		expect(screen.queryByText("settings:providers.noCustomHeaders")).not.toBeInTheDocument()

		fireEvent.change(field("settings:providers.headerName"), { target: { value: "X-Trace" } })
		fireEvent.change(field("settings:providers.headerValue"), { target: { value: "abc" } })
		await settleHeaders()

		expect(staged("openAiHeaders").at(-1)).toEqual({ "X-Trace": "abc" })
	})

	it("renders the headers already configured, and removes one", async () => {
		renderPanel({ openAiHeaders: { "X-A": "1", "X-B": "2" } })
		expect(screen.getAllByPlaceholderText("settings:providers.headerName")).toHaveLength(2)

		fireEvent.click(iconButton("trash", 0))
		await settleHeaders()

		expect(staged("openAiHeaders").at(-1)).toEqual({ "X-B": "2" })
	})

	it("drops a row whose name is blank", async () => {
		renderPanel({ openAiHeaders: { "X-A": "1" } })
		fireEvent.change(screen.getAllByPlaceholderText("settings:providers.headerName")[0], {
			target: { value: "" },
		})
		await settleHeaders()
		expect(staged("openAiHeaders").at(-1)).toEqual({})
	})
})

describe("the custom model capabilities", () => {
	it("stages the max-output-tokens toggle", () => {
		renderPanel({ openAiStreamingEnabled: true, includeMaxTokens: true })
		const box = screen.getByText("settings:includeMaxOutputTokens").parentElement!
		fireEvent.click(box.querySelector("input")!)
		expect(staged("includeMaxTokens")).toEqual([false])
	})

	it("shows the capability fields", () => {
		renderPanel()
		expect(screen.getByText("settings:providers.customModel.capabilities")).toBeInTheDocument()
	})
})
