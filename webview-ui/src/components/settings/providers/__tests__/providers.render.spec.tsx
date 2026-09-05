// npx vitest src/components/settings/providers/__tests__/providers.render.spec.tsx
//
// Breadth coverage for the provider settings forms. Every provider panel is a
// controlled form over `ProviderSettings`: it MUST stage edits through
// `setApiConfigurationField` (SettingsView's `cachedState` buffer) and must not
// post a setting value to the host on change — the save-gating rule in
// `webview-ui/AGENTS.md`. These specs assert exactly that shape per provider:
// typing calls the setter, and the only `vscode.postMessage` calls are the
// exempt action buttons (refresh/fetch models), never a settings write.

import { render, screen, fireEvent, within } from "@/utils/test-utils"

import type { ProviderSettings, OrganizationAllowList } from "@shofer/types"

import { Anthropic } from "../Anthropic"
import { Baseten } from "../Baseten"
import { BedrockCustomArn } from "../BedrockCustomArn"
import { Dashscope } from "../Dashscope"
import { DeepSeek } from "../DeepSeek"
import { Fireworks } from "../Fireworks"
import { LMStudio } from "../LMStudio"
import { LiteLLM } from "../LiteLLM"
import { MiniMax } from "../MiniMax"
import { Mistral } from "../Mistral"
import { Moonshot } from "../Moonshot"
import { Ollama } from "../Ollama"
import { OpenAI } from "../OpenAI"
import { OpenAICodex } from "../OpenAICodex"
import { OpenRouter } from "../OpenRouter"
import { OpenRouterBalanceDisplay } from "../OpenRouterBalanceDisplay"
import { Poe } from "../Poe"
import { QwenCode } from "../QwenCode"
import { Requesty } from "../Requesty"
import { RequestyBalanceDisplay } from "../RequestyBalanceDisplay"
import { SambaNova } from "../SambaNova"
import { Shofer } from "../Shofer"
import { Unbound } from "../Unbound"
import { VSCodeLM } from "../VSCodeLM"
import { VercelAiGateway } from "../VercelAiGateway"
import { XAI } from "../XAI"
import { Xiaomi } from "../Xiaomi"
import { ZAi } from "../ZAi"

const postMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
	useTranslation: () => ({ t: (key: string) => key }),
}))

const extensionState = {
	routerModels: {
		litellm: { "gpt-4o": { supportsPromptCache: true, contextWindow: 1, maxTokens: 1 } },
		poe: {},
		shofer: {},
	} as Record<string, unknown>,
	vsCodeLmModels: [] as Array<Record<string, unknown>>,
}

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ id: "claude-sonnet-4-5", info: { supportsPromptCache: false } }),
}))

const routerModelsQuery = { data: undefined as Record<string, unknown> | undefined }
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => routerModelsQuery,
}))

const requestyKeyInfo = { data: undefined as { org_balance: string } | undefined }
vi.mock("@/components/ui/hooks/useRequestyKeyInfo", () => ({
	useRequestyKeyInfo: () => requestyKeyInfo,
}))

const openRouterKeyInfo = { data: undefined as { limit: number; usage: number } | undefined }
vi.mock("@/components/ui/hooks/useOpenRouterKeyInfo", () => ({
	useOpenRouterKeyInfo: () => openRouterKeyInfo,
}))

// The model picker has its own specs; here it is a marker so a provider's own
// markup is what the assertions see.
vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({ modelIdKey, errorMessage }: { modelIdKey: string; errorMessage?: string }) => (
		<div data-testid={`model-picker-${modelIdKey}`}>{errorMessage}</div>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, onBlur, type, placeholder }: any) => (
		<div>
			{children}
			<input
				aria-label={placeholder}
				type={type === "password" ? "text" : type || "text"}
				value={value ?? ""}
				placeholder={placeholder}
				onChange={(e) => onInput?.(e)}
				onBlur={(e) => onBlur?.(e)}
			/>
		</div>
	),
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e)} />
			{children}
		</label>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
	VSCodeDropdown: ({ children, value, onChange, className }: any) => (
		<select className={className} value={value ?? ""} onChange={(e) => onChange?.(e)}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: any) => <option value={value}>{children}</option>,
	VSCodeButton: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	VSCodeRadio: ({ value, checked, onChange }: any) => (
		<input type="radio" value={value} checked={!!checked} onChange={(e) => onChange?.(e)} />
	),
	VSCodeRadioGroup: ({ children }: any) => <div>{children}</div>,
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} />
			{children}
		</label>
	),
}))

const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }

const setField = vi.fn()

const inputs = () => Array.from(document.querySelectorAll("input")) as HTMLInputElement[]
const textInputs = () => inputs().filter((el) => el.type === "text" || el.type === "url")

beforeEach(() => {
	vi.clearAllMocks()
	routerModelsQuery.data = undefined
	requestyKeyInfo.data = undefined
	openRouterKeyInfo.data = undefined
	extensionState.vsCodeLmModels = []
})

describe("simple key-only provider forms", () => {
	// Each entry: component, the settings key its first text field stages, and
	// the config that hides the "get an API key" affordance.
	const cases: Array<[string, React.ComponentType<any>, keyof ProviderSettings]> = [
		["Baseten", Baseten, "basetenApiKey"],
		["DeepSeek", DeepSeek, "deepSeekApiKey"],
		["Fireworks", Fireworks, "fireworksApiKey"],
		["SambaNova", SambaNova, "sambaNovaApiKey"],
		["XAI", XAI, "xaiApiKey"],
		["Xiaomi", Xiaomi, "xiaomiApiKey"],
		["Mistral", Mistral, "mistralApiKey"],
	]

	it.each(cases)("%s stages the api key instead of posting it", (_name, Component, key) => {
		const { unmount } = render(<Component apiConfiguration={{}} setApiConfigurationField={setField} />)

		fireEvent.change(textInputs()[0], { target: { value: "secret" } })

		expect(setField).toHaveBeenCalledWith(key, "secret")
		expect(postMessage).not.toHaveBeenCalled()
		unmount()
	})

	it.each(cases)("%s renders with a key already set", (_name, Component, key) => {
		const { unmount } = render(
			<Component apiConfiguration={{ [key]: "abc" } as ProviderSettings} setApiConfigurationField={setField} />,
		)
		expect(textInputs()[0]).toHaveValue("abc")
		unmount()
	})
})

describe("Anthropic", () => {
	it("offers the 1M-context beta for a supporting model and stages the toggle", () => {
		render(<Anthropic apiConfiguration={{ apiKey: "k" }} setApiConfigurationField={setField} />)

		const checkboxes = inputs().filter((el) => el.type === "checkbox")
		expect(checkboxes.length).toBeGreaterThan(0)
		fireEvent.click(checkboxes[checkboxes.length - 1])
		expect(setField).toHaveBeenCalled()
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("reveals the base url field once the custom-url box is checked", () => {
		render(
			<Anthropic
				apiConfiguration={{ apiKey: "k", anthropicBaseUrl: "https://example.test" }}
				setApiConfigurationField={setField}
			/>,
		)
		expect(textInputs().some((el) => el.value === "https://example.test")).toBe(true)
	})
})

describe("Dashscope", () => {
	it("stages both the base url and the api key", () => {
		render(<Dashscope apiConfiguration={{}} setApiConfigurationField={setField} />)

		const fields = textInputs()
		fireEvent.change(fields[0], { target: { value: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" } })
		expect(setField).toHaveBeenCalledWith(
			"dashScopeBaseUrl",
			"https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		)

		fireEvent.change(fields[1], { target: { value: "k" } })
		expect(setField).toHaveBeenCalledWith("dashScopeApiKey", "k")
		expect(postMessage).not.toHaveBeenCalled()
	})
})

describe("Moonshot", () => {
	it("stages the base url and the api key", () => {
		render(<Moonshot apiConfiguration={{}} setApiConfigurationField={setField} />)

		const fields = textInputs()
		fireEvent.change(fields[0], { target: { value: "https://api.moonshot.ai/v1" } })
		expect(setField).toHaveBeenCalledWith("moonshotBaseUrl", "https://api.moonshot.ai/v1")

		fireEvent.change(fields[1], { target: { value: "mk" } })
		expect(setField).toHaveBeenCalledWith("moonshotApiKey", "mk")
	})
})

describe("MiniMax", () => {
	it("stages the endpoint choice and the key, and links the matching console", () => {
		const { rerender } = render(<MiniMax apiConfiguration={{}} setApiConfigurationField={setField} />)

		fireEvent.change(screen.getByRole("combobox"), { target: { value: "https://api.minimaxi.com/v1" } })
		expect(setField).toHaveBeenCalledWith("minimaxBaseUrl", "https://api.minimaxi.com/v1")

		rerender(
			<MiniMax
				apiConfiguration={{ minimaxBaseUrl: "https://api.minimaxi.com/v1" }}
				setApiConfigurationField={setField}
			/>,
		)
		expect(screen.getByText("settings:providers.getMiniMaxApiKey").closest("a")).toHaveAttribute(
			"href",
			expect.stringContaining("minimaxi.com"),
		)
	})

	it("hides the get-key link once a key is present", () => {
		render(<MiniMax apiConfiguration={{ minimaxApiKey: "k" }} setApiConfigurationField={setField} />)
		expect(screen.queryByText("settings:providers.getMiniMaxApiKey")).not.toBeInTheDocument()
	})
})

describe("ZAi", () => {
	it("stages the api line and points the key link at the matching console", () => {
		const { rerender } = render(<ZAi apiConfiguration={{}} setApiConfigurationField={setField} />)

		fireEvent.change(screen.getByRole("combobox"), { target: { value: "china_coding" } })
		expect(setField).toHaveBeenCalledWith("zaiApiLine", "china_coding")

		rerender(<ZAi apiConfiguration={{ zaiApiLine: "china_coding" }} setApiConfigurationField={setField} />)
		expect(screen.getByText("settings:providers.getZaiApiKey").closest("a")).toHaveAttribute(
			"href",
			"https://open.bigmodel.cn/console/overview",
		)
	})

	it("stages the api key", () => {
		render(<ZAi apiConfiguration={{}} setApiConfigurationField={setField} />)
		fireEvent.change(textInputs()[0], { target: { value: "zk" } })
		expect(setField).toHaveBeenCalledWith("zaiApiKey", "zk")
	})
})

describe("QwenCode", () => {
	it("stages the typed oauth path and falls back to the default on an empty blur", () => {
		render(<QwenCode apiConfiguration={{}} setApiConfigurationField={setField} />)

		const field = textInputs()[0]
		fireEvent.change(field, { target: { value: "/tmp/creds.json" } })
		expect(setField).toHaveBeenCalledWith("qwenCodeOauthPath", "/tmp/creds.json")

		fireEvent.blur(field, { target: { value: "   " } })
		expect(setField).toHaveBeenCalledWith("qwenCodeOauthPath", "~/.qwen/oauth_creds.json")
	})

	it("keeps a non-empty value on blur", () => {
		render(<QwenCode apiConfiguration={{ qwenCodeOauthPath: "/a" }} setApiConfigurationField={setField} />)
		fireEvent.blur(textInputs()[0], { target: { value: "/a" } })
		expect(setField).not.toHaveBeenCalledWith("qwenCodeOauthPath", "~/.qwen/oauth_creds.json")
	})
})

describe("BedrockCustomArn", () => {
	it("accepts a well-formed arn", () => {
		render(
			<BedrockCustomArn
				apiConfiguration={{
					awsCustomArn: "arn:aws:bedrock:us-west-2:123456789012:provisioned-model/my-provisioned-model",
					awsRegion: "us-west-2",
				}}
				setApiConfigurationField={setField}
			/>,
		)
		expect(screen.queryByText("settings:providers.invalidArnFormat")).not.toBeInTheDocument()
	})

	it("reports a malformed arn", () => {
		render(
			<BedrockCustomArn apiConfiguration={{ awsCustomArn: "not-an-arn" }} setApiConfigurationField={setField} />,
		)
		expect(document.body.textContent).toContain("settings:")
	})

	it("stages the typed arn", () => {
		render(<BedrockCustomArn apiConfiguration={{}} setApiConfigurationField={setField} />)
		fireEvent.change(textInputs()[0], { target: { value: "arn:aws:bedrock:us-east-1:1:x/y" } })
		expect(setField).toHaveBeenCalledWith("awsCustomArn", "arn:aws:bedrock:us-east-1:1:x/y")
	})
})

describe("OpenAI (native)", () => {
	it("clears the custom base url when the box is unchecked", () => {
		render(
			<OpenAI
				apiConfiguration={{ openAiNativeBaseUrl: "https://proxy.test/v1" }}
				setApiConfigurationField={setField}
			/>,
		)
		const box = inputs().find((el) => el.type === "checkbox")!
		fireEvent.click(box)
		expect(setField).toHaveBeenCalledWith("openAiNativeBaseUrl", "")
	})

	it("stages the api key and hides the get-key link once set", () => {
		const { rerender } = render(<OpenAI apiConfiguration={{}} setApiConfigurationField={setField} />)
		fireEvent.change(textInputs()[0], { target: { value: "sk" } })
		expect(setField).toHaveBeenCalledWith("openAiNativeApiKey", "sk")
		expect(screen.getByText("settings:providers.getOpenAiApiKey")).toBeInTheDocument()

		rerender(<OpenAI apiConfiguration={{ openAiNativeApiKey: "sk" }} setApiConfigurationField={setField} />)
		expect(screen.queryByText("settings:providers.getOpenAiApiKey")).not.toBeInTheDocument()
	})

	it("offers the service-tier picker only for a model declaring flex/priority tiers", () => {
		const { rerender } = render(
			<OpenAI
				apiConfiguration={{}}
				setApiConfigurationField={setField}
				selectedModelInfo={{ contextWindow: 1, supportsPromptCache: false } as never}
			/>,
		)
		expect(screen.queryByTestId("openai-service-tier")).not.toBeInTheDocument()

		rerender(
			<OpenAI
				apiConfiguration={{}}
				setApiConfigurationField={setField}
				selectedModelInfo={
					{
						contextWindow: 1,
						supportsPromptCache: false,
						tiers: [{ name: "flex" }, { name: "priority" }],
					} as never
				}
			/>,
		)
		expect(screen.getByTestId("openai-service-tier")).toBeInTheDocument()
	})
})

describe("OpenRouter", () => {
	it("shows the auth link only without a key and renders the balance with one", () => {
		const { rerender } = render(
			<OpenRouter
				apiConfiguration={{}}
				setApiConfigurationField={setField}
				selectedModelId="x"
				uriScheme="vscode"
				organizationAllowList={organizationAllowList}
			/>,
		)
		expect(screen.getByText("settings:providers.getOpenRouterApiKey")).toBeInTheDocument()

		openRouterKeyInfo.data = { limit: 10, usage: 2.5 }
		rerender(
			<OpenRouter
				apiConfiguration={{ openRouterApiKey: "k" }}
				setApiConfigurationField={setField}
				selectedModelId="x"
				uriScheme="vscode"
				organizationAllowList={organizationAllowList}
			/>,
		)
		expect(screen.queryByText("settings:providers.getOpenRouterApiKey")).not.toBeInTheDocument()
		expect(screen.getByText("$7.50")).toBeInTheDocument()
	})

	it("clears the base url when the custom-url box is unchecked", () => {
		render(
			<OpenRouter
				apiConfiguration={{ openRouterApiKey: "k", openRouterBaseUrl: "https://x/v1" }}
				setApiConfigurationField={setField}
				selectedModelId="x"
				uriScheme={undefined}
				organizationAllowList={organizationAllowList}
			/>,
		)
		fireEvent.click(inputs().find((el) => el.type === "checkbox")!)
		expect(setField).toHaveBeenCalledWith("openRouterBaseUrl", "")
	})

	it("hides the custom-url affordance under simplified settings", () => {
		render(
			<OpenRouter
				apiConfiguration={{ openRouterApiKey: "k" }}
				setApiConfigurationField={setField}
				selectedModelId="x"
				uriScheme={undefined}
				simplifySettings
				organizationAllowList={organizationAllowList}
			/>,
		)
		expect(screen.queryByText("settings:providers.useCustomBaseUrl")).not.toBeInTheDocument()
	})
})

describe("balance displays", () => {
	it("render nothing until their key info resolves", () => {
		const { container } = render(<OpenRouterBalanceDisplay apiKey="k" />)
		expect(container).toBeEmptyDOMElement()

		const requesty = render(<RequestyBalanceDisplay apiKey="k" />)
		expect(requesty.container).toBeEmptyDOMElement()
	})

	it("renders nothing when OpenRouter reports no limit", () => {
		openRouterKeyInfo.data = { limit: 0, usage: 0 }
		const { container } = render(<OpenRouterBalanceDisplay apiKey="k" />)
		expect(container).toBeEmptyDOMElement()
	})

	it("formats the Requesty org balance and links its settings page", () => {
		requestyKeyInfo.data = { org_balance: "12.3456" }
		render(<RequestyBalanceDisplay apiKey="k" baseUrl="https://router.requesty.ai/v1" />)
		const link = screen.getByText("$12.35").closest("a")
		expect(link).toHaveAttribute("href", expect.stringContaining("settings"))
	})
})

describe("Requesty", () => {
	it("posts a refresh (an exempt action) but stages the key", () => {
		render(
			<Requesty
				apiConfiguration={{}}
				setApiConfigurationField={setField}
				refetchRouterModels={vi.fn()}
				organizationAllowList={organizationAllowList}
				uriScheme="vscode"
			/>,
		)

		fireEvent.change(textInputs()[0], { target: { value: "rk" } })
		expect(setField).toHaveBeenCalledWith("requestyApiKey", "rk")
		expect(postMessage).not.toHaveBeenCalled()

		fireEvent.click(screen.getByText("settings:providers.refreshModels.label"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { provider: "requesty", refresh: true },
		})
	})

	it("clears the base url when the custom-endpoint box is unchecked", () => {
		render(
			<Requesty
				apiConfiguration={{ requestyBaseUrl: "https://x/v1" }}
				setApiConfigurationField={setField}
				refetchRouterModels={vi.fn()}
				organizationAllowList={organizationAllowList}
			/>,
		)
		fireEvent.click(inputs().find((el) => el.type === "checkbox")!)
		expect(setField).toHaveBeenCalledWith("requestyBaseUrl", undefined)
	})
})

describe("Unbound", () => {
	it("stages the key and refreshes on demand", () => {
		render(
			<Unbound
				apiConfiguration={{}}
				setApiConfigurationField={setField}
				refetchRouterModels={vi.fn()}
				organizationAllowList={organizationAllowList}
			/>,
		)
		fireEvent.change(textInputs()[0], { target: { value: "uk" } })
		expect(setField).toHaveBeenCalledWith("unboundApiKey", "uk")

		fireEvent.click(screen.getByText("settings:providers.refreshModels.label"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { provider: "unbound", refresh: true },
		})
	})
})

describe("VercelAiGateway", () => {
	it("stages the api key", () => {
		render(
			<VercelAiGateway
				apiConfiguration={{}}
				setApiConfigurationField={setField}
				organizationAllowList={organizationAllowList}
			/>,
		)
		fireEvent.change(textInputs()[0], { target: { value: "vk" } })
		expect(setField).toHaveBeenCalled()
		expect(screen.getByTestId("model-picker-vercelAiGatewayModelId")).toBeInTheDocument()
	})
})

describe("VSCodeLM", () => {
	it("explains the provider when the host advertises no models", () => {
		render(<VSCodeLM apiConfiguration={{}} setApiConfigurationField={setField} />)
		expect(screen.getByText("settings:providers.vscodeLmDescription")).toBeInTheDocument()
		expect(screen.queryByTestId("model-picker-vsCodeLmModelSelector")).not.toBeInTheDocument()
	})

	it("offers a picker once models exist, skipping entries with no vendor/family", () => {
		extensionState.vsCodeLmModels = [
			{ vendor: "copilot", family: "gpt-4o", maxInputTokens: 1000 },
			{ vendor: "copilot" },
		]
		render(<VSCodeLM apiConfiguration={{}} setApiConfigurationField={setField} />)
		expect(screen.getByTestId("model-picker-vsCodeLmModelSelector")).toBeInTheDocument()
	})
})

describe("LiteLLM", () => {
	const renderLiteLLM = (apiConfiguration: ProviderSettings) =>
		render(
			<LiteLLM
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setField}
				organizationAllowList={organizationAllowList}
			/>,
		)

	it("refuses to refresh without both a key and a base url", () => {
		renderLiteLLM({ litellmApiKey: "k" })
		const button = screen.getByText("settings:providers.refreshModels.label").closest("button")!
		expect(button).toBeDisabled()
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("posts a refresh and reports success when the router answers", () => {
		renderLiteLLM({ litellmApiKey: "k", litellmBaseUrl: "https://l/v1" })
		fireEvent.click(screen.getByText("settings:providers.refreshModels.label"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { litellmApiKey: "k", litellmBaseUrl: "https://l/v1" },
		})
		expect(screen.getByText("settings:providers.refreshModels.loading")).toBeInTheDocument()

		fireEvent(window, new MessageEvent("message", { data: { type: "routerModels" } }))
		expect(screen.getByText("settings:providers.refreshModels.success")).toBeInTheDocument()
	})

	it("surfaces a per-provider fetch failure", () => {
		renderLiteLLM({ litellmApiKey: "k", litellmBaseUrl: "https://l/v1" })
		fireEvent.click(screen.getByText("settings:providers.refreshModels.label"))
		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "singleRouterModelFetchResponse",
					success: false,
					error: "boom",
					values: { provider: "litellm" },
				},
			}),
		)
		expect(screen.getByText("boom")).toBeInTheDocument()
	})

	it("ignores a failure reported for a different provider", () => {
		renderLiteLLM({ litellmApiKey: "k", litellmBaseUrl: "https://l/v1" })
		fireEvent.click(screen.getByText("settings:providers.refreshModels.label"))
		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "singleRouterModelFetchResponse",
					success: false,
					error: "other",
					values: { provider: "openrouter" },
				},
			}),
		)
		expect(screen.queryByText("other")).not.toBeInTheDocument()
	})

	it("offers prompt caching only for a model that supports it", () => {
		renderLiteLLM({ litellmApiKey: "k", litellmBaseUrl: "https://l/v1", litellmModelId: "gpt-4o" })
		const box = inputs().find((el) => el.type === "checkbox")!
		fireEvent.click(box)
		expect(setField).toHaveBeenCalledWith("litellmUsePromptCache", true)
	})

	it("hides prompt caching for a model that does not", () => {
		renderLiteLLM({ litellmApiKey: "k", litellmBaseUrl: "https://l/v1", litellmModelId: "unknown" })
		expect(inputs().some((el) => el.type === "checkbox")).toBe(false)
	})
})

describe("Poe", () => {
	const renderPoe = (apiConfiguration: ProviderSettings) =>
		render(
			<Poe
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setField}
				organizationAllowList={organizationAllowList}
			/>,
		)

	it("disables refresh with no key", () => {
		renderPoe({})
		expect(screen.getByText("settings:providers.refreshModels.label").closest("button")).toBeDisabled()
	})

	it("posts the key and base url on refresh", () => {
		renderPoe({ poeApiKey: "pk", poeBaseUrl: "https://poe/v1" })
		fireEvent.click(screen.getByText("settings:providers.refreshModels.label"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { poeApiKey: "pk", poeBaseUrl: "https://poe/v1" },
		})
	})

	it("surfaces a poe-specific fetch failure", () => {
		renderPoe({ poeApiKey: "pk" })
		fireEvent.click(screen.getByText("settings:providers.refreshModels.label"))
		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "singleRouterModelFetchResponse",
					success: false,
					error: "poe down",
					values: { provider: "poe" },
				},
			}),
		)
		expect(screen.getByText("poe down")).toBeInTheDocument()
	})
})

describe("Shofer router", () => {
	it("refreshes against the typed base url without waiting for Save", () => {
		render(
			<Shofer
				apiConfiguration={{ shoferBaseUrl: "http://router:8080/v1", shoferApiKey: "t" }}
				setApiConfigurationField={setField}
				organizationAllowList={organizationAllowList}
			/>,
		)
		fireEvent.click(screen.getByText("Refresh Models"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: {
				provider: "shofer",
				refresh: true,
				shoferBaseUrl: "http://router:8080/v1",
				shoferApiKey: "t",
			},
		})
	})

	it("falls back to the default base url when none is set", () => {
		render(
			<Shofer
				apiConfiguration={{}}
				setApiConfigurationField={setField}
				organizationAllowList={organizationAllowList}
			/>,
		)
		fireEvent.click(screen.getByText("Refresh Models"))
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				values: expect.objectContaining({ shoferBaseUrl: "http://localhost:30081/v1" }),
			}),
		)
	})

	it("reports a shofer fetch failure and stages both fields", () => {
		render(
			<Shofer
				apiConfiguration={{}}
				setApiConfigurationField={setField}
				organizationAllowList={organizationAllowList}
			/>,
		)
		const fields = textInputs()
		fireEvent.change(fields[0], { target: { value: "http://x/v1" } })
		expect(setField).toHaveBeenCalledWith("shoferBaseUrl", "http://x/v1")
		fireEvent.change(fields[1], { target: { value: "tok" } })
		expect(setField).toHaveBeenCalledWith("shoferApiKey", "tok")

		fireEvent.click(screen.getByText("Refresh Models"))
		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "singleRouterModelFetchResponse",
					success: false,
					error: "unreachable",
					values: { provider: "shofer" },
				},
			}),
		)
		expect(screen.getByText("unreachable")).toBeInTheDocument()
	})
})

describe("Ollama", () => {
	it("asks the host for models on mount and stages the base url", () => {
		render(<Ollama apiConfiguration={{}} setApiConfigurationField={setField} />)
		expect(postMessage).toHaveBeenCalledWith({ type: "requestOllamaModels" })

		fireEvent.change(textInputs()[0], { target: { value: "http://localhost:11434" } })
		expect(setField).toHaveBeenCalledWith("ollamaBaseUrl", "http://localhost:11434")
	})

	it("reveals the api key field only once a base url is set", () => {
		const { rerender } = render(<Ollama apiConfiguration={{}} setApiConfigurationField={setField} />)
		const before = textInputs().length
		rerender(<Ollama apiConfiguration={{ ollamaBaseUrl: "http://x" }} setApiConfigurationField={setField} />)
		expect(textInputs().length).toBeGreaterThan(before)
	})

	it("clamps the context window and clears it on an empty value", () => {
		render(<Ollama apiConfiguration={{}} setApiConfigurationField={setField} />)
		const numCtx = textInputs()[textInputs().length - 1]

		fireEvent.change(numCtx, { target: { value: "64" } })
		expect(setField).not.toHaveBeenCalledWith("ollamaNumCtx", 64)

		fireEvent.change(numCtx, { target: { value: "4096" } })
		expect(setField).toHaveBeenCalledWith("ollamaNumCtx", 4096)
	})

	it("clears the context window when the field is emptied", () => {
		render(<Ollama apiConfiguration={{ ollamaNumCtx: 4096 }} setApiConfigurationField={setField} />)
		const fields = textInputs()
		fireEvent.change(fields[fields.length - 1], { target: { value: "" } })
		expect(setField).toHaveBeenCalledWith("ollamaNumCtx", undefined)
	})

	it("warns when the selected model is absent from the router catalog", () => {
		routerModelsQuery.data = { ollama: { "llama3:8b": {} } }
		render(<Ollama apiConfiguration={{ ollamaModelId: "missing" }} setApiConfigurationField={setField} />)
		expect(within(screen.getByTestId("model-picker-ollamaModelId")).getByText(/modelAvailability/)).toBeTruthy()
	})

	it("accepts a model the host has just announced", () => {
		render(<Ollama apiConfiguration={{ ollamaModelId: "llama3" }} setApiConfigurationField={setField} />)
		fireEvent(window, new MessageEvent("message", { data: { type: "ollamaModels", ollamaModels: { llama3: {} } } }))
		expect(screen.getByTestId("model-picker-ollamaModelId")).toBeEmptyDOMElement()
	})
})

describe("LMStudio", () => {
	it("asks the host for models on mount", () => {
		render(<LMStudio apiConfiguration={{}} setApiConfigurationField={setField} />)
		expect(postMessage).toHaveBeenCalledWith({ type: "requestLmStudioModels" })
	})

	it("reveals the draft-model picker only with speculative decoding on", () => {
		const { rerender } = render(<LMStudio apiConfiguration={{}} setApiConfigurationField={setField} />)
		expect(screen.queryByTestId("model-picker-lmStudioDraftModelId")).not.toBeInTheDocument()

		rerender(
			<LMStudio
				apiConfiguration={{ lmStudioSpeculativeDecodingEnabled: true }}
				setApiConfigurationField={setField}
			/>,
		)
		expect(screen.getByTestId("model-picker-lmStudioDraftModelId")).toBeInTheDocument()
	})

	it("stages the speculative-decoding toggle", () => {
		render(<LMStudio apiConfiguration={{}} setApiConfigurationField={setField} />)
		fireEvent.click(inputs().find((el) => el.type === "checkbox")!)
		expect(setField).toHaveBeenCalledWith("lmStudioSpeculativeDecodingEnabled", true)
	})

	it("warns about a model and a draft model missing from the catalog", () => {
		routerModelsQuery.data = { lmstudio: { known: {} } }
		render(
			<LMStudio
				apiConfiguration={{
					lmStudioModelId: "missing",
					lmStudioDraftModelId: "also-missing",
					lmStudioSpeculativeDecodingEnabled: true,
				}}
				setApiConfigurationField={setField}
			/>,
		)
		expect(screen.getByTestId("model-picker-lmStudioModelId").textContent).toContain("modelAvailability")
		expect(screen.getByTestId("model-picker-lmStudioDraftModelId").textContent).toContain("modelAvailability")
	})

	it("clears the warning once the host announces the model", () => {
		render(<LMStudio apiConfiguration={{ lmStudioModelId: "local" }} setApiConfigurationField={setField} />)
		fireEvent(
			window,
			new MessageEvent("message", { data: { type: "lmStudioModels", lmStudioModels: { local: {} } } }),
		)
		expect(screen.getByTestId("model-picker-lmStudioModelId")).toBeEmptyDOMElement()
	})
})

describe("OpenAICodex", () => {
	it("offers sign-in when unauthenticated and sign-out when authenticated", () => {
		const { rerender } = render(
			<OpenAICodex
				apiConfiguration={{}}
				setApiConfigurationField={setField}
				openAiCodexIsAuthenticated={false}
			/>,
		)
		expect(screen.queryByText("settings:providers.openAiCodex.signOutButton")).not.toBeInTheDocument()

		rerender(<OpenAICodex apiConfiguration={{}} setApiConfigurationField={setField} openAiCodexIsAuthenticated />)
		fireEvent.click(screen.getByText("settings:providers.openAiCodex.signOutButton"))
		expect(postMessage).toHaveBeenCalledWith({ type: "openAiCodexSignOut" })
	})
})
