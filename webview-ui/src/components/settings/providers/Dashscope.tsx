import { useCallback } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@shofer/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"

import { inputEventTransform } from "../transforms"

type DashscopeProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const Dashscope = ({ apiConfiguration, setApiConfigurationField }: DashscopeProps) => {
	const { t } = useAppTranslation()

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	return (
		<>
			<div>
				{/* Free-form so the international, Beijing, or US-Virginia compatible-mode
				    host (or any proxy) can be entered. Defaults to the international endpoint. */}
				<VSCodeTextField
					value={apiConfiguration?.dashScopeBaseUrl || ""}
					onInput={handleInputChange("dashScopeBaseUrl")}
					placeholder="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.dashScopeBaseUrl")}</label>
				</VSCodeTextField>
			</div>
			<div>
				<VSCodeTextField
					value={apiConfiguration?.dashScopeApiKey || ""}
					type="password"
					onInput={handleInputChange("dashScopeApiKey")}
					placeholder={t("settings:placeholders.apiKey")}
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.dashScopeApiKey")}</label>
				</VSCodeTextField>
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.apiKeyStorageNotice")}
				</div>
				{!apiConfiguration?.dashScopeApiKey && (
					<VSCodeButtonLink href="https://modelstudio.console.alibabacloud.com/" appearance="secondary">
						{t("settings:providers.getDashScopeApiKey")}
					</VSCodeButtonLink>
				)}
			</div>
		</>
	)
}
