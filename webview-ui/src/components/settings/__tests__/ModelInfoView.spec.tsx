// npx vitest src/components/settings/__tests__/ModelInfoView.spec.tsx

import { render, screen } from "@/utils/test-utils"

import type { ModelInfo } from "@shofer/types"

import { ModelInfoView } from "../ModelInfoView"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}(${Object.values(opts)})` : key),
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

vi.mock("../ModelDescriptionMarkdown", () => ({
	ModelDescriptionMarkdown: ({ markdown }: { markdown: string }) => (
		<div data-testid="model-description">{markdown}</div>
	),
}))

const info = (over: Partial<ModelInfo> = {}): ModelInfo =>
	({ contextWindow: 200_000, supportsPromptCache: false, ...over }) as ModelInfo

const renderView = (props: Partial<React.ComponentProps<typeof ModelInfoView>> = {}) =>
	render(
		<ModelInfoView
			selectedModelId="a-model"
			modelInfo={info()}
			isDescriptionExpanded={false}
			setIsDescriptionExpanded={vi.fn()}
			{...props}
		/>,
	)

describe("ModelInfoView", () => {
	it("renders the description only when the model has one", () => {
		renderView()
		expect(screen.queryByTestId("model-description")).not.toBeInTheDocument()

		renderView({ modelInfo: info({ description: "a good model" }) })
		expect(screen.getByTestId("model-description")).toHaveTextContent("a good model")
	})

	it("reports the context window and max output, with thousands separators", () => {
		renderView({ modelInfo: info({ contextWindow: 200_000, maxTokens: 8_192 }) })
		expect(screen.getByText(/200,000 tokens/)).toBeInTheDocument()
		expect(screen.getByText(/8,192 tokens/)).toBeInTheDocument()
	})

	it("omits a zero or absent context window and max output", () => {
		renderView({ modelInfo: info({ contextWindow: 0, maxTokens: 0 }) })
		expect(screen.queryByText(/tokens/)).not.toBeInTheDocument()
	})

	it("states image and prompt-cache support either way", () => {
		renderView({ modelInfo: info({ supportsImages: true, supportsPromptCache: true }) })
		expect(screen.getByText("settings:modelInfo.supportsImages")).toBeInTheDocument()
		expect(screen.getByText("settings:modelInfo.supportsPromptCache")).toBeInTheDocument()

		renderView({ modelInfo: info({ supportsImages: false, supportsPromptCache: false }) })
		expect(screen.getByText("settings:modelInfo.noImages")).toBeInTheDocument()
		expect(screen.getByText("settings:modelInfo.noPromptCache")).toBeInTheDocument()
	})

	it("prices input and output per million tokens", () => {
		renderView({ modelInfo: info({ inputPrice: 3, outputPrice: 15 }) })
		expect(screen.getByText(/\$3\.00 \/ 1M tokens/)).toBeInTheDocument()
		expect(screen.getByText(/\$15\.00 \/ 1M tokens/)).toBeInTheDocument()
	})

	it("prices the cache only for a model that supports it", () => {
		renderView({ modelInfo: info({ supportsPromptCache: false, cacheReadsPrice: 1, cacheWritesPrice: 2 }) })
		expect(screen.queryByText("settings:modelInfo.cacheReadsPrice:")).not.toBeInTheDocument()

		renderView({ modelInfo: info({ supportsPromptCache: true, cacheReadsPrice: 1, cacheWritesPrice: 2 }) })
		expect(screen.getByText("settings:modelInfo.cacheReadsPrice:")).toBeInTheDocument()
		expect(screen.getByText("settings:modelInfo.cacheWritesPrice:")).toBeInTheDocument()
	})

	it("hides every price when the caller asks it to", () => {
		renderView({ modelInfo: info({ inputPrice: 3, outputPrice: 15 }), hidePricing: true })
		expect(screen.queryByText(/1M tokens/)).not.toBeInTheDocument()
	})

	it("explains Gemini's free tier, and its billing estimate for a preview model", () => {
		renderView({ apiProvider: "gemini", selectedModelId: "gemini-2.5-flash" })
		expect(screen.getByText(/settings:modelInfo.gemini.freeRequests\(15\)/)).toBeInTheDocument()

		renderView({ apiProvider: "gemini", selectedModelId: "gemini-2.5-something" })
		expect(screen.getByText(/settings:modelInfo.gemini.freeRequests\(2\)/)).toBeInTheDocument()

		renderView({ apiProvider: "gemini", selectedModelId: "gemini-2.5-pro-preview" })
		expect(screen.getByText(/settings:modelInfo.gemini.billingEstimate/)).toBeInTheDocument()
	})

	it("replaces the flat prices with a tier table for an OpenAI model offering tiers", () => {
		renderView({
			apiProvider: "openai-native",
			modelInfo: info({
				inputPrice: 3,
				outputPrice: 15,
				tiers: [
					{ name: "flex", contextWindow: 1, inputPrice: 1, outputPrice: 2 },
					{ name: "priority", contextWindow: 1, inputPrice: 5, outputPrice: 6 },
				] as never,
			}),
		})

		expect(screen.getByText("settings:serviceTier.pricingTableTitle")).toBeInTheDocument()
		expect(screen.queryByText(/\$3\.00 \/ 1M tokens/)).not.toBeInTheDocument()
	})

	it("keeps the flat prices for a tierless OpenAI model", () => {
		renderView({
			apiProvider: "openai-native",
			modelInfo: info({ inputPrice: 3, outputPrice: 15 }),
		})
		expect(screen.queryByText("settings:serviceTier.pricingTableTitle")).not.toBeInTheDocument()
		expect(screen.getByText(/\$3\.00 \/ 1M tokens/)).toBeInTheDocument()
	})

	it("suppresses the tier table too when pricing is hidden", () => {
		renderView({
			apiProvider: "openai-native",
			hidePricing: true,
			modelInfo: info({ tiers: [{ name: "flex", contextWindow: 1 }] as never }),
		})
		expect(screen.queryByText("settings:serviceTier.pricingTableTitle")).not.toBeInTheDocument()
	})

	it("renders with no model info at all", () => {
		renderView({ modelInfo: undefined })
		expect(screen.getByText("settings:modelInfo.noImages")).toBeInTheDocument()
	})
})
