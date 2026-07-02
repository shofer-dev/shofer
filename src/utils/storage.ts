import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { constants as fsConstants } from "fs"

import { getHost } from "@shofer/types"
import { Package } from "@shofer/core"
import { t } from "@shofer/core"
import { fsLog } from "@shofer/core"

/**
 * VS Code resolver for the user-configured custom storage path, registered into
 * `@shofer/core`'s storage seam (`setCustomStoragePathResolver`) at activation.
 * The base-path logic (validation/fallback) lives in core; this just reads the
 * `customStoragePath` setting.
 */
export async function getConfiguredCustomStoragePath(): Promise<string> {
	const config = vscode.workspace.getConfiguration(Package.name)
	return config.get<string>("customStoragePath", "")
}

/**
 * Prompts the user to set a custom storage path
 * Displays an input box allowing the user to enter a custom path
 */
export async function promptForCustomStoragePath(): Promise<void> {
	if (!vscode.window || !vscode.workspace) {
		fsLog.error("VS Code API not available")
		return
	}

	let currentPath = ""
	try {
		const currentConfig = vscode.workspace.getConfiguration(Package.name)
		currentPath = currentConfig.get<string>("customStoragePath", "")
	} catch {
		fsLog.error("Could not access configuration")
		return
	}

	const result = await vscode.window.showInputBox({
		value: currentPath,
		placeHolder: t("common:storage.path_placeholder"),
		prompt: t("common:storage.prompt_custom_path"),
		validateInput: (input) => {
			if (!input) {
				return null // Allow empty value (use default path)
			}

			try {
				// Validate path format
				path.parse(input)

				// Check if path is absolute
				if (!path.isAbsolute(input)) {
					return t("common:storage.enter_absolute_path")
				}

				return null // Path format is valid
			} catch {
				return t("common:storage.enter_valid_path")
			}
		},
	})

	// If user canceled the operation, result will be undefined
	if (result !== undefined) {
		try {
			const currentConfig = vscode.workspace.getConfiguration(Package.name)
			await currentConfig.update("customStoragePath", result, vscode.ConfigurationTarget.Global)

			if (result) {
				try {
					// Test if path is accessible
					await fs.mkdir(result, { recursive: true })
					await fs.access(result, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)
					getHost().notifier.info(t("common:info.custom_storage_path_set", { path: result }))
				} catch (error) {
					getHost().notifier.error(
						t("common:errors.cannot_access_path", {
							path: result,
							error: error instanceof Error ? error.message : String(error),
						}),
					)
				}
			} else {
				getHost().notifier.info(t("common:info.default_storage_path"))
			}
		} catch (error) {
			fsLog.error("Failed to update configuration", { error: String(error) })
		}
	}
}
