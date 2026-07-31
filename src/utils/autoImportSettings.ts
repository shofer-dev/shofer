import * as path from "path"
import * as os from "os"

import type { OutputChannelLike } from "@shofer/core"
import { getHost } from "@shofer/types"

import { Package } from "@shofer/core"
import { t } from "@shofer/core"
import { configLog } from "@shofer/core"

import { fileExistsAtPath } from "./fs"
import { importScopeSettingsArchive, type ImportOptions } from "../core/config/importExport"

/**
 * Pre-seed a fresh install from a **scope archive** (config-cleanup Part E6).
 *
 * `shofer.autoImportSettingsPath` — one of the two remaining bootstrap VS Code
 * settings — names a `.tgz` scope archive (as produced by Settings → Export). On
 * activation, when the user scope has no `settings.json` yet, the archive is
 * unpacked into `~/.shofer` and the layered loaders pick everything up from
 * there. Once the user scope is materialized the import never runs again — org
 * policy delivery is the `SHOFER_GLOBAL_DIR` mount's job, not this seam's.
 */
export async function autoImportSettings(
	outputChannel: OutputChannelLike,
	{ contextProxy, customModesManager }: ImportOptions,
): Promise<void> {
	try {
		const settingsPath = getHost().config.get<string | undefined>(Package.name, "autoImportSettingsPath", undefined)

		if (!settingsPath || settingsPath.trim() === "") {
			outputChannel.appendLine("[AutoImport] No auto-import settings path specified, skipping auto-import")
			return
		}

		// Resolve the path (handle ~ for home directory and relative paths)
		const resolvedPath = resolvePath(settingsPath.trim())
		outputChannel.appendLine(`[AutoImport] Checking for settings archive at: ${resolvedPath}`)

		if (!(await fileExistsAtPath(resolvedPath))) {
			outputChannel.appendLine(`[AutoImport] Archive not found at ${resolvedPath}, skipping auto-import`)
			return
		}

		// One-time seed: an already-materialized user scope is never overwritten.
		const userSettings = path.join(os.homedir(), ".shofer", "settings.json")
		if (await fileExistsAtPath(userSettings)) {
			outputChannel.appendLine(`[AutoImport] User scope already materialized (${userSettings}), skipping`)
			return
		}

		await importScopeSettingsArchive(resolvedPath)
		await contextProxy.refreshLayeredOverlay()
		customModesManager.invalidateCache()

		outputChannel.appendLine(`[AutoImport] Unpacked settings archive from ${resolvedPath}`)
		getHost().notifier.info(t("common:info.auto_import_success", { filename: path.basename(resolvedPath) }))
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		outputChannel.appendLine(`[AutoImport] Unexpected error during auto-import: ${errorMessage}`)

		// Log error but don't fail extension activation
		configLog.warn("Auto-import settings error:", { error: String(error) })
	}
}

/**
 * Resolves a file path, handling home directory expansion and relative paths
 */
function resolvePath(settingsPath: string): string {
	// Handle home directory expansion
	if (settingsPath.startsWith("~/")) {
		return path.join(os.homedir(), settingsPath.slice(2))
	}

	// Handle absolute paths
	if (path.isAbsolute(settingsPath)) {
		return settingsPath
	}

	// Handle relative paths (relative to home directory for safety)
	return path.join(os.homedir(), settingsPath)
}
