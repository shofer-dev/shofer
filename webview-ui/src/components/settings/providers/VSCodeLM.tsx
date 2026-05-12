import { useCallback, useMemo } from "react"

import type { ProviderSettings, ModelInfo, VsCodeLmChatInfo } from "@shofer/shared/types"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"

import { ModelPicker } from "../ModelPicker"

type VSCodeLMProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const VSCodeLM = ({ apiConfiguration, setApiConfigurationField }: VSCodeLMProps) => {
	const { t } = useAppTranslation()
	const { vsCodeLmModels } = useExtensionState()

	// Convert VSCode LM models array to Record format for ModelPicker.
	// contextWindow is derived from maxInputTokens — the value set by the
	// provider extension (llm-provider → llm-router → model_registry.go).
	const modelsRecord = useMemo((): Record<string, ModelInfo> => {
		return vsCodeLmModels.reduce(
			(acc, model: VsCodeLmChatInfo) => {
				if (!model.vendor || !model.family) {
					return acc
				}
				const modelId = `${model.vendor}/${model.family}`
				const maxInputTokens = model.maxInputTokens ?? 0
				acc[modelId] = {
					maxTokens: 0,
					contextWindow: Math.max(0, maxInputTokens),
					supportsPromptCache: false,
					description: `${model.vendor} - ${model.family}`,
				}
				return acc
			},
			{} as Record<string, ModelInfo>,
		)
	}, [vsCodeLmModels])

	// Transform string model ID to { vendor, family } object for storage
	const valueTransform = useCallback((modelId: string) => {
		const [vendor, family] = modelId.split("/")
		return { vendor, family }
	}, [])

	// Transform stored { vendor, family } object back to display string
	const displayTransform = useCallback((value: unknown) => {
		if (!value) return ""
		const selector = value as { vendor?: string; family?: string }
		return selector.vendor && selector.family ? `${selector.vendor}/${selector.family}` : ""
	}, [])

	return (
		<>
			{vsCodeLmModels.length > 0 ? (
				<ModelPicker
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={setApiConfigurationField}
					defaultModelId=""
					models={modelsRecord}
					modelIdKey="vsCodeLmModelSelector"
					serviceName="VS Code LM"
					serviceUrl="https://code.visualstudio.com/api/extension-guides/language-model"
					valueTransform={valueTransform}
					displayTransform={displayTransform}
					hidePricing
				/>
			) : (
				<div>
					<label className="block font-medium mb-1">{t("settings:providers.vscodeLmModel")}</label>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.vscodeLmDescription")}
					</div>
				</div>
			)}
			<div className="text-sm text-vscode-errorForeground">{t("settings:providers.vscodeLmWarning")}</div>
		</>
	)
}
