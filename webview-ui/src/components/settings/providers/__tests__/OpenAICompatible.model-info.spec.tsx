// npx vitest src/components/settings/providers/__tests__/OpenAICompatible.model-info.spec.tsx
//
// The custom model-info editor inside the openai-compatible panel. A generic
// endpoint tells us nothing about the model behind it, so every capability and
// price is hand-declared here — and each field folds its value into the SAME
// `openAiCustomModelInfo` object, which is where the interesting behaviour is:
// an unparseable entry falls back to the sane default rather than writing NaN,
// and the border colour is the only feedback the user gets that it did.

import { render, screen, fireEvent } from "@/utils/test-utils"

import { openAiModelInfoSaneDefaults, type OrganizationAllowList, type ProviderSettings } from "@shofer/types"

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

// Unlike the header table, the price fields are wired through `onChange`, so
// the double has to forward BOTH.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, onChange, placeholder, style }: any) => (
		<div>
			{children}
			<input
				aria-label={placeholder}
				placeholder={placeholder}
				style={style}
				value={value ?? ""}
				onChange={(e) => {
					onInput?.(e)
					onChange?.(e)
				}}
			/>
		</div>
	),
	VSCodeButton: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: ({ apiConfiguration, setApiConfigurationField }: any) => (
		<button
			data-testid="thinking-budget"
			data-effort={apiConfiguration.reasoningEffort ?? ""}
			onClick={() => setApiConfigurationField("reasoningEffort", "high")}
		/>
	),
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

/** The last value staged for `openAiCustomModelInfo`. */
const stagedModelInfo = () => {
	const calls = setApiConfigurationField.mock.calls.filter(([field]) => field === "openAiCustomModelInfo")
	return calls.at(-1)?.[1]
}

const field = (placeholderKey: string) =>
	screen.getByLabelText(`settings:placeholders.numbers.${placeholderKey}`) as HTMLInputElement

const type = (placeholderKey: string, value: string) => fireEvent.change(field(placeholderKey), { target: { value } })

const checkboxFor = (labelKey: string) =>
	screen.getByText(labelKey).closest("label")!.querySelector("input") as HTMLInputElement

beforeEach(() => vi.clearAllMocks())

describe("the numeric capability fields", () => {
	it("stages a parsed max-token count", () => {
		renderPanel()
		type("maxTokens", "4096")
		expect(stagedModelInfo()).toMatchObject({ maxTokens: 4096 })
	})

	it("clears max tokens rather than staging NaN", () => {
		renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: 10 } })
		type("maxTokens", "abc")
		expect(stagedModelInfo()).toMatchObject({ maxTokens: undefined })
	})

	it("stages a parsed context window", () => {
		renderPanel()
		// Deliberately not the sane default: an unchanged controlled value fires
		// no change event at all.
		type("contextWindow", "64000")
		expect(stagedModelInfo()).toMatchObject({ contextWindow: 64000 })
	})

	it("falls back to the sane default for an unparseable context window", () => {
		renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, contextWindow: 1 } })
		type("contextWindow", "")
		expect(stagedModelInfo()).toMatchObject({ contextWindow: openAiModelInfoSaneDefaults.contextWindow })
	})

	it("colours the border by whether the declared value is usable", () => {
		const { unmount } = renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: 100 } })
		expect(field("maxTokens").style.borderColor).toBe("var(--vscode-charts-green)")
		unmount()

		renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: -1 } })
		expect(field("maxTokens").style.borderColor).toBe("var(--vscode-errorForeground)")
	})

	it("leaves the border neutral when nothing is declared", () => {
		renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: undefined } })
		expect(field("maxTokens").style.borderColor).toBe("var(--vscode-input-border)")
	})
})

describe("the price fields", () => {
	it("stages a fractional input price", () => {
		renderPanel()
		type("inputPrice", "0.25")
		expect(stagedModelInfo()).toMatchObject({ inputPrice: 0.25 })
	})

	it("stages a fractional output price", () => {
		renderPanel()
		type("outputPrice", "1.5")
		expect(stagedModelInfo()).toMatchObject({ outputPrice: 1.5 })
	})

	it("treats zero as declared, not as absent", () => {
		renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, inputPrice: 0 } })
		expect(field("inputPrice").style.borderColor).toBe("var(--vscode-charts-green)")
	})

	it("flags a negative price", () => {
		renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, outputPrice: -1 } })
		expect(field("outputPrice").style.borderColor).toBe("var(--vscode-errorForeground)")
	})

	it("hides the cache prices until prompt caching is declared", () => {
		renderPanel()
		expect(screen.queryByLabelText("settings:placeholders.numbers.cacheWritePrice")).not.toBeInTheDocument()
	})

	it("stages the cache prices once caching is on", () => {
		renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, supportsPromptCache: true } })

		type("cacheWritePrice", "3.75")
		expect(stagedModelInfo()).toMatchObject({ cacheWritesPrice: 3.75 })
	})

	it("zeroes an unparseable cache price rather than staging NaN", () => {
		renderPanel({
			openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, supportsPromptCache: true, cacheWritesPrice: 2 },
		})

		type("cacheWritePrice", "x")
		expect(stagedModelInfo()).toMatchObject({ cacheWritesPrice: 0 })
	})
})

describe("the capability toggles", () => {
	it("declares image support", () => {
		renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, supportsImages: false } })

		fireEvent.click(checkboxFor("settings:providers.customModel.imageSupport.label"))
		expect(stagedModelInfo()).toMatchObject({ supportsImages: true })
	})

	it("declares prompt-cache support", () => {
		renderPanel()
		fireEvent.click(checkboxFor("settings:providers.customModel.promptCache.label"))
		expect(stagedModelInfo()).toMatchObject({ supportsPromptCache: true })
	})
})

describe("the reasoning-effort escape hatch", () => {
	it("hides the budget control until reasoning is enabled", () => {
		renderPanel()
		expect(screen.queryByTestId("thinking-budget")).not.toBeInTheDocument()
	})

	it("shows the model's own effort, and folds a change back into the model info", () => {
		renderPanel({
			enableReasoningEffort: true,
			openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, reasoningEffort: "low" },
		})

		expect(screen.getByTestId("thinking-budget")).toHaveAttribute("data-effort", "low")
		fireEvent.click(screen.getByTestId("thinking-budget"))
		expect(stagedModelInfo()).toMatchObject({ reasoningEffort: "high" })
	})

	it("strips the effort from the model info when reasoning is turned off", () => {
		renderPanel({
			enableReasoningEffort: true,
			openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, reasoningEffort: "high" },
		})

		fireEvent.click(checkboxFor("settings:providers.setReasoningLevel"))
		expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", false)
		expect(stagedModelInfo()).not.toHaveProperty("reasoningEffort")
	})
})

describe("resetting", () => {
	it("puts every capability back to the sane defaults", () => {
		renderPanel({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: 1 } })

		fireEvent.click(screen.getByText("settings:providers.customModel.resetDefaults"))
		expect(stagedModelInfo()).toEqual(openAiModelInfoSaneDefaults)
	})
})
