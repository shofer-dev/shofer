import { useCallback, useState, useEffect, useRef } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	type ExtensionMessage,
	type RouterName,
	shoferDefaultModelId,
} from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { Button } from "@src/components/ui"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"

/** Default base URL — the local llm-router NodePort (must include the `/v1` suffix). */
const DEFAULT_SHOFER_BASE_URL = "http://localhost:30081/v1"

type ShoferProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

/**
 * Settings for the **Shofer Router** provider: point it at a running llm-router
 * (configurable base URL) and it auto-discovers the model catalog (+ pricing) from
 * `/v1/models`. Per-request cost rides the normal usage stream (`usage.cost`), so it
 * feeds the token/cost meter with no extra wiring. The model is stored in the shared
 * `apiModelId` field (what the ShoferHandler reads).
 */
export const Shofer = ({
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: ShoferProps) => {
	const { routerModels } = useExtensionState()
	const [refreshStatus, setRefreshStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const shoferErrorJustReceived = useRef(false)

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type === "singleRouterModelFetchResponse" && !message.success) {
				const providerName = message.values?.provider as RouterName
				if (providerName === "shofer") {
					shoferErrorJustReceived.current = true
					setRefreshStatus("error")
					setRefreshError(message.error)
				}
			} else if (message.type === "routerModels") {
				if (refreshStatus === "loading") {
					if (!shoferErrorJustReceived.current) {
						setRefreshStatus("success")
					}
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [refreshStatus])

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

	const handleRefreshModels = useCallback(() => {
		shoferErrorJustReceived.current = false
		setRefreshStatus("loading")
		setRefreshError(undefined)
		// Pass the live-typed base URL / key so a just-changed value takes effect
		// without needing a Save first (the handler flushes + refetches with these).
		vscode.postMessage({
			type: "requestRouterModels",
			values: {
				provider: "shofer",
				refresh: true,
				shoferBaseUrl: apiConfiguration.shoferBaseUrl || DEFAULT_SHOFER_BASE_URL,
				shoferApiKey: apiConfiguration.shoferApiKey,
			},
		})
	}, [apiConfiguration.shoferBaseUrl, apiConfiguration.shoferApiKey])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.shoferBaseUrl || ""}
				onInput={handleInputChange("shoferBaseUrl")}
				placeholder={DEFAULT_SHOFER_BASE_URL}
				className="w-full">
				<label className="block font-medium mb-1">Base URL</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				The llm-router OpenAI-compatible endpoint (include the <code>/v1</code> suffix). Defaults to{" "}
				<code>{DEFAULT_SHOFER_BASE_URL}</code>.
			</div>

			<VSCodeTextField
				value={apiConfiguration?.shoferApiKey || ""}
				type="password"
				onInput={handleInputChange("shoferApiKey")}
				placeholder="bearer token (any non-empty value)"
				className="w-full">
				<label className="block font-medium mb-1">API Key</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				Stored in VS Code SecretStorage. llm-router only requires the token to be present, so any non-empty
				value works unless your router enforces a specific key.
			</div>

			<Button
				variant="outline"
				onClick={handleRefreshModels}
				disabled={refreshStatus === "loading"}
				className="w-full">
				<div className="flex items-center gap-2">
					{refreshStatus === "loading" ? (
						<span className="codicon codicon-loading codicon-modifier-spin" />
					) : (
						<span className="codicon codicon-refresh" />
					)}
					Refresh Models
				</div>
			</Button>
			{refreshStatus === "error" && (
				<div className="text-sm text-vscode-errorForeground">
					{refreshError || "Failed to fetch models — is llm-router reachable at the Base URL?"}
				</div>
			)}

			<ModelPicker
				apiConfiguration={apiConfiguration}
				defaultModelId={shoferDefaultModelId}
				models={routerModels?.shofer ?? {}}
				modelIdKey="apiModelId"
				serviceName="Shofer Router"
				serviceUrl="http://localhost:30081/v1/models"
				setApiConfigurationField={setApiConfigurationField}
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
