/**
 * LiveMemorySettings — settings tab for the persistent codebase Q&A
 * companion (the "live memory").
 *
 * The live memory does not own its own provider/model/credentials. It
 * links to one of the API Configuration profiles managed under
 * Settings → Providers (i.e. the same profile system used by the main
 * agent and the condensing pipeline). This tab only lets the user:
 *
 *   - Enable/disable the live memory.
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

type LiveMemorySettingsProps = HTMLAttributes<HTMLDivElement> & {
	liveMemoryEnabled?: boolean
	liveMemoryApiConfigId?: string
	liveMemoryMaxContextTokens?: number
	liveMemoryContextFillThreshold?: number
	listApiConfigMeta: ApiConfigMeta[]
	setCachedStateField: SetCachedStateField<
		"liveMemoryEnabled" | "liveMemoryApiConfigId" | "liveMemoryMaxContextTokens" | "liveMemoryContextFillThreshold"
	>
}

/** Default context-fill threshold (85%) used when none is configured. */
const DEFAULT_CONTEXT_FILL_THRESHOLD = 0.85

export const LiveMemorySettings = ({
	liveMemoryEnabled,
	liveMemoryApiConfigId,
	liveMemoryMaxContextTokens,
	liveMemoryContextFillThreshold,
	listApiConfigMeta,
	setCachedStateField,
	...props
}: LiveMemorySettingsProps) => {
	const { t } = useAppTranslation()

	const selectedProfile = listApiConfigMeta.find((c) => c.id === liveMemoryApiConfigId)
	const profileSummary = selectedProfile
		? [selectedProfile.apiProvider, selectedProfile.modelId].filter(Boolean).join(" • ")
		: ""

	return (
		<div {...props}>
			<SectionHeader>
				<div className="flex items-center gap-2">
					<MessageCircle className="w-4" />
					<div>{t("settings:sections.liveMemory")}</div>
				</div>
			</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="liveMemory-enabled"
					section="liveMemory"
					label={t("settings:liveMemory.enabled.label")}>
					<VSCodeCheckbox
						checked={liveMemoryEnabled ?? true}
						onChange={(e: any) => setCachedStateField("liveMemoryEnabled", e.target.checked)}
						data-testid="live-memory-enabled-checkbox">
						<span className="font-medium">{t("settings:liveMemory.enabled.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:liveMemory.enabled.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="liveMemory-apiConfigId"
					section="liveMemory"
					label={t("settings:liveMemory.apiConfigId.label")}>
					<label className="block font-medium mb-1">{t("settings:liveMemory.apiConfigId.label")}</label>
					<Select
						value={liveMemoryApiConfigId || ""}
						onValueChange={(value) => setCachedStateField("liveMemoryApiConfigId", value)}>
						<SelectTrigger className="w-full" data-testid="live-memory-api-config-select">
							<SelectValue placeholder={t("settings:liveMemory.apiConfigId.placeholder")} />
						</SelectTrigger>
						<SelectContent>
							{listApiConfigMeta.length === 0 ? (
								<SelectItem value="__none__" disabled>
									{t("settings:liveMemory.apiConfigId.empty")}
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
						{t("settings:liveMemory.apiConfigId.description")}
						{profileSummary ? <div className="mt-1 italic">{profileSummary}</div> : null}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="liveMemory-maxContextTokens"
					section="liveMemory"
					label={t("settings:liveMemory.maxContextTokens.label")}>
					<VSCodeTextField
						value={liveMemoryMaxContextTokens === undefined ? "" : String(liveMemoryMaxContextTokens)}
						className="w-full"
						onInput={(e: any) => {
							const raw = e.target.value as string
							if (raw.trim() === "") {
								setCachedStateField("liveMemoryMaxContextTokens", undefined as unknown as number)
								return
							}
							const parsed = Number(raw)
							if (Number.isFinite(parsed) && parsed > 0) {
								setCachedStateField("liveMemoryMaxContextTokens", Math.floor(parsed))
							}
						}}
						placeholder={t("settings:liveMemory.maxContextTokens.placeholder")}
						data-testid="live-memory-max-context-tokens-input">
						<label className="block font-medium mb-1">
							{t("settings:liveMemory.maxContextTokens.label")}
						</label>
					</VSCodeTextField>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:liveMemory.maxContextTokens.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="liveMemory-contextFillThreshold"
					section="liveMemory"
					label={t("settings:liveMemory.contextFillThreshold.label")}>
					<VSCodeTextField
						value={String(liveMemoryContextFillThreshold ?? DEFAULT_CONTEXT_FILL_THRESHOLD)}
						className="w-full"
						onInput={(e: any) => {
							const parsed = Number(e.target.value)
							if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
								setCachedStateField("liveMemoryContextFillThreshold", parsed)
							}
						}}
						data-testid="live-memory-context-fill-threshold-input">
						<label className="block font-medium mb-1">
							{t("settings:liveMemory.contextFillThreshold.label")}
						</label>
					</VSCodeTextField>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:liveMemory.contextFillThreshold.description")}
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
