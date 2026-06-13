import { HTMLAttributes } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { Experiments, ImageGenerationProvider } from "@shofer/types"

import { EXPERIMENT_IDS, experimentConfigsMap } from "@shofer/shared/experiments"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { cn } from "@src/lib/utils"

import { SetExperimentEnabled, SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { ExperimentalFeature } from "./ExperimentalFeature"
import { ImageGenerationSettings } from "./ImageGenerationSettings"
import { CustomToolsSettings } from "./CustomToolsSettings"

type ExperimentalSettingsProps = HTMLAttributes<HTMLDivElement> & {
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
	apiConfiguration?: any
	setApiConfigurationField?: any
	archivedTaskRetentionDays?: number | null
	setCachedStateField: SetCachedStateField<"archivedTaskRetentionDays">
	imageGenerationProvider?: ImageGenerationProvider
	openRouterImageApiKey?: string
	openRouterImageGenerationSelectedModel?: string
	setImageGenerationProvider?: (provider: ImageGenerationProvider) => void
	setOpenRouterImageApiKey?: (apiKey: string) => void
	setImageGenerationSelectedModel?: (model: string) => void
}

export const ExperimentalSettings = ({
	experiments,
	setExperimentEnabled,
	apiConfiguration,
	setApiConfigurationField,
	archivedTaskRetentionDays,
	setCachedStateField,
	imageGenerationProvider,
	openRouterImageApiKey,
	openRouterImageGenerationSelectedModel,
	setImageGenerationProvider,
	setOpenRouterImageApiKey,
	setImageGenerationSelectedModel,
	className,
	...props
}: ExperimentalSettingsProps) => {
	const { t } = useAppTranslation()

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader>{t("settings:sections.experimental")}</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="advanced-archived-task-retention"
					section="experimental"
					label={t("settings:advanced.archivedTaskRetention.label")}>
					<VSCodeTextField
						value={archivedTaskRetentionDays == null ? "" : String(archivedTaskRetentionDays)}
						className="w-full"
						onInput={(e: any) => {
							const raw = (e.target.value as string).trim()
							if (raw === "") {
								// Empty → unset → backend falls back to the 7-day default.
								setCachedStateField("archivedTaskRetentionDays", null as unknown as number)
								return
							}
							const parsed = Number(raw)
							if (Number.isInteger(parsed) && parsed >= 0) {
								setCachedStateField("archivedTaskRetentionDays", parsed)
							}
						}}
						placeholder={t("settings:advanced.archivedTaskRetention.placeholder")}
						data-testid="archived-task-retention-input">
						<label className="block font-medium mb-1">
							{t("settings:advanced.archivedTaskRetention.label")}
						</label>
					</VSCodeTextField>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:advanced.archivedTaskRetention.description")}
					</div>
				</SearchableSetting>

				{Object.entries(experimentConfigsMap)
					.filter(([key]) => key in EXPERIMENT_IDS)
					.map((config) => {
						// Use the same translation key pattern as ExperimentalFeature
						const experimentKey = config[0]
						const label = t(`settings:experimental.${experimentKey}.name`)

						if (
							config[0] === "IMAGE_GENERATION" &&
							setImageGenerationProvider &&
							setOpenRouterImageApiKey &&
							setImageGenerationSelectedModel
						) {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<ImageGenerationSettings
										enabled={experiments[EXPERIMENT_IDS.IMAGE_GENERATION] ?? false}
										onChange={(enabled) =>
											setExperimentEnabled(EXPERIMENT_IDS.IMAGE_GENERATION, enabled)
										}
										imageGenerationProvider={imageGenerationProvider}
										openRouterImageApiKey={openRouterImageApiKey}
										openRouterImageGenerationSelectedModel={openRouterImageGenerationSelectedModel}
										setImageGenerationProvider={setImageGenerationProvider}
										setOpenRouterImageApiKey={setOpenRouterImageApiKey}
										setImageGenerationSelectedModel={setImageGenerationSelectedModel}
									/>
								</SearchableSetting>
							)
						}
						if (config[0] === "CUSTOM_TOOLS") {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<CustomToolsSettings
										enabled={experiments[EXPERIMENT_IDS.CUSTOM_TOOLS] ?? false}
										onChange={(enabled) =>
											setExperimentEnabled(EXPERIMENT_IDS.CUSTOM_TOOLS, enabled)
										}
									/>
								</SearchableSetting>
							)
						}
						return (
							<SearchableSetting
								key={config[0]}
								settingId={`experimental-${config[0].toLowerCase()}`}
								section="experimental"
								label={label}>
								<ExperimentalFeature
									experimentKey={config[0]}
									enabled={
										experiments[EXPERIMENT_IDS[config[0] as keyof typeof EXPERIMENT_IDS]] ?? false
									}
									onChange={(enabled) =>
										setExperimentEnabled(
											EXPERIMENT_IDS[config[0] as keyof typeof EXPERIMENT_IDS],
											enabled,
										)
									}
								/>
							</SearchableSetting>
						)
					})}
			</Section>
		</div>
	)
}
