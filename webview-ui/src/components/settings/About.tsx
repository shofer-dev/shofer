import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Trans } from "react-i18next"
import { Download, Upload, TriangleAlert, Bug, Lightbulb, Shield, MessagesSquare } from "lucide-react"
import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import type { TelemetrySetting } from "@shofer/types"

import { Package } from "@src/utils/package"
import { TelemetryClient } from "@/utils/TelemetryClient"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui"

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type AboutProps = HTMLAttributes<HTMLDivElement> & {
	telemetrySetting: TelemetrySetting
	setTelemetrySetting: (setting: TelemetrySetting) => void
	debug?: boolean
	setDebug?: (debug: boolean) => void
	settingsWriteScope?: "user" | "project"
	setCachedStateField: SetCachedStateField<"settingsWriteScope">
}

export const About = ({
	telemetrySetting,
	setTelemetrySetting,
	debug,
	setDebug,
	settingsWriteScope,
	setCachedStateField,
	className,
	...props
}: AboutProps) => {
	const { t } = useAppTranslation()

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader>{t("settings:sections.about")}</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="settings-write-scope"
					section="about"
					label={t("settings:about.settingsWriteScope.label")}>
					<label className="block font-medium mb-1">{t("settings:about.settingsWriteScope.label")}</label>
					<Select
						value={settingsWriteScope ?? "user"}
						onValueChange={(value) =>
							setCachedStateField("settingsWriteScope", value as "user" | "project")
						}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								<SelectItem value="user">{t("settings:about.settingsWriteScope.user")}</SelectItem>
								<SelectItem value="project">
									{t("settings:about.settingsWriteScope.project")}
								</SelectItem>
							</SelectGroup>
						</SelectContent>
					</Select>
					<p className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:about.settingsWriteScope.description")}
					</p>
				</SearchableSetting>
				<p>
					{Package.sha
						? `Version: ${Package.version} (${Package.sha.slice(0, 8)})`
						: `Version: ${Package.version}`}
				</p>
				<p className="mt-0">
					<VSCodeLink href="https://github.com/shofer-dev/shofer/blob/master/CHANGELOG.md">
						{t("settings:about.changelog")}
					</VSCodeLink>
				</p>
				{TelemetryClient.isGloballyEnabled() && (
					<SearchableSetting
						settingId="about-telemetry"
						section="about"
						label={t("settings:footer.telemetry.label")}>
						<VSCodeCheckbox
							checked={telemetrySetting !== "disabled"}
							onChange={(e: any) => {
								const checked = e.target.checked === true
								setTelemetrySetting(checked ? "enabled" : "disabled")
							}}>
							{t("settings:footer.telemetry.label")}
						</VSCodeCheckbox>
						<p className="text-vscode-descriptionForeground text-sm mt-0">
							<Trans
								i18nKey="settings:footer.telemetry.description"
								components={{
									privacyLink: <VSCodeLink href="https://shofer.dev/privacy" />,
								}}
							/>
						</p>
					</SearchableSetting>
				)}
			</Section>

			<Section className="space-y-0">
				<h3>{t("settings:about.contactAndCommunity")}</h3>
				<div className="flex flex-col gap-3">
					<div className="flex items-start gap-2">
						<Bug className="size-4 text-vscode-descriptionForeground shrink-0" />
						<span>
							{t("settings:about.bugReport.label")}{" "}
							<VSCodeLink href="https://github.com/shofer-dev/shofer/issues/new?template=bug_report.yml">
								{t("settings:about.bugReport.link")}
							</VSCodeLink>
						</span>
					</div>
					<div className="flex items-start gap-2">
						<Lightbulb className="size-4 text-vscode-descriptionForeground shrink-0" />
						<span>
							{t("settings:about.featureRequest.label")}{" "}
							<VSCodeLink href="https://github.com/shofer-dev/shofer/issues/new?template=feature_request.yml">
								{t("settings:about.featureRequest.link")}
							</VSCodeLink>
						</span>
					</div>
					<div className="flex items-start gap-2">
						<Shield className="size-4 text-vscode-descriptionForeground shrink-0" />
						<span>
							{t("settings:about.securityIssue.label")}{" "}
							<VSCodeLink href="https://github.com/shofer-dev/shofer/security/policy">
								{t("settings:about.securityIssue.link")}
							</VSCodeLink>
						</span>
					</div>
					<div className="flex items-start gap-2">
						<MessagesSquare className="size-4 text-vscode-descriptionForeground shrink-0" />
						<span>
							<Trans
								i18nKey="settings:about.community"
								components={{
									redditLink: <VSCodeLink href="https://reddit.com/r/Shofer_dev" />,
									discordLink: <VSCodeLink href="https://discord.gg/shofer" />,
								}}
							/>
						</span>
					</div>
					{setDebug && (
						<SearchableSetting
							settingId="about-debug-mode"
							section="about"
							label={t("settings:about.debugMode.label")}
							className="mt-4 pt-4 border-t border-vscode-settings-headerBorder">
							<VSCodeCheckbox
								checked={debug ?? false}
								onChange={(e: any) => {
									const checked = e.target.checked === true
									setDebug(checked)
								}}>
								{t("settings:about.debugMode.label")}
							</VSCodeCheckbox>
							<p className="text-vscode-descriptionForeground text-sm mt-0">
								{t("settings:about.debugMode.description")}
							</p>
						</SearchableSetting>
					)}
				</div>
			</Section>

			<Section className="space-y-0">
				<SearchableSetting
					settingId="about-manage-settings"
					section="about"
					label={t("settings:about.manageSettings")}>
					<h3>{t("settings:about.manageSettings")}</h3>
					<div className="flex flex-wrap items-center gap-2">
						<Button onClick={() => vscode.postMessage({ type: "exportSettings" })} className="w-28">
							<Upload className="p-0.5" />
							{t("settings:footer.settings.export")}
						</Button>
						<Button onClick={() => vscode.postMessage({ type: "importSettings" })} className="w-28">
							<Download className="p-0.5" />
							{t("settings:footer.settings.import")}
						</Button>
						<Button
							variant="destructive"
							onClick={() => vscode.postMessage({ type: "resetState" })}
							className="w-28">
							<TriangleAlert className="p-0.5" />
							{t("settings:footer.settings.reset")}
						</Button>
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
