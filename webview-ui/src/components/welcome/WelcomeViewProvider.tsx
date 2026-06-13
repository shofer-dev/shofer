import { useCallback, useState } from "react"

import type { ProviderSettings } from "@shofer/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { validateApiConfiguration } from "@src/utils/validate"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"

import ApiOptions from "../settings/ApiOptions"
import { Tab, TabContent } from "../common/Tab"

import ShoferHero from "./ShoferHero"
import { Trans } from "react-i18next"
import { ArrowLeft, GraduationCap } from "lucide-react"

const WelcomeViewProvider = () => {
	const { apiConfiguration, currentApiConfigName, setApiConfiguration, uriScheme } = useExtensionState()
	const { t } = useAppTranslation()
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
	const [showConfigureProvider, setShowConfigureProvider] = useState(false)

	// Memoize the setApiConfigurationField function to pass to ApiOptions
	const setApiConfigurationFieldForApiOptions = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => {
			setApiConfiguration({ [field]: value })
		},
		[setApiConfiguration],
	)

	const handleNavigateToConfigureProvider = useCallback(() => {
		setShowConfigureProvider(true)
	}, [])

	const handleFinish = useCallback(() => {
		const error = apiConfiguration ? validateApiConfiguration(apiConfiguration) : undefined

		if (error) {
			setErrorMessage(error)
			return
		}

		setErrorMessage(undefined)
		vscode.postMessage({ type: "upsertApiConfiguration", text: currentApiConfigName, apiConfiguration })
	}, [apiConfiguration, currentApiConfigName])

	const handleBackToLanding = useCallback(() => {
		setShowConfigureProvider(false)
		setErrorMessage(undefined)
	}, [])

	// Landing screen
	if (!showConfigureProvider) {
		return (
			<Tab>
				<TabContent className="relative flex flex-col gap-4 p-6 justify-center">
					<ShoferHero />
					<h2 className="mt-0 mb-0 text-xl">{t("welcome:landing.greeting")}</h2>

					<div className="space-y-4 leading-normal">
						<p className="text-base text-vscode-foreground">
							<Trans i18nKey="welcome:landing.introduction" />
						</p>
					</div>

					<div className="mt-2 flex gap-2 items-center flex-wrap">
						<Button onClick={handleNavigateToConfigureProvider} variant="primary">
							{t("welcome:landing.getStarted")}
						</Button>
						<Button onClick={() => vscode.postMessage({ type: "walkthroughOpen" })} variant="secondary">
							<GraduationCap className="size-4" />
							{t("welcome:landing.walkthrough")}
						</Button>
					</div>

					<div className="absolute bottom-6 left-6">
						<button
							onClick={() => vscode.postMessage({ type: "importSettings" })}
							className="cursor-pointer bg-transparent border-none p-0 text-vscode-foreground hover:underline">
							{t("welcome:importSettings")}
						</button>
					</div>
				</TabContent>
			</Tab>
		)
	}

	// Configure Provider screen — 3rd-party provider API key entry
	return (
		<Tab>
			<TabContent className="flex flex-col gap-4 p-6 justify-center">
				<h2 className="mt-0 mb-0 text-xl">{t("welcome:providerSignup.useAnotherProvider")}</h2>

				<p className="text-base text-vscode-foreground">
					{t("welcome:providerSignup.useAnotherProviderDescription")}
				</p>

				<div>
					<ApiOptions
						apiConfiguration={apiConfiguration || {}}
						uriScheme={uriScheme}
						setApiConfigurationField={setApiConfigurationFieldForApiOptions}
						fromWelcomeView
						errorMessage={errorMessage}
						setErrorMessage={setErrorMessage}
					/>
				</div>

				<div className="flex gap-2">
					<Button onClick={handleBackToLanding} variant="secondary">
						<ArrowLeft className="size-4" />
						{t("welcome:providerSignup.goBack")}
					</Button>
					<Button onClick={handleFinish} variant="primary">
						{t("welcome:providerSignup.finish")} →
					</Button>
				</div>
			</TabContent>
		</Tab>
	)
}

export default WelcomeViewProvider
