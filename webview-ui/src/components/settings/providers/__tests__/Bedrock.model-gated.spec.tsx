// npx vitest src/components/settings/providers/__tests__/Bedrock.model-gated.spec.tsx
//
// Bedrock's panel is mostly MODEL-GATED: the 1M-context beta, global-inference
// routing, service tiers and prompt caching each appear only for the model ids
// that support them, so the interesting assertions are about what is ABSENT for
// an ordinary model. The credential-shape switch is the other half — three
// mutually exclusive input sets behind one dropdown.

import { render, screen, fireEvent } from "@/utils/test-utils"

import {
	BEDROCK_1M_CONTEXT_MODEL_IDS,
	BEDROCK_GLOBAL_INFERENCE_MODEL_IDS,
	BEDROCK_SERVICE_TIER_MODEL_IDS,
	type ProviderSettings,
} from "@shofer/types"

import { Bedrock } from "../Bedrock"

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
	VSCodeTextField: ({ children, value, onInput, placeholder }: any) => (
		<div>
			{children}
			<input aria-label={placeholder} value={value ?? ""} onChange={(e) => onInput?.(e)} />
		</div>
	),
}))

const setApiConfigurationField = vi.fn()

const renderPanel = (apiConfiguration: ProviderSettings = {}, selectedModelInfo?: Record<string, unknown>) =>
	render(
		<Bedrock
			apiConfiguration={apiConfiguration}
			setApiConfigurationField={setApiConfigurationField}
			selectedModelInfo={selectedModelInfo as never}
		/>,
	)

const staged = (field: string) => setApiConfigurationField.mock.calls.filter(([f]) => f === field).at(-1)?.[1]
const checkboxFor = (labelKey: string) =>
	screen.getByText(labelKey).closest("label")!.querySelector("input") as HTMLInputElement
const hasLabel = (labelKey: string) => screen.queryByText(labelKey) !== null

const ORDINARY_MODEL = "amazon.titan-text-lite-v1"

beforeEach(() => vi.clearAllMocks())

describe("the credential shape", () => {
	it("asks for an access key pair by default", () => {
		renderPanel()
		expect(screen.getByLabelText("settings:placeholders.accessKey")).toBeInTheDocument()
		expect(screen.getByLabelText("settings:placeholders.sessionToken")).toBeInTheDocument()
	})

	it("asks for a named profile instead when one is chosen", () => {
		renderPanel({ awsUseProfile: true })

		expect(screen.getByLabelText("settings:placeholders.profileName")).toBeInTheDocument()
		expect(screen.queryByLabelText("settings:placeholders.accessKey")).not.toBeInTheDocument()
	})

	it("asks for a bearer API key when that is chosen", () => {
		renderPanel({ awsUseApiKey: true })

		expect(screen.getByLabelText("settings:placeholders.apiKey")).toBeInTheDocument()
		expect(screen.queryByLabelText("settings:placeholders.profileName")).not.toBeInTheDocument()
	})

	it("clears the OTHER two flags whichever method is picked", () => {
		renderPanel()
		// The authentication picker is the first combobox on the panel.
		fireEvent.click(screen.getAllByRole("combobox")[0])
		fireEvent.click(screen.getByText("settings:providers.awsProfile"))

		expect(setApiConfigurationField).toHaveBeenCalledWith("awsUseApiKey", false)
		expect(setApiConfigurationField).toHaveBeenCalledWith("awsUseProfile", true)
	})

	it("stages each credential field it collects", () => {
		renderPanel()

		fireEvent.change(screen.getByLabelText("settings:placeholders.accessKey"), { target: { value: "AKIA" } })
		fireEvent.change(screen.getByLabelText("settings:placeholders.secretKey"), { target: { value: "secret" } })
		fireEvent.change(screen.getByLabelText("settings:placeholders.sessionToken"), { target: { value: "tok" } })

		expect(staged("awsAccessKey")).toBe("AKIA")
		expect(staged("awsSecretKey")).toBe("secret")
		expect(staged("awsSessionToken")).toBe("tok")
	})

	it("stages a profile name", () => {
		renderPanel({ awsUseProfile: true })
		fireEvent.change(screen.getByLabelText("settings:placeholders.profileName"), { target: { value: "prod" } })
		expect(staged("awsProfile")).toBe("prod")
	})

	it("stages a bearer key", () => {
		renderPanel({ awsUseApiKey: true })
		fireEvent.change(screen.getByLabelText("settings:placeholders.apiKey"), { target: { value: "bedrock-key" } })
		expect(staged("awsApiKey")).toBe("bedrock-key")
	})
})

describe("model-gated controls", () => {
	it("offers none of them for an ordinary model", () => {
		renderPanel({ apiModelId: ORDINARY_MODEL })

		expect(hasLabel("settings:providers.awsServiceTier")).toBe(false)
		expect(hasLabel("settings:providers.awsGlobalInference")).toBe(false)
		expect(hasLabel("settings:providers.awsBedrock1MContextBetaLabel")).toBe(false)
	})

	it("offers none of them when no model is chosen at all", () => {
		renderPanel({})
		expect(hasLabel("settings:providers.awsServiceTier")).toBe(false)
	})

	it("offers the service tier for a model that has them", () => {
		renderPanel({ apiModelId: BEDROCK_SERVICE_TIER_MODEL_IDS[0] })

		expect(hasLabel("settings:providers.awsServiceTier")).toBe(true)
		fireEvent.click(screen.getAllByRole("combobox").at(-1)!)
		fireEvent.click(screen.getByText("settings:providers.awsServiceTierFlex"))
		expect(staged("awsBedrockServiceTier")).toBe("FLEX")
	})

	it("offers global inference for a model that supports it", () => {
		renderPanel({ apiModelId: BEDROCK_GLOBAL_INFERENCE_MODEL_IDS[0] })

		fireEvent.click(checkboxFor("settings:providers.awsGlobalInference"))
		expect(staged("awsUseGlobalInference")).toBe(true)
	})

	it("offers the 1M-context beta for a model that supports it", () => {
		renderPanel({ apiModelId: BEDROCK_1M_CONTEXT_MODEL_IDS[0] })

		fireEvent.click(checkboxFor("settings:providers.awsBedrock1MContextBetaLabel"))
		expect(staged("awsBedrock1MContext")).toBe(true)
	})

	it("offers prompt caching only when the MODEL INFO says the model has it", () => {
		const { unmount } = renderPanel({ apiModelId: ORDINARY_MODEL }, { supportsPromptCache: false })
		expect(hasLabel("settings:providers.enablePromptCaching")).toBe(false)
		unmount()

		renderPanel({ apiModelId: ORDINARY_MODEL }, { supportsPromptCache: true })
		// It defaults ON, so the observable staging is turning it OFF.
		fireEvent.click(checkboxFor("settings:providers.enablePromptCaching"))
		expect(staged("awsUsePromptCache")).toBe(false)
	})
})

describe("cross-region inference", () => {
	it("is offered for every model and stages its own flag", () => {
		renderPanel({ apiModelId: ORDINARY_MODEL })

		fireEvent.click(checkboxFor("settings:providers.awsCrossRegion"))
		expect(staged("awsUseCrossRegionInference")).toBe(true)
	})
})

describe("the region picker", () => {
	it("stages a chosen region", () => {
		renderPanel()
		fireEvent.click(screen.getAllByRole("combobox").at(-1)!)
		fireEvent.click(screen.getByText(/us-east-1/))
		expect(staged("awsRegion")).toContain("us-east-1")
	})
})
