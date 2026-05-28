import React, { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react"
import { VSCodeTextField, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"

import {
	type EmbedderProvider,
	CODEBASE_INDEX_DEFAULTS,
	CODEBASE_INDEX_FILE_EXTENSIONS,
	CODEBASE_INDEX_IGNORED_DIRS,
} from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { cn } from "@src/lib/utils"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Slider,
	StandardTooltip,
} from "@src/components/ui"
import {
	useOpenRouterModelProviders,
	OPENROUTER_DEFAULT_PROVIDER_NAME,
} from "@src/components/ui/hooks/useOpenRouterModelProviders"

/**
 * Configuration form for the code-index ("RAG Indexer") embedder setup.
 *
 * Syncs non-secret config fields to the parent SettingsView's cachedState so
 * they are batch-persisted through the top-level Save button (Settings View
 * Pattern). Secret fields (API keys) are held locally and flushed via the
 * imperative `saveSecrets()` handle that SettingsView calls during its Save.
 *
 * This component used to have its own Save button; now participates in the
 * unified SettingsView save flow to avoid duplicate Save buttons.
 */

const DEFAULT_QDRANT_URL = "http://localhost:6333"
const DEFAULT_OLLAMA_URL = "http://localhost:11434"
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text"
const SECRET_PLACEHOLDER = "••••••••••••••••"

interface LocalCodeIndexSettings {
	codebaseIndexEnabled: boolean
	codebaseIndexQdrantUrl: string
	codebaseIndexEmbedderProvider: EmbedderProvider
	codebaseIndexEmbedderBaseUrl?: string
	codebaseIndexEmbedderModelId: string
	codebaseIndexEmbedderModelDimension?: number
	codebaseIndexSearchMaxResults?: number
	codebaseIndexSearchMinScore?: number

	codebaseIndexBedrockRegion?: string
	codebaseIndexBedrockProfile?: string

	codeIndexOpenAiKey?: string
	codeIndexQdrantApiKey?: string
	codebaseIndexOpenAiCompatibleBaseUrl?: string
	codebaseIndexOpenAiCompatibleApiKey?: string
	codebaseIndexGeminiApiKey?: string
	codebaseIndexMistralApiKey?: string
	codebaseIndexVercelAiGatewayApiKey?: string
	codebaseIndexOpenRouterApiKey?: string
	codebaseIndexOpenRouterSpecificProvider?: string
}

export interface CodeIndexConfigFormRef {
	saveSecrets: () => void
}

interface CodeIndexConfigFormProps {
	setCachedStateField: (key: string, value: any) => void
}

export const CodeIndexConfigForm = forwardRef<CodeIndexConfigFormRef, CodeIndexConfigFormProps>(
	({ setCachedStateField }, ref) => {
		const { t } = useAppTranslation()
		const { codebaseIndexConfig, codebaseIndexModels, apiConfiguration } = useExtensionState()

		const getDefaultSettings = (): LocalCodeIndexSettings => ({
			codebaseIndexEnabled: true,
			codebaseIndexQdrantUrl: "",
			codebaseIndexEmbedderProvider: "openai",
			codebaseIndexEmbedderBaseUrl: "",
			codebaseIndexEmbedderModelId: "",
			codebaseIndexEmbedderModelDimension: undefined,
			codebaseIndexSearchMaxResults: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
			codebaseIndexSearchMinScore: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
			codebaseIndexBedrockRegion: "",
			codebaseIndexBedrockProfile: "",
			codeIndexOpenAiKey: "",
			codeIndexQdrantApiKey: "",
			codebaseIndexOpenAiCompatibleBaseUrl: "",
			codebaseIndexOpenAiCompatibleApiKey: "",
			codebaseIndexGeminiApiKey: "",
			codebaseIndexMistralApiKey: "",
			codebaseIndexVercelAiGatewayApiKey: "",
			codebaseIndexOpenRouterApiKey: "",
			codebaseIndexOpenRouterSpecificProvider: "",
		})

		const [currentSettings, setCurrentSettings] = useState<LocalCodeIndexSettings>(getDefaultSettings())
		const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
		const [formErrors, setFormErrors] = useState<Record<string, string>>({})

		// Hydrate local state from the persisted nested codebaseIndexConfig.
		useEffect(() => {
			if (codebaseIndexConfig) {
				const settings: LocalCodeIndexSettings = {
					codebaseIndexEnabled: codebaseIndexConfig.codebaseIndexEnabled ?? true,
					codebaseIndexQdrantUrl: codebaseIndexConfig.codebaseIndexQdrantUrl || "",
					codebaseIndexEmbedderProvider: codebaseIndexConfig.codebaseIndexEmbedderProvider || "openai",
					codebaseIndexEmbedderBaseUrl: codebaseIndexConfig.codebaseIndexEmbedderBaseUrl || "",
					codebaseIndexEmbedderModelId: codebaseIndexConfig.codebaseIndexEmbedderModelId || "",
					codebaseIndexEmbedderModelDimension:
						codebaseIndexConfig.codebaseIndexEmbedderModelDimension || undefined,
					codebaseIndexSearchMaxResults:
						codebaseIndexConfig.codebaseIndexSearchMaxResults ??
						CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
					codebaseIndexSearchMinScore:
						codebaseIndexConfig.codebaseIndexSearchMinScore ??
						CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
					codebaseIndexBedrockRegion: codebaseIndexConfig.codebaseIndexBedrockRegion || "",
					codebaseIndexBedrockProfile: codebaseIndexConfig.codebaseIndexBedrockProfile || "",
					codeIndexOpenAiKey: "",
					codeIndexQdrantApiKey: "",
					codebaseIndexOpenAiCompatibleBaseUrl:
						codebaseIndexConfig.codebaseIndexOpenAiCompatibleBaseUrl || "",
					codebaseIndexOpenAiCompatibleApiKey: "",
					codebaseIndexGeminiApiKey: "",
					codebaseIndexMistralApiKey: "",
					codebaseIndexVercelAiGatewayApiKey: "",
					codebaseIndexOpenRouterApiKey: "",
					codebaseIndexOpenRouterSpecificProvider:
						codebaseIndexConfig.codebaseIndexOpenRouterSpecificProvider || "",
				}
				setCurrentSettings(settings)
				vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
			}
		}, [codebaseIndexConfig])

		// Capture latest settings for the message-listener closure (otherwise the
		// effect would have to re-subscribe on every keystroke).
		const currentSettingsRef = useRef(currentSettings)
		currentSettingsRef.current = currentSettings

		/**
		 * Sync non-secret config fields to the parent SettingsView's cachedState
		 * so they are included in the top-level Save batch. Secret fields are
		 * excluded — they are saved separately via saveSecrets().
		 */
		const syncToCachedState = useCallback(
			(settings: LocalCodeIndexSettings) => {
				// Build a config object of only the non-secret codebaseIndexConfig fields.
				// Keys are taken from the persisted shape; secrets are handled separately.
				setCachedStateField("codebaseIndexConfig", {
					...(codebaseIndexConfig || {}),
					codebaseIndexEnabled: settings.codebaseIndexEnabled ?? true,
					codebaseIndexQdrantUrl: settings.codebaseIndexQdrantUrl,
					codebaseIndexEmbedderProvider: settings.codebaseIndexEmbedderProvider,
					codebaseIndexEmbedderBaseUrl: settings.codebaseIndexEmbedderBaseUrl,
					codebaseIndexEmbedderModelId: settings.codebaseIndexEmbedderModelId,
					codebaseIndexEmbedderModelDimension: settings.codebaseIndexEmbedderModelDimension,
					codebaseIndexSearchMaxResults: settings.codebaseIndexSearchMaxResults,
					codebaseIndexSearchMinScore: settings.codebaseIndexSearchMinScore,
					codebaseIndexBedrockRegion: settings.codebaseIndexBedrockRegion,
					codebaseIndexBedrockProfile: settings.codebaseIndexBedrockProfile,
					codebaseIndexOpenAiCompatibleBaseUrl: settings.codebaseIndexOpenAiCompatibleBaseUrl,
					codebaseIndexOpenRouterSpecificProvider: settings.codebaseIndexOpenRouterSpecificProvider,
				})
			},
			[setCachedStateField, codebaseIndexConfig],
		)

		/**
		 * Imperative handle called by SettingsView during its top-level Save.
		 * Sends only the secret fields to the host via the atomic save path.
		 */
		useImperativeHandle(
			ref,
			() => ({
				saveSecrets: () => {
					const settings = currentSettingsRef.current
					const secretFields: Record<string, any> = {}

					const secretKeys = [
						"codeIndexOpenAiKey",
						"codeIndexQdrantApiKey",
						"codebaseIndexOpenAiCompatibleApiKey",
						"codebaseIndexGeminiApiKey",
						"codebaseIndexMistralApiKey",
						"codebaseIndexVercelAiGatewayApiKey",
						"codebaseIndexOpenRouterApiKey",
					] as const

					for (const key of secretKeys) {
						const value: unknown = settings[key]
						if (value && value !== SECRET_PLACEHOLDER) {
							secretFields[key] = value
						}
					}

					// Always include the enabled flag so the host can trigger indexing
					// start/stop regardless of whether there are API-key secrets to save.
					secretFields["codebaseIndexEnabled"] = settings.codebaseIndexEnabled

					// Always send — providers like Ollama have no API keys, so the
					// secrets list may be empty, but the host still needs the signal to
					// kick off auto-indexing after Save.
					vscode.postMessage({ type: "saveCodeIndexSettingsAtomic", codeIndexSettings: secretFields } as any)
				},
			}),
			[],
		)

		useEffect(() => {
			const handleMessage = (event: MessageEvent<any>) => {
				if (event.data.type === "codeIndexSettingsSaved") {
					if (event.data.success) {
						setSaveStatus("saved")
						const savedSettings = { ...currentSettingsRef.current }
						setCurrentSettings(savedSettings)
						vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
						setSaveStatus("idle")
					} else {
						setSaveStatus("error")
						console.error(event.data.error || t("settings:codeIndex.saveError"))
						setSaveStatus("idle")
					}
				}
			}
			window.addEventListener("message", handleMessage)
			return () => window.removeEventListener("message", handleMessage)
		}, [t])

		useEffect(() => {
			const handleMessage = (event: MessageEvent) => {
				if (event.data.type === "codeIndexSecretStatus") {
					const secretStatus = event.data.values

					const updateWithSecrets = (prev: LocalCodeIndexSettings): LocalCodeIndexSettings => {
						const updated = { ...prev }

						// Only mask when the field is empty or already masked, so
						// in-progress edits aren't overwritten by a late status reply.
						if (!prev.codeIndexOpenAiKey || prev.codeIndexOpenAiKey === SECRET_PLACEHOLDER) {
							updated.codeIndexOpenAiKey = secretStatus.hasOpenAiKey ? SECRET_PLACEHOLDER : ""
						}
						if (!prev.codeIndexQdrantApiKey || prev.codeIndexQdrantApiKey === SECRET_PLACEHOLDER) {
							updated.codeIndexQdrantApiKey = secretStatus.hasQdrantApiKey ? SECRET_PLACEHOLDER : ""
						}
						if (
							!prev.codebaseIndexOpenAiCompatibleApiKey ||
							prev.codebaseIndexOpenAiCompatibleApiKey === SECRET_PLACEHOLDER
						) {
							updated.codebaseIndexOpenAiCompatibleApiKey = secretStatus.hasOpenAiCompatibleApiKey
								? SECRET_PLACEHOLDER
								: ""
						}
						if (!prev.codebaseIndexGeminiApiKey || prev.codebaseIndexGeminiApiKey === SECRET_PLACEHOLDER) {
							updated.codebaseIndexGeminiApiKey = secretStatus.hasGeminiApiKey ? SECRET_PLACEHOLDER : ""
						}
						if (
							!prev.codebaseIndexMistralApiKey ||
							prev.codebaseIndexMistralApiKey === SECRET_PLACEHOLDER
						) {
							updated.codebaseIndexMistralApiKey = secretStatus.hasMistralApiKey ? SECRET_PLACEHOLDER : ""
						}
						if (
							!prev.codebaseIndexVercelAiGatewayApiKey ||
							prev.codebaseIndexVercelAiGatewayApiKey === SECRET_PLACEHOLDER
						) {
							updated.codebaseIndexVercelAiGatewayApiKey = secretStatus.hasVercelAiGatewayApiKey
								? SECRET_PLACEHOLDER
								: ""
						}
						if (
							!prev.codebaseIndexOpenRouterApiKey ||
							prev.codebaseIndexOpenRouterApiKey === SECRET_PLACEHOLDER
						) {
							updated.codebaseIndexOpenRouterApiKey = secretStatus.hasOpenRouterApiKey
								? SECRET_PLACEHOLDER
								: ""
						}
						return updated
					}

					if (saveStatus === "idle" || saveStatus === "saved") {
						setCurrentSettings(updateWithSecrets)
					}
				}
			}
			window.addEventListener("message", handleMessage)
			return () => window.removeEventListener("message", handleMessage)
		}, [saveStatus])

		const updateSetting = (key: keyof LocalCodeIndexSettings, value: any) => {
			setCurrentSettings((prev) => {
				const next = { ...prev, [key]: value }
				// Sync non-secret fields to cachedState so SettingsView's Save picks them up
				syncToCachedState(next)
				return next
			})
			if (formErrors[key]) {
				setFormErrors((prev) => {
					const next = { ...prev }
					delete next[key]
					return next
				})
			}
		}

		const getAvailableModels = () => {
			if (!codebaseIndexModels) return []
			const models =
				codebaseIndexModels[currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels]
			return models ? Object.keys(models) : []
		}

		const { data: openRouterEmbeddingProviders } = useOpenRouterModelProviders(
			currentSettings.codebaseIndexEmbedderProvider === "openrouter"
				? currentSettings.codebaseIndexEmbedderModelId
				: undefined,
			undefined,
			{
				enabled:
					currentSettings.codebaseIndexEmbedderProvider === "openrouter" &&
					!!currentSettings.codebaseIndexEmbedderModelId,
			},
		)

		return (
			<div className="space-y-6">
				{/* Setup */}
				<div className="space-y-4">
					<h3 className="text-base font-semibold">{t("settings:codeIndex.setupConfigLabel")}</h3>

					{/* Embedder Provider */}
					<div className="space-y-2">
						<label className="text-sm font-medium">{t("settings:codeIndex.embedderProviderLabel")}</label>
						<Select
							value={currentSettings.codebaseIndexEmbedderProvider}
							onValueChange={(value: EmbedderProvider) => {
								updateSetting("codebaseIndexEmbedderProvider", value)
								updateSetting(
									"codebaseIndexEmbedderModelId",
									value === "ollama" ? DEFAULT_OLLAMA_EMBEDDING_MODEL : "",
								)
								if (value === "bedrock" && apiConfiguration?.apiProvider === "bedrock") {
									if (!currentSettings.codebaseIndexBedrockRegion && apiConfiguration.awsRegion) {
										updateSetting("codebaseIndexBedrockRegion", apiConfiguration.awsRegion)
									}
									if (!currentSettings.codebaseIndexBedrockProfile && apiConfiguration.awsProfile) {
										updateSetting("codebaseIndexBedrockProfile", apiConfiguration.awsProfile)
									}
								}
							}}>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="openai">{t("settings:codeIndex.openaiProvider")}</SelectItem>
								<SelectItem value="ollama">{t("settings:codeIndex.ollamaProvider")}</SelectItem>
								<SelectItem value="openai-compatible">
									{t("settings:codeIndex.openaiCompatibleProvider")}
								</SelectItem>
								<SelectItem value="gemini">{t("settings:codeIndex.geminiProvider")}</SelectItem>
								<SelectItem value="mistral">{t("settings:codeIndex.mistralProvider")}</SelectItem>
								<SelectItem value="vercel-ai-gateway">
									{t("settings:codeIndex.vercelAiGatewayProvider")}
								</SelectItem>
								<SelectItem value="bedrock">{t("settings:codeIndex.bedrockProvider")}</SelectItem>
								<SelectItem value="openrouter">{t("settings:codeIndex.openRouterProvider")}</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{currentSettings.codebaseIndexEmbedderProvider === "openai" && (
						<>
							<div className="space-y-2">
								<label className="text-sm font-medium">{t("settings:codeIndex.openAiKeyLabel")}</label>
								<VSCodeTextField
									type="password"
									value={currentSettings.codeIndexOpenAiKey || ""}
									onInput={(e: any) => updateSetting("codeIndexOpenAiKey", e.target.value)}
									placeholder={t("settings:codeIndex.openAiKeyPlaceholder")}
									className={cn("w-full", { "border-red-500": formErrors.codeIndexOpenAiKey })}
								/>
								{formErrors.codeIndexOpenAiKey && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codeIndexOpenAiKey}
									</p>
								)}
							</div>
							<ModelDropdown
								value={currentSettings.codebaseIndexEmbedderModelId}
								error={formErrors.codebaseIndexEmbedderModelId}
								models={getAvailableModels()}
								modelInfo={
									codebaseIndexModels?.[
										currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
									]
								}
								onChange={(v) => updateSetting("codebaseIndexEmbedderModelId", v)}
								t={t}
							/>
						</>
					)}

					{currentSettings.codebaseIndexEmbedderProvider === "ollama" && (
						<>
							<div className="space-y-2">
								<label className="text-sm font-medium">
									{t("settings:codeIndex.ollamaBaseUrlLabel")}
								</label>
								<VSCodeTextField
									value={currentSettings.codebaseIndexEmbedderBaseUrl || ""}
									onInput={(e: any) => updateSetting("codebaseIndexEmbedderBaseUrl", e.target.value)}
									onBlur={(e: any) => {
										if (!e.target.value.trim()) {
											e.target.value = DEFAULT_OLLAMA_URL
											updateSetting("codebaseIndexEmbedderBaseUrl", DEFAULT_OLLAMA_URL)
										}
									}}
									placeholder={t("settings:codeIndex.ollamaUrlPlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexEmbedderBaseUrl,
									})}
								/>
								{formErrors.codebaseIndexEmbedderBaseUrl && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexEmbedderBaseUrl}
									</p>
								)}
							</div>
							<div className="space-y-2">
								<label className="text-sm font-medium">{t("settings:codeIndex.modelLabel")}</label>
								<VSCodeTextField
									value={currentSettings.codebaseIndexEmbedderModelId || ""}
									onInput={(e: any) => updateSetting("codebaseIndexEmbedderModelId", e.target.value)}
									placeholder={t("settings:codeIndex.modelPlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexEmbedderModelId,
									})}
								/>
								{formErrors.codebaseIndexEmbedderModelId && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexEmbedderModelId}
									</p>
								)}
							</div>
							<DimensionField
								value={currentSettings.codebaseIndexEmbedderModelDimension}
								error={formErrors.codebaseIndexEmbedderModelDimension}
								onChange={(v) => updateSetting("codebaseIndexEmbedderModelDimension", v)}
								t={t}
							/>
						</>
					)}

					{currentSettings.codebaseIndexEmbedderProvider === "openai-compatible" && (
						<>
							<div className="space-y-2">
								<label className="text-sm font-medium">
									{t("settings:codeIndex.openAiCompatibleBaseUrlLabel")}
								</label>
								<VSCodeTextField
									value={currentSettings.codebaseIndexOpenAiCompatibleBaseUrl || ""}
									onInput={(e: any) =>
										updateSetting("codebaseIndexOpenAiCompatibleBaseUrl", e.target.value)
									}
									placeholder={t("settings:codeIndex.openAiCompatibleBaseUrlPlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexOpenAiCompatibleBaseUrl,
									})}
								/>
								{formErrors.codebaseIndexOpenAiCompatibleBaseUrl && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexOpenAiCompatibleBaseUrl}
									</p>
								)}
							</div>
							<div className="space-y-2">
								<label className="text-sm font-medium">
									{t("settings:codeIndex.openAiCompatibleApiKeyLabel")}
								</label>
								<VSCodeTextField
									type="password"
									value={currentSettings.codebaseIndexOpenAiCompatibleApiKey || ""}
									onInput={(e: any) =>
										updateSetting("codebaseIndexOpenAiCompatibleApiKey", e.target.value)
									}
									placeholder={t("settings:codeIndex.openAiCompatibleApiKeyPlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexOpenAiCompatibleApiKey,
									})}
								/>
								{formErrors.codebaseIndexOpenAiCompatibleApiKey && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexOpenAiCompatibleApiKey}
									</p>
								)}
							</div>
							<div className="space-y-2">
								<label className="text-sm font-medium">{t("settings:codeIndex.modelLabel")}</label>
								<VSCodeTextField
									value={currentSettings.codebaseIndexEmbedderModelId || ""}
									onInput={(e: any) => updateSetting("codebaseIndexEmbedderModelId", e.target.value)}
									placeholder={t("settings:codeIndex.modelPlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexEmbedderModelId,
									})}
								/>
								{formErrors.codebaseIndexEmbedderModelId && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexEmbedderModelId}
									</p>
								)}
							</div>
							<DimensionField
								value={currentSettings.codebaseIndexEmbedderModelDimension}
								error={formErrors.codebaseIndexEmbedderModelDimension}
								onChange={(v) => updateSetting("codebaseIndexEmbedderModelDimension", v)}
								t={t}
							/>
						</>
					)}

					{currentSettings.codebaseIndexEmbedderProvider === "gemini" && (
						<>
							<div className="space-y-2">
								<label className="text-sm font-medium">
									{t("settings:codeIndex.geminiApiKeyLabel")}
								</label>
								<VSCodeTextField
									type="password"
									value={currentSettings.codebaseIndexGeminiApiKey || ""}
									onInput={(e: any) => updateSetting("codebaseIndexGeminiApiKey", e.target.value)}
									placeholder={t("settings:codeIndex.geminiApiKeyPlaceholder")}
									className={cn("w-full", { "border-red-500": formErrors.codebaseIndexGeminiApiKey })}
								/>
								{formErrors.codebaseIndexGeminiApiKey && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexGeminiApiKey}
									</p>
								)}
							</div>
							<ModelDropdown
								value={currentSettings.codebaseIndexEmbedderModelId}
								error={formErrors.codebaseIndexEmbedderModelId}
								models={getAvailableModels()}
								modelInfo={
									codebaseIndexModels?.[
										currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
									]
								}
								onChange={(v) => updateSetting("codebaseIndexEmbedderModelId", v)}
								t={t}
							/>
						</>
					)}

					{currentSettings.codebaseIndexEmbedderProvider === "mistral" && (
						<>
							<div className="space-y-2">
								<label className="text-sm font-medium">
									{t("settings:codeIndex.mistralApiKeyLabel")}
								</label>
								<VSCodeTextField
									type="password"
									value={currentSettings.codebaseIndexMistralApiKey || ""}
									onInput={(e: any) => updateSetting("codebaseIndexMistralApiKey", e.target.value)}
									placeholder={t("settings:codeIndex.mistralApiKeyPlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexMistralApiKey,
									})}
								/>
								{formErrors.codebaseIndexMistralApiKey && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexMistralApiKey}
									</p>
								)}
							</div>
							<ModelDropdown
								value={currentSettings.codebaseIndexEmbedderModelId}
								error={formErrors.codebaseIndexEmbedderModelId}
								models={getAvailableModels()}
								modelInfo={
									codebaseIndexModels?.[
										currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
									]
								}
								onChange={(v) => updateSetting("codebaseIndexEmbedderModelId", v)}
								t={t}
							/>
						</>
					)}

					{currentSettings.codebaseIndexEmbedderProvider === "vercel-ai-gateway" && (
						<>
							<div className="space-y-2">
								<label className="text-sm font-medium">
									{t("settings:codeIndex.vercelAiGatewayApiKeyLabel")}
								</label>
								<VSCodeTextField
									type="password"
									value={currentSettings.codebaseIndexVercelAiGatewayApiKey || ""}
									onInput={(e: any) =>
										updateSetting("codebaseIndexVercelAiGatewayApiKey", e.target.value)
									}
									placeholder={t("settings:codeIndex.vercelAiGatewayApiKeyPlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexVercelAiGatewayApiKey,
									})}
								/>
								{formErrors.codebaseIndexVercelAiGatewayApiKey && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexVercelAiGatewayApiKey}
									</p>
								)}
							</div>
							<ModelDropdown
								value={currentSettings.codebaseIndexEmbedderModelId}
								error={formErrors.codebaseIndexEmbedderModelId}
								models={getAvailableModels()}
								modelInfo={
									codebaseIndexModels?.[
										currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
									]
								}
								onChange={(v) => updateSetting("codebaseIndexEmbedderModelId", v)}
								t={t}
							/>
						</>
					)}

					{currentSettings.codebaseIndexEmbedderProvider === "bedrock" && (
						<>
							<div className="space-y-2">
								<label className="text-sm font-medium">
									{t("settings:codeIndex.bedrockRegionLabel")}
								</label>
								<VSCodeTextField
									value={currentSettings.codebaseIndexBedrockRegion || ""}
									onInput={(e: any) => updateSetting("codebaseIndexBedrockRegion", e.target.value)}
									placeholder={t("settings:codeIndex.bedrockRegionPlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexBedrockRegion,
									})}
								/>
								{formErrors.codebaseIndexBedrockRegion && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexBedrockRegion}
									</p>
								)}
							</div>
							<div className="space-y-2">
								<label className="text-sm font-medium">
									{t("settings:codeIndex.bedrockProfileLabel")}
									<span className="text-xs text-vscode-descriptionForeground ml-1">
										({t("settings:codeIndex.optional")})
									</span>
								</label>
								<VSCodeTextField
									value={currentSettings.codebaseIndexBedrockProfile || ""}
									onInput={(e: any) => updateSetting("codebaseIndexBedrockProfile", e.target.value)}
									placeholder={t("settings:codeIndex.bedrockProfilePlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexBedrockProfile,
									})}
								/>
								{formErrors.codebaseIndexBedrockProfile && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexBedrockProfile}
									</p>
								)}
								{!formErrors.codebaseIndexBedrockProfile && (
									<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
										{t("settings:codeIndex.bedrockProfileDescription")}
									</p>
								)}
							</div>
							<ModelDropdown
								value={currentSettings.codebaseIndexEmbedderModelId}
								error={formErrors.codebaseIndexEmbedderModelId}
								models={getAvailableModels()}
								modelInfo={
									codebaseIndexModels?.[
										currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
									]
								}
								onChange={(v) => updateSetting("codebaseIndexEmbedderModelId", v)}
								t={t}
							/>
						</>
					)}

					{currentSettings.codebaseIndexEmbedderProvider === "openrouter" && (
						<>
							<div className="space-y-2">
								<label className="text-sm font-medium">
									{t("settings:codeIndex.openRouterApiKeyLabel")}
								</label>
								<VSCodeTextField
									type="password"
									value={currentSettings.codebaseIndexOpenRouterApiKey || ""}
									onInput={(e: any) => updateSetting("codebaseIndexOpenRouterApiKey", e.target.value)}
									placeholder={t("settings:codeIndex.openRouterApiKeyPlaceholder")}
									className={cn("w-full", {
										"border-red-500": formErrors.codebaseIndexOpenRouterApiKey,
									})}
								/>
								{formErrors.codebaseIndexOpenRouterApiKey && (
									<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
										{formErrors.codebaseIndexOpenRouterApiKey}
									</p>
								)}
							</div>
							<ModelDropdown
								value={currentSettings.codebaseIndexEmbedderModelId}
								error={formErrors.codebaseIndexEmbedderModelId}
								models={getAvailableModels()}
								modelInfo={
									codebaseIndexModels?.[
										currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
									]
								}
								onChange={(v) => updateSetting("codebaseIndexEmbedderModelId", v)}
								t={t}
							/>
							{openRouterEmbeddingProviders && Object.keys(openRouterEmbeddingProviders).length > 0 && (
								<div className="space-y-2">
									<label className="text-sm font-medium">
										<a
											href="https://openrouter.ai/docs/features/provider-routing"
											target="_blank"
											rel="noopener noreferrer"
											className="flex items-center gap-1 hover:underline">
											{t("settings:codeIndex.openRouterProviderRoutingLabel")}
											<span className="codicon codicon-link-external text-xs" />
										</a>
									</label>
									<Select
										value={
											currentSettings.codebaseIndexOpenRouterSpecificProvider ||
											OPENROUTER_DEFAULT_PROVIDER_NAME
										}
										onValueChange={(value) =>
											updateSetting("codebaseIndexOpenRouterSpecificProvider", value)
										}>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={OPENROUTER_DEFAULT_PROVIDER_NAME}>
												{OPENROUTER_DEFAULT_PROVIDER_NAME}
											</SelectItem>
											{Object.entries(openRouterEmbeddingProviders).map(([value, { label }]) => (
												<SelectItem key={value} value={value}>
													{label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
										{t("settings:codeIndex.openRouterProviderRoutingDescription")}
									</p>
								</div>
							)}
						</>
					)}

					{/* Qdrant */}
					<div className="space-y-2">
						<label className="text-sm font-medium">{t("settings:codeIndex.qdrantUrlLabel")}</label>
						<VSCodeTextField
							value={currentSettings.codebaseIndexQdrantUrl || ""}
							onInput={(e: any) => updateSetting("codebaseIndexQdrantUrl", e.target.value)}
							onBlur={(e: any) => {
								if (!e.target.value.trim()) {
									updateSetting("codebaseIndexQdrantUrl", DEFAULT_QDRANT_URL)
								}
							}}
							placeholder={t("settings:codeIndex.qdrantUrlPlaceholder")}
							className={cn("w-full", { "border-red-500": formErrors.codebaseIndexQdrantUrl })}
						/>
						{formErrors.codebaseIndexQdrantUrl && (
							<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
								{formErrors.codebaseIndexQdrantUrl}
							</p>
						)}
					</div>
					<div className="space-y-2">
						<label className="text-sm font-medium">{t("settings:codeIndex.qdrantApiKeyLabel")}</label>
						<VSCodeTextField
							type="password"
							value={currentSettings.codeIndexQdrantApiKey || ""}
							onInput={(e: any) => updateSetting("codeIndexQdrantApiKey", e.target.value)}
							placeholder={t("settings:codeIndex.qdrantApiKeyPlaceholder")}
							className={cn("w-full", { "border-red-500": formErrors.codeIndexQdrantApiKey })}
						/>
						{formErrors.codeIndexQdrantApiKey && (
							<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
								{formErrors.codeIndexQdrantApiKey}
							</p>
						)}
					</div>
				</div>

				{/* Advanced Configuration */}
				<div className="space-y-4">
					<h3 className="text-base font-semibold">{t("settings:codeIndex.advancedConfigLabel")}</h3>

					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<label className="text-sm font-medium">{t("settings:codeIndex.searchMinScoreLabel")}</label>
							<StandardTooltip content={t("settings:codeIndex.searchMinScoreDescription")}>
								<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
							</StandardTooltip>
						</div>
						<div className="flex items-center gap-2">
							<Slider
								min={CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_SCORE}
								max={CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_SCORE}
								step={CODEBASE_INDEX_DEFAULTS.SEARCH_SCORE_STEP}
								value={[
									currentSettings.codebaseIndexSearchMinScore ??
										CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
								]}
								onValueChange={(values) => updateSetting("codebaseIndexSearchMinScore", values[0])}
								className="flex-1"
								data-testid="search-min-score-slider"
							/>
							<span className="w-12 text-center">
								{(
									currentSettings.codebaseIndexSearchMinScore ??
									CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE
								).toFixed(2)}
							</span>
						</div>
					</div>

					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<label className="text-sm font-medium">
								{t("settings:codeIndex.searchMaxResultsLabel")}
							</label>
							<StandardTooltip content={t("settings:codeIndex.searchMaxResultsDescription")}>
								<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
							</StandardTooltip>
						</div>
						<div className="flex items-center gap-2">
							<Slider
								min={CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_RESULTS}
								max={CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_RESULTS}
								step={CODEBASE_INDEX_DEFAULTS.SEARCH_RESULTS_STEP}
								value={[
									currentSettings.codebaseIndexSearchMaxResults ??
										CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
								]}
								onValueChange={(values) => updateSetting("codebaseIndexSearchMaxResults", values[0])}
								className="flex-1"
								data-testid="search-max-results-slider"
							/>
							<span className="w-12 text-center">
								{currentSettings.codebaseIndexSearchMaxResults ??
									CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS}
							</span>
						</div>
					</div>

					{/* Read-only index filter patterns.
				    The indexer skips any file whose extension is NOT in
				    CODEBASE_INDEX_FILE_EXTENSIONS, and any file beneath a directory
				    whose name matches CODEBASE_INDEX_IGNORED_DIRS. Both lists live
				    in @shofer/types and are the single source of truth shared with
				    the indexer; this panel just renders them so users can see what
				    is (and isn't) being indexed without grepping the source. */}
					<div className="space-y-3">
						<div>
							<label className="text-sm font-medium">{t("settings:codeIndex.filterPatternsLabel")}</label>
							<p className="text-xs text-vscode-descriptionForeground mt-1">
								{t("settings:codeIndex.filterPatternsDescription")}
							</p>
						</div>

						<div>
							<label className="text-xs font-medium text-vscode-descriptionForeground">
								{t("settings:codeIndex.filterFileExtensionsLabel")}
							</label>
							<div className="mt-1 flex flex-wrap gap-1" data-testid="filter-file-extensions">
								{CODEBASE_INDEX_FILE_EXTENSIONS.map((ext) => (
									<code
										key={ext}
										className="px-1.5 py-0.5 text-xs rounded bg-vscode-badge-background text-vscode-badge-foreground">
										{ext}
									</code>
								))}
							</div>
						</div>

						<div>
							<label className="text-xs font-medium text-vscode-descriptionForeground">
								{t("settings:codeIndex.filterIgnoredDirsLabel")}
							</label>
							<div className="mt-1 flex flex-wrap gap-1" data-testid="filter-ignored-dirs">
								{CODEBASE_INDEX_IGNORED_DIRS.map((dir) => (
									<code
										key={dir}
										className="px-1.5 py-0.5 text-xs rounded bg-vscode-badge-background text-vscode-badge-foreground">
										{dir}
									</code>
								))}
							</div>
							<p className="text-xs text-vscode-descriptionForeground mt-1">
								{t("settings:codeIndex.filterIgnoredDirsHint")}
							</p>
						</div>

						<p className="text-xs text-vscode-descriptionForeground">
							{t("settings:codeIndex.filterWorkspaceIgnoreNote")}
						</p>
					</div>
				</div>
			</div>
		)
	},
)

interface ModelDropdownProps {
	value: string
	error?: string
	models: string[]
	modelInfo?: Record<string, { dimension?: number }>
	onChange: (value: string) => void
	t: any
}

/**
 * Shared dropdown for embedder model selection (used by all providers that have
 * a fixed catalog of models in `codebaseIndexModels`).
 */
const ModelDropdown = ({ value, error, models, modelInfo, onChange, t }: ModelDropdownProps) => (
	<div className="space-y-2">
		<label className="text-sm font-medium">{t("settings:codeIndex.modelLabel")}</label>
		<VSCodeDropdown
			value={value}
			onChange={(e: any) => onChange(e.target.value)}
			className={cn("w-full", { "border-red-500": error })}>
			<VSCodeOption value="" className="p-2">
				{t("settings:codeIndex.selectModel")}
			</VSCodeOption>
			{models.map((modelId) => {
				const model = modelInfo?.[modelId]
				return (
					<VSCodeOption key={modelId} value={modelId} className="p-2">
						{modelId} {model ? t("settings:codeIndex.modelDimensions", { dimension: model.dimension }) : ""}
					</VSCodeOption>
				)
			})}
		</VSCodeDropdown>
		{error && <p className="text-xs text-vscode-errorForeground mt-1 mb-0">{error}</p>}
	</div>
)

interface DimensionFieldProps {
	value: number | undefined
	error?: string
	onChange: (value: number | undefined) => void
	t: any
}

const DimensionField = ({ value, error, onChange, t }: DimensionFieldProps) => (
	<div className="space-y-2">
		<label className="text-sm font-medium">{t("settings:codeIndex.modelDimensionLabel")}</label>
		<VSCodeTextField
			value={value?.toString() || ""}
			onInput={(e: any) => {
				const v = e.target.value ? parseInt(e.target.value, 10) || undefined : undefined
				onChange(v)
			}}
			placeholder={t("settings:codeIndex.modelDimensionPlaceholder")}
			className={cn("w-full", { "border-red-500": error })}
		/>
		{error && <p className="text-xs text-vscode-errorForeground mt-1 mb-0">{error}</p>}
	</div>
)
