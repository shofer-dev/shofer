import { useCallback, useState } from "react"

import type { ProviderSettings } from "@shofer/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { validateApiConfiguration } from "@src/utils/validate"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"
import { cn } from "@src/lib/utils"

import ApiOptions from "../settings/ApiOptions"
import { Tab, TabContent } from "../common/Tab"

import ShoferHero from "./ShoferHero"
import { Trans } from "react-i18next"
import { ArrowLeft, ArrowRight, GraduationCap, KeyRound, MessageSquarePlus } from "lucide-react"

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
		const steps = [
			{
				icon: KeyRound,
				title: t("welcome:landing.steps.connect.title"),
				description: t("welcome:landing.steps.connect.description"),
				action: (
					<Button
						onClick={handleNavigateToConfigureProvider}
						variant="primary"
						className="mt-1 w-fit gap-1.5">
						{t("welcome:landing.getStarted")}
						<ArrowRight className="size-4" />
					</Button>
				),
			},
			{
				icon: MessageSquarePlus,
				title: t("welcome:landing.steps.prompt.title"),
				description: t("welcome:landing.steps.prompt.description"),
				action: null,
			},
			{
				icon: GraduationCap,
				title: t("welcome:landing.steps.learn.title"),
				description: t("welcome:landing.steps.learn.description"),
				action: (
					<button
						onClick={() => vscode.postMessage({ type: "walkthroughOpen" })}
						className="mt-1 inline-flex w-fit cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-sm font-medium text-vscode-textLink-foreground hover:underline">
						{t("welcome:landing.steps.learn.cta")}
						<ArrowRight className="size-3.5" />
					</button>
				),
			},
		]

		return (
			<Tab>
				<TabContent className="relative flex flex-col gap-5 p-6 justify-center">
					<ShoferHero />
					<div className="flex flex-col gap-1">
						<h2 className="mt-0 mb-0 text-xl">{t("welcome:landing.greeting")}</h2>
						<p className="m-0 text-sm leading-normal text-vscode-descriptionForeground">
							<Trans i18nKey="welcome:landing.introduction" />
						</p>
					</div>

					<ol className="m-0 flex list-none flex-col p-0">
						{steps.map((step, i) => {
							const Icon = step.icon
							const isLast = i === steps.length - 1
							return (
								<li key={i} className="flex gap-3">
									{/* Timeline column: numbered badge + connecting line */}
									<div className="flex flex-col items-center self-stretch">
										<div className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-vscode-button-background text-sm font-semibold text-vscode-button-foreground shadow-sm">
											{i + 1}
										</div>
										{!isLast && <div className="my-1 w-px flex-1 bg-vscode-input-border" />}
									</div>
									{/* Content */}
									<div className={cn("flex flex-col gap-1", isLast ? "pb-1" : "pb-5")}>
										<div className="flex items-center gap-2 text-vscode-foreground">
											<Icon className="size-4 text-vscode-descriptionForeground" />
											<span className="font-medium">{step.title}</span>
										</div>
										<p className="m-0 text-sm leading-snug text-vscode-descriptionForeground">
											{step.description}
										</p>
										{step.action}
									</div>
								</li>
							)
						})}
					</ol>

					<div className="absolute bottom-6 left-6">
						<button
							onClick={() => vscode.postMessage({ type: "importSettings" })}
							className="cursor-pointer border-none bg-transparent p-0 text-sm text-vscode-descriptionForeground hover:text-vscode-foreground hover:underline">
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
