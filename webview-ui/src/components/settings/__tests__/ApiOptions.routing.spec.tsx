// npx vitest src/components/settings/__tests__/ApiOptions.routing.spec.tsx
//
// ApiOptions routes the selected provider to its own panel. A provider added to
// the catalog without a branch here renders an empty form — visible as a
// missing panel rather than as an error — so the routing is walked provider by
// provider, with the panels stubbed so each assertion is about the ROUTE.

import { render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ProviderSettings } from "@shofer/types"

import ApiOptions from "../ApiOptions"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	Trans: ({ i18nKey }: { i18nKey?: string }) => <span>{i18nKey}</span>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		routerModels: {},
		vsCodeLmModels: [],
		organizationAllowList: { allowAll: true, providers: {} },
		uriScheme: "vscode",
		openAiCodexIsAuthenticated: false,
		customModes: [],
	}),
}))

// The routing key is `useSelectedModel(...).provider`, not the raw setting, so
// the double echoes back whatever provider the configuration names.
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: (config?: { apiProvider?: string; apiModelId?: string }) => ({
		provider: config?.apiProvider ?? "anthropic",
		id: config?.apiModelId ?? "m",
		info: undefined,
		isLoading: false,
		isError: false,
	}),
}))
vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: (config?: { apiProvider?: string; apiModelId?: string }) => ({
		provider: config?.apiProvider ?? "anthropic",
		id: config?.apiModelId ?? "m",
		info: undefined,
		isLoading: false,
		isError: false,
	}),
}))
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({ data: {}, isLoading: false, isError: false, refetch: vi.fn() }),
}))

// Every provider panel is stubbed with a marker carrying its own name, so each
// assertion is about the ROUTE rather than about the panel's own markup.
vi.mock("../providers", () => {
	const stub = (name: string) => {
		const Panel = () => <div data-testid={`panel-${name}`} />
		Panel.displayName = name
		return Panel
	}
	return {
		Anthropic: stub("Anthropic"),
		Baseten: stub("Baseten"),
		Bedrock: stub("Bedrock"),
		BedrockCustomArn: stub("BedrockCustomArn"),
		Dashscope: stub("Dashscope"),
		DeepSeek: stub("DeepSeek"),
		Fireworks: stub("Fireworks"),
		Gemini: stub("Gemini"),
		LMStudio: stub("LMStudio"),
		LiteLLM: stub("LiteLLM"),
		MiniMax: stub("MiniMax"),
		Mistral: stub("Mistral"),
		Moonshot: stub("Moonshot"),
		Ollama: stub("Ollama"),
		OpenAI: stub("OpenAI"),
		OpenAICodex: stub("OpenAICodex"),
		OpenAICompatible: stub("OpenAICompatible"),
		OpenRouter: stub("OpenRouter"),
		Poe: stub("Poe"),
		QwenCode: stub("QwenCode"),
		Requesty: stub("Requesty"),
		SambaNova: stub("SambaNova"),
		Shofer: stub("Shofer"),
		Unbound: stub("Unbound"),
		VSCodeLM: stub("VSCodeLM"),
		VercelAiGateway: stub("VercelAiGateway"),
		Vertex: stub("Vertex"),
		XAI: stub("XAI"),
		Xiaomi: stub("Xiaomi"),
		ZAi: stub("ZAi"),
	}
})

const setApiConfigurationField = vi.fn()

const renderOptions = (apiConfiguration: ProviderSettings) =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<ApiOptions
				uriScheme="vscode"
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				errorMessage={undefined}
				setErrorMessage={vi.fn()}
			/>
		</QueryClientProvider>,
	)

beforeEach(() => vi.clearAllMocks())

describe("provider routing", () => {
	it.each([
		["openrouter", "OpenRouter"],
		["requesty", "Requesty"],
		["unbound", "Unbound"],
		["anthropic", "Anthropic"],
		["openai-codex", "OpenAICodex"],
		["openai-native", "OpenAI"],
		["mistral", "Mistral"],
		["baseten", "Baseten"],
		["bedrock", "Bedrock"],
		["vertex", "Vertex"],
		["gemini", "Gemini"],
		["openai", "OpenAICompatible"],
		["lmstudio", "LMStudio"],
		["deepseek", "DeepSeek"],
		["qwen-code", "QwenCode"],
		["moonshot", "Moonshot"],
		["dashscope", "Dashscope"],
		["minimax", "MiniMax"],
		["vscode-lm", "VSCodeLM"],
		["ollama", "Ollama"],
		["xai", "XAI"],
		["litellm", "LiteLLM"],
		["shofer", "Shofer"],
		["sambanova", "SambaNova"],
		["xiaomi", "Xiaomi"],
		["zai", "ZAi"],
		["vercel-ai-gateway", "VercelAiGateway"],
		["fireworks", "Fireworks"],
		["poe", "Poe"],
	])("%s renders its own panel", (apiProvider, expectedPanel) => {
		renderOptions({ apiProvider } as ProviderSettings)
		expect(screen.getByTestId(`panel-${expectedPanel}`)).toBeInTheDocument()
	})

	it("shows the provider picker", () => {
		renderOptions({ apiProvider: "anthropic" } as ProviderSettings)
		expect(screen.getByTestId("provider-select")).toBeInTheDocument()
	})

	it("explains a retired provider instead of offering its form", () => {
		renderOptions({ apiProvider: "groq" } as ProviderSettings)
		expect(screen.getByTestId("retired-provider-message")).toBeInTheDocument()
	})

	it("does not offer the custom-ARN field for an ordinary Bedrock model", () => {
		renderOptions({ apiProvider: "bedrock" } as ProviderSettings)
		expect(screen.queryByTestId("panel-BedrockCustomArn")).not.toBeInTheDocument()
	})
})
