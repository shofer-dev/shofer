import * as vscode from "vscode"
import type { Experiments } from "@shofer/types"

import { EXPERIMENT_IDS, experiments } from "../shared/experiments"

/**
 * Mirror every experiment flag whose value drives `when`-clause visibility
 * in `package.json` into a VS Code context key. Called once during
 * `activate()` and again whenever the user toggles an experiment from
 * the Settings webview (see `webviewMessageHandler.ts` → `"experiments"`
 * branch) so toolbar buttons appear / disappear live without a reload.
 *
 * Naming convention: `shofer:<camelCaseExperimentId>Enabled`.
 *
 * Lives in `src/activate/` (extension-host only) rather than `shared/`
 * because it depends on the `vscode` API, which is not available in the
 * webview bundle that imports `shared/experiments.ts`.
 */
export function syncExperimentContextKeys(experimentsConfig: Experiments): void {
	const livenessEnabled = experiments.isEnabled(experimentsConfig, EXPERIMENT_IDS.WEBVIEW_LIVENESS_MONITOR)
	void vscode.commands.executeCommand("setContext", "shofer:webviewLivenessMonitorEnabled", livenessEnabled)
}
