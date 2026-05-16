/**
 * AssistantAgentSettings — settings tab for the persistent codebase Q&A
 * companion (the "assistant agent").
 *
 * The assistant agent does not own its own provider/model/credentials. It
 * links to one of the API Configuration profiles managed under
 * Settings → Providers (i.e. the same profile system used by the main
 * agent and the condensing pipeline). This tab only lets the user:
 *
 *   - Enable/disable the assistant agent.
 *   - Pick which API Configuration profile it should use.
 *   - Optionally override the context-window size (otherwise the model
 *     info reported by the resolved profile is used).
 *   - Tune the context-fill threshold (default 85%).
 */
import { HTMLAttributes } from "react"
import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { MessageCircle } from "lucide-react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

/** Minimal shape of an API Configuration entry as exposed by ExtensionState. */
interface ApiConfigMeta {
	id: string
	name: string
	apiProvider?: string
	modelId?: string
}

type AssistantAgentSettingsProps = HTMLAttributes<HTMLDivElement> & {
	assistantAgentEnabled?: boolean
	assistantAgentApiConfigId?: string
	assistantAgentMaxContextTokens?: number
	assistantAgentContextFillThreshold?: number
	listApiConfigMeta: ApiConfigMeta[]
	setCachedStateField: SetCachedStateField<
		| "assistantAgentEnabled"
		| "assistantAgentApiConfigId"
		| "assistantAgentMaxContextTokens"
		| "assistantAgentContextFillThreshold"
	>
}

/** Default context-fill threshold (85%) used when none is configured. */
const DEFAULT_CONTEXT_FILL_THRESHOLD = 0.85

export const AssistantAgentSettings = ({
	assistantAgentEnabled,
	assistantAgentApiConfigId,
	assistantAgentMaxContextTokens,
	assistantAgentContextFillThreshold,
	listApiConfigMeta,
	setCachedStateField,
	...props
}: AssistantAgentSettingsProps) => {
	const { t } = useAppTranslation()

	const selectedProfile = listApiConfigMeta.find((c) => c.id === assistantAgentApiConfigId)
	const profileSummary = selectedProfile
		? [selectedProfile.apiProvider, selectedProfile.modelId].filter(Boolean).join(" • ")
		: ""

	return (
		<div {...props}>
			<SectionHeader>
				<div className="flex items-center gap-2">
					<MessageCircle className="w-4" />
					<div>{t("settings:sections.assistantAgent")}</div>
				</div>
			</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="assistantAgent-enabled"
					section="assistantAgent"
					label={t("settings:assistantAgent.enabled.label")}>
					<VSCodeCheckbox
						checked={assistantAgentEnabled ?? true}
						onChange={(e: any) => setCachedStateField("assistantAgentEnabled", e.target.checked)}
						data-testid="assistant-agent-enabled-checkbox">
						<span className="font-medium">{t("settings:assistantAgent.enabled.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:assistantAgent.enabled.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="assistantAgent-apiConfigId"
					section="assistantAgent"
					label={t("settings:assistantAgent.apiConfigId.label")}>
					<label className="block font-medium mb-1">{t("settings:assistantAgent.apiConfigId.label")}</label>
					<Select
						value={assistantAgentApiConfigId || ""}
						onValueChange={(value) => setCachedStateField("assistantAgentApiConfigId", value)}>
						<SelectTrigger className="w-full" data-testid="assistant-agent-api-config-select">
							<SelectValue placeholder={t("settings:assistantAgent.apiConfigId.placeholder")} />
						</SelectTrigger>
						<SelectContent>
							{listApiConfigMeta.length === 0 ? (
								<SelectItem value="__none__" disabled>
									{t("settings:assistantAgent.apiConfigId.empty")}
								</SelectItem>
							) : (
								listApiConfigMeta.map((config) => (
									<SelectItem key={config.id} value={config.id}>
										{config.name}
										{config.modelId ? ` (${config.modelId})` : ""}
									</SelectItem>
								))
							)}
						</SelectContent>
					</Select>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:assistantAgent.apiConfigId.description")}
						{profileSummary ? <div className="mt-1 italic">{profileSummary}</div> : null}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="assistantAgent-maxContextTokens"
					section="assistantAgent"
					label={t("settings:assistantAgent.maxContextTokens.label")}>
					<VSCodeTextField
						value={
							assistantAgentMaxContextTokens === undefined ? "" : String(assistantAgentMaxContextTokens)
						}
						className="w-full"
						onInput={(e: any) => {
							const raw = e.target.value as string
							if (raw.trim() === "") {
								setCachedStateField("assistantAgentMaxContextTokens", undefined as unknown as number)
								return
							}
							const parsed = Number(raw)
							if (Number.isFinite(parsed) && parsed > 0) {
								setCachedStateField("assistantAgentMaxContextTokens", Math.floor(parsed))
							}
						}}
						placeholder={t("settings:assistantAgent.maxContextTokens.placeholder")}
						data-testid="assistant-agent-max-context-tokens-input">
						<label className="block font-medium mb-1">
							{t("settings:assistantAgent.maxContextTokens.label")}
						</label>
					</VSCodeTextField>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:assistantAgent.maxContextTokens.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="assistantAgent-contextFillThreshold"
					section="assistantAgent"
					label={t("settings:assistantAgent.contextFillThreshold.label")}>
					<VSCodeTextField
						value={String(assistantAgentContextFillThreshold ?? DEFAULT_CONTEXT_FILL_THRESHOLD)}
						className="w-full"
						onInput={(e: any) => {
							const parsed = Number(e.target.value)
							if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
								setCachedStateField("assistantAgentContextFillThreshold", parsed)
							}
						}}
						data-testid="assistant-agent-context-fill-threshold-input">
						<label className="block font-medium mb-1">
							{t("settings:assistantAgent.contextFillThreshold.label")}
						</label>
					</VSCodeTextField>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:assistantAgent.contextFillThreshold.description")}
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
