import type { AssertEqual, Equals, Keys, Values, ExperimentId, Experiments } from "@shofer/types"
import * as vscode from "vscode"

export const EXPERIMENT_IDS = {
	PREVENT_FOCUS_DISRUPTION: "preventFocusDisruption",
	IMAGE_GENERATION: "imageGeneration",
	RUN_SLASH_COMMAND: "runSlashCommand",
	CUSTOM_TOOLS: "customTools",
	SHOW_TOOL_INPUT_OUTPUT: "showToolInputOutput",
	PROMETHEUS_METRICS: "prometheusMetrics",
	WEBVIEW_LIVENESS_MONITOR: "webviewLivenessMonitor",
} as const satisfies Record<string, ExperimentId>

type _AssertExperimentIds = AssertEqual<Equals<ExperimentId, Values<typeof EXPERIMENT_IDS>>>

type ExperimentKey = Keys<typeof EXPERIMENT_IDS>

interface ExperimentConfig {
	enabled: boolean
}

export const experimentConfigsMap: Record<ExperimentKey, ExperimentConfig> = {
	PREVENT_FOCUS_DISRUPTION: { enabled: true },
	IMAGE_GENERATION: { enabled: false },
	RUN_SLASH_COMMAND: { enabled: false },
	CUSTOM_TOOLS: { enabled: false },
	SHOW_TOOL_INPUT_OUTPUT: { enabled: false },
	PROMETHEUS_METRICS: { enabled: false },
	WEBVIEW_LIVENESS_MONITOR: { enabled: false },
}

export const experimentDefault = Object.fromEntries(
	Object.entries(experimentConfigsMap).map(([_, config]) => [
		EXPERIMENT_IDS[_ as keyof typeof EXPERIMENT_IDS] as ExperimentId,
		config.enabled,
	]),
) as Record<ExperimentId, boolean>

export const experiments = {
	get: (id: ExperimentKey): ExperimentConfig | undefined => experimentConfigsMap[id],
	isEnabled: (experimentsConfig: Experiments, id: ExperimentId) => experimentsConfig[id] ?? experimentDefault[id],
} as const

/**
 * Mirror every experiment flag whose value drives `when`-clause visibility
 * in `package.json` into a VS Code context key. Called once during
 * `activate()` and again whenever the user toggles an experiment from
 * the Settings webview (see `webviewMessageHandler.ts` → `"experiments"`
 * branch) so toolbar buttons appear / disappear live without a reload.
 *
 * Naming convention: `shofer:<camelCaseExperimentId>Enabled`.
 */
export function syncExperimentContextKeys(experimentsConfig: Experiments): void {
	const livenessEnabled = experiments.isEnabled(experimentsConfig, EXPERIMENT_IDS.WEBVIEW_LIVENESS_MONITOR)
	void vscode.commands.executeCommand("setContext", "shofer:webviewLivenessMonitorEnabled", livenessEnabled)
}
