import { isRetiredProvider, type ProviderSettings, type ModelInfo } from "@shofer/types"

import { applyCustomPricing } from "@shofer/types"

import type { ApiHandler } from "./api-handler-types.js"
import { getNativeApiHandler } from "./native-handler-registry.js"

import {
	AnthropicHandler,
	AwsBedrockHandler,
	OpenRouterHandler,
	PoeHandler,
	VertexHandler,
	AnthropicVertexHandler,
	OpenAiHandler,
	LmStudioHandler,
	GeminiHandler,
	OpenAiNativeHandler,
	DeepSeekHandler,
	MoonshotHandler,
	DashScopeHandler,
	MistralHandler,
	RequestyHandler,
	UnboundHandler,
	FakeAIHandler,
	XAIHandler,
	LiteLLMHandler,
	QwenCodeHandler,
	SambaNovaHandler,
	ZAiHandler,
	FireworksHandler,
	VercelAiGatewayHandler,
	MiniMaxHandler,
	BasetenHandler,
	MockHandler,
	ShoferHandler,
} from "./providers/index.js"
import { NativeOllamaHandler } from "./providers/native-ollama.js"

export type { ApiHandler, SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "./api-handler-types.js"

/**
 * Resolve a native (host-backed) handler factory or throw a clear headless error.
 *
 * `vscode-lm` and `openai-codex` require the VS Code extension host; their
 * factories are registered at activation via `registerNativeApiHandler`.
 */
function buildNativeApiHandler(name: string, options: ProviderSettings): ApiHandler {
	const factory = getNativeApiHandler(name)
	if (!factory) {
		throw new Error(`The "${name}" provider requires the VS Code host; it is not available headless.`)
	}
	return factory(options)
}

export function buildApiHandler(
	configuration: ProviderSettings,
	extraOptions?: { taskId?: string; parentTaskId?: string; rootTaskId?: string },
): ApiHandler {
	const { apiProvider, ...options } = configuration
	const handlerOptions = { ...options, ...extraOptions }

	if (apiProvider && isRetiredProvider(apiProvider)) {
		throw new Error(
			`Sorry, this provider is no longer supported. We saw very few Shofer users actually using it and we need to reduce the surface area of our codebase so we can keep shipping fast and serving our community well in this space. It was a really hard decision but it lets us focus on what matters most to you. It sucks, we know.\n\nPlease select a different provider in your API profile settings.`,
		)
	}

	const raw: ApiHandler = (() => {
		switch (apiProvider) {
			case "anthropic":
				return new AnthropicHandler(options)
			case "openrouter":
				return new OpenRouterHandler(options)
			case "bedrock":
				return new AwsBedrockHandler(options)
			case "vertex":
				return options.apiModelId?.startsWith("claude")
					? new AnthropicVertexHandler(options)
					: new VertexHandler(options)
			case "openai":
				return new OpenAiHandler(options)
			case "ollama":
				return new NativeOllamaHandler(options)
			case "lmstudio":
				return new LmStudioHandler(options)
			case "gemini":
				return new GeminiHandler(options)
			case "openai-codex":
				return buildNativeApiHandler("openai-codex", options)
			case "openai-native":
				return new OpenAiNativeHandler(options)
			case "deepseek":
				return new DeepSeekHandler(options)
			case "qwen-code":
				return new QwenCodeHandler(options)
			case "moonshot":
				return new MoonshotHandler(options)
			case "dashscope":
				return new DashScopeHandler(options)
			case "vscode-lm":
				return buildNativeApiHandler("vscode-lm", handlerOptions)
			case "mistral":
				return new MistralHandler(options)
			case "requesty":
				return new RequestyHandler(options)
			case "unbound":
				return new UnboundHandler(options)
			case "fake-ai":
				return new FakeAIHandler(options)
			case "xai":
				return new XAIHandler(options)
			case "litellm":
				return new LiteLLMHandler(options)
			case "sambanova":
				return new SambaNovaHandler(options)
			case "zai":
				return new ZAiHandler(options)
			case "fireworks":
				return new FireworksHandler(options)
			case "vercel-ai-gateway":
				return new VercelAiGatewayHandler(options)
			case "minimax":
				return new MiniMaxHandler(options)
			case "baseten":
				return new BasetenHandler(options)
			case "shofer":
				return new ShoferHandler(options)
			case "poe":
				return new PoeHandler(options)
			case "mock":
				return new MockHandler(options)
			default:
				return new AnthropicHandler(options)
		}
	})()

	// When customPricing is configured, wrap getModel() to merge overrides.
	const customPricing = options.customPricing
	if (customPricing) {
		const rawGetModel = raw.getModel.bind(raw)
		raw.getModel = (): { id: string; info: ModelInfo } => {
			const m = rawGetModel()
			return { id: m.id, info: applyCustomPricing(m.info, customPricing) }
		}
	}

	return raw
}
