/**
 * HelperAgentSettings — settings tab for the persistent codebase Q&A
 * companion (the "helper agent").
 *
 * The helper agent does not own its own provider/model/credentials. It
 * links to one of the API Configuration profiles managed under
 * Settings → Providers (i.e. the same profile system used by the main
 * agent and the condensing pipeline). This tab only lets the user:
 *
 *   - Enable/disable the helper agent.
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

type HelperAgentSettingsProps = HTMLAttributes<HTMLDivElement> & {
	helperAgentEnabled?: boolean
	helperAgentApiConfigId?: string
	helperAgentMaxContextTokens?: number
	helperAgentContextFillThreshold?: number
	listApiConfigMeta: ApiConfigMeta[]
	setCachedStateField: SetCachedStateField<
		| "helperAgentEnabled"
		| "helperAgentApiConfigId"
		| "helperAgentMaxContextTokens"
		| "helperAgentContextFillThreshold"
	>
}

/** Default context-fill threshold (85%) used when none is configured. */
const DEFAULT_CONTEXT_FILL_THRESHOLD = 0.85

export const HelperAgentSettings = ({
	helperAgentEnabled,
	helperAgentApiConfigId,
	helperAgentMaxContextTokens,
	helperAgentContextFillThreshold,
	listApiConfigMeta,
	setCachedStateField,
	...props
}: HelperAgentSettingsProps) => {
	const { t } = useAppTranslation()

	const selectedProfile = listApiConfigMeta.find((c) => c.id === helperAgentApiConfigId)
	const profileSummary = selectedProfile
		? [selectedProfile.apiProvider, selectedProfile.modelId].filter(Boolean).join(" • ")
		: ""

	return (
		<div {...props}>
			<SectionHeader>
				<div className="flex items-center gap-2">
					<MessageCircle className="w-4" />
					<div>{t("settings:sections.helperAgent")}</div>
				</div>
			</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="helperAgent-enabled"
					section="helperAgent"
					label={t("settings:helperAgent.enabled.label")}>
					<VSCodeCheckbox
						checked={helperAgentEnabled ?? true}
						onChange={(e: any) => setCachedStateField("helperAgentEnabled", e.target.checked)}
						data-testid="helper-agent-enabled-checkbox">
						<span className="font-medium">{t("settings:helperAgent.enabled.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:helperAgent.enabled.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="helperAgent-apiConfigId"
					section="helperAgent"
					label={t("settings:helperAgent.apiConfigId.label")}>
					<label className="block font-medium mb-1">{t("settings:helperAgent.apiConfigId.label")}</label>
					<Select
						value={helperAgentApiConfigId || ""}
						onValueChange={(value) => setCachedStateField("helperAgentApiConfigId", value)}>
						<SelectTrigger className="w-full" data-testid="helper-agent-api-config-select">
							<SelectValue placeholder={t("settings:helperAgent.apiConfigId.placeholder")} />
						</SelectTrigger>
						<SelectContent>
							{listApiConfigMeta.length === 0 ? (
								<SelectItem value="__none__" disabled>
									{t("settings:helperAgent.apiConfigId.empty")}
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
						{t("settings:helperAgent.apiConfigId.description")}
						{profileSummary ? <div className="mt-1 italic">{profileSummary}</div> : null}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="helperAgent-maxContextTokens"
					section="helperAgent"
					label={t("settings:helperAgent.maxContextTokens.label")}>
					<VSCodeTextField
						value={helperAgentMaxContextTokens === undefined ? "" : String(helperAgentMaxContextTokens)}
						className="w-full"
						onInput={(e: any) => {
							const raw = e.target.value as string
							if (raw.trim() === "") {
								setCachedStateField("helperAgentMaxContextTokens", undefined as unknown as number)
								return
							}
							const parsed = Number(raw)
							if (Number.isFinite(parsed) && parsed > 0) {
								setCachedStateField("helperAgentMaxContextTokens", Math.floor(parsed))
							}
						}}
						placeholder={t("settings:helperAgent.maxContextTokens.placeholder")}
						data-testid="helper-agent-max-context-tokens-input">
						<label className="block font-medium mb-1">
							{t("settings:helperAgent.maxContextTokens.label")}
						</label>
					</VSCodeTextField>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:helperAgent.maxContextTokens.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="helperAgent-contextFillThreshold"
					section="helperAgent"
					label={t("settings:helperAgent.contextFillThreshold.label")}>
					<VSCodeTextField
						value={String(helperAgentContextFillThreshold ?? DEFAULT_CONTEXT_FILL_THRESHOLD)}
						className="w-full"
						onInput={(e: any) => {
							const parsed = Number(e.target.value)
							if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
								setCachedStateField("helperAgentContextFillThreshold", parsed)
							}
						}}
						data-testid="helper-agent-context-fill-threshold-input">
						<label className="block font-medium mb-1">
							{t("settings:helperAgent.contextFillThreshold.label")}
						</label>
					</VSCodeTextField>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:helperAgent.contextFillThreshold.description")}
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
