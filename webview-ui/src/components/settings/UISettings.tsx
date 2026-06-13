import { HTMLAttributes, useMemo } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { telemetryClient } from "@/utils/TelemetryClient"

import type { Experiments } from "@shofer/types"
import { EXPERIMENT_IDS } from "@shofer/shared/experiments"

import { SetCachedStateField, SetExperimentEnabled } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { ExperimentalFeature } from "./ExperimentalFeature"
import { Slider } from "../ui"
import { ExtensionStateContextType } from "@/context/ExtensionStateContext"

interface UISettingsProps extends HTMLAttributes<HTMLDivElement> {
	reasoningBlockCollapsed: boolean
	enterBehavior: "send" | "newline"
	ttsEnabled?: boolean
	ttsSpeed?: number
	soundEnabled?: boolean
	soundVolume?: number
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
	setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType>
}

export const UISettings = ({
	reasoningBlockCollapsed,
	enterBehavior,
	ttsEnabled,
	ttsSpeed,
	soundEnabled,
	soundVolume,
	experiments,
	setExperimentEnabled,
	setCachedStateField,
	...props
}: UISettingsProps) => {
	const { t } = useAppTranslation()

	// Detect platform for dynamic modifier key display
	const primaryMod = useMemo(() => {
		const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0
		return isMac ? "⌘" : "Ctrl"
	}, [])

	const handleReasoningBlockCollapsedChange = (value: boolean) => {
		setCachedStateField("reasoningBlockCollapsed", value)

		// Track telemetry event
		telemetryClient.capture("ui_settings_collapse_thinking_changed", {
			enabled: value,
		})
	}

	const handleEnterBehaviorChange = (requireCtrlEnter: boolean) => {
		const newBehavior = requireCtrlEnter ? "newline" : "send"
		setCachedStateField("enterBehavior", newBehavior)

		// Track telemetry event
		telemetryClient.capture("ui_settings_enter_behavior_changed", {
			behavior: newBehavior,
		})
	}

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.ui")}</SectionHeader>

			<Section>
				<div className="space-y-6">
					{/* Collapse Thinking Messages Setting */}
					<SearchableSetting
						settingId="ui-collapse-thinking"
						section="ui"
						label={t("settings:ui.collapseThinking.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={reasoningBlockCollapsed}
								onChange={(e: any) => handleReasoningBlockCollapsedChange(e.target.checked)}
								data-testid="collapse-thinking-checkbox">
								<span className="font-medium">{t("settings:ui.collapseThinking.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.collapseThinking.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Enter Key Behavior Setting */}
					<SearchableSetting
						settingId="ui-enter-behavior"
						section="ui"
						label={t("settings:ui.requireCtrlEnterToSend.label", { primaryMod })}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={enterBehavior === "newline"}
								onChange={(e: any) => handleEnterBehaviorChange(e.target.checked)}
								data-testid="enter-behavior-checkbox">
								<span className="font-medium">
									{t("settings:ui.requireCtrlEnterToSend.label", { primaryMod })}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.requireCtrlEnterToSend.description", { primaryMod })}
							</div>
						</div>
					</SearchableSetting>

					{/* Background Editing (PREVENT_FOCUS_DISRUPTION) — moved here from Advanced. */}
					<SearchableSetting
						settingId="ui-background-editing"
						section="ui"
						label={t("settings:experimental.PREVENT_FOCUS_DISRUPTION.name")}>
						<ExperimentalFeature
							experimentKey="PREVENT_FOCUS_DISRUPTION"
							enabled={experiments[EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION] ?? false}
							onChange={(enabled) =>
								setExperimentEnabled(EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION, enabled)
							}
						/>
					</SearchableSetting>

					{/* Text-to-speech (moved here from the dropped Notifications section). */}
					<SearchableSetting
						settingId="ui-tts"
						section="ui"
						label={t("settings:notifications.tts.label")}>
						<VSCodeCheckbox
							checked={ttsEnabled}
							onChange={(e: any) => setCachedStateField("ttsEnabled", e.target.checked)}
							data-testid="tts-enabled-checkbox">
							<span className="font-medium">{t("settings:notifications.tts.label")}</span>
						</VSCodeCheckbox>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:notifications.tts.description")}
						</div>
					</SearchableSetting>

					{ttsEnabled && (
						<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
							<SearchableSetting
								settingId="ui-tts-speed"
								section="ui"
								label={t("settings:notifications.tts.speedLabel")}>
								<label className="block font-medium mb-1">
									{t("settings:notifications.tts.speedLabel")}
								</label>
								<div className="flex items-center gap-2">
									<Slider
										min={0.1}
										max={2.0}
										step={0.01}
										value={[ttsSpeed ?? 1.0]}
										onValueChange={([value]) => setCachedStateField("ttsSpeed", value)}
										data-testid="tts-speed-slider"
									/>
									<span className="w-10">{((ttsSpeed ?? 1.0) * 100).toFixed(0)}%</span>
								</div>
							</SearchableSetting>
						</div>
					)}

					{/* Sound (moved here from the dropped Notifications section). */}
					<SearchableSetting
						settingId="ui-sound"
						section="ui"
						label={t("settings:notifications.sound.label")}>
						<VSCodeCheckbox
							checked={soundEnabled}
							onChange={(e: any) => setCachedStateField("soundEnabled", e.target.checked)}
							data-testid="sound-enabled-checkbox">
							<span className="font-medium">{t("settings:notifications.sound.label")}</span>
						</VSCodeCheckbox>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:notifications.sound.description")}
						</div>
					</SearchableSetting>

					{soundEnabled && (
						<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
							<SearchableSetting
								settingId="ui-sound-volume"
								section="ui"
								label={t("settings:notifications.sound.volumeLabel")}>
								<label className="block font-medium mb-1">
									{t("settings:notifications.sound.volumeLabel")}
								</label>
								<div className="flex items-center gap-2">
									<Slider
										min={0}
										max={1}
										step={0.01}
										value={[soundVolume ?? 0.5]}
										onValueChange={([value]) => setCachedStateField("soundVolume", value)}
										data-testid="sound-volume-slider"
									/>
									<span className="w-10">{((soundVolume ?? 0.5) * 100).toFixed(0)}%</span>
								</div>
							</SearchableSetting>
						</div>
					)}
				</div>
			</Section>
		</div>
	)
}
