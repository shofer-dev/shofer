import os from "os"
import * as path from "path"
import fs from "fs/promises"

import * as vscode from "vscode"
import { getHost } from "@shofer/types"

import { exportScopeArchive, importScopeArchive } from "@shofer/core"
import { t } from "@shofer/core"
import { configLog } from "@shofer/core"

import { ContextProxy } from "./ContextProxy"
import { CustomModesManager } from "./CustomModesManager"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"

/**
 * importExport — settings export/import as a **scope archive** (config-cleanup
 * Part E5): a gzipped tar of a `.shofer/` scope tree.
 *
 * The archive carries everything the layered file model owns — `settings.json`,
 * `providers.json`, `shofermodes`, `mcp.json`, `commands/`, `rules(-mode)/`,
 * `skills(-mode)/` — and **no secrets by construction**: provider keys live in
 * `SecretStorage`, outside `.shofer/`. This replaced the legacy JSON
 * (`shofer-code-settings.json`) path, which hand-assembled
 * `{ providerProfiles, globalSettings }` from two stores and embedded secret
 * material; with the file scopes as the single source of truth there is nothing
 * for a bespoke JSON format to add.
 *
 * Import unpacks into the writable **user** scope and refreshes the live
 * consumers (settings overlay, modes cache); everything else reads the files
 * per call or follows the scope watchers.
 */

/** The archive filename suggested by the save dialog. */
const DEFAULT_ARCHIVE_NAME = "shofer-settings.tgz"

/** The default (user) scope's `.shofer/` root — `~/.shofer`. */
function defaultUserScopeRoot(): string {
	return path.join(os.homedir(), ".shofer")
}

export type ImportOptions = {
	contextProxy: ContextProxy
	customModesManager: CustomModesManager
}

type ImportWithProviderOptions = ImportOptions & {
	provider: {
		settingsImportedAt?: number
		postInitState: () => Promise<void>
	}
}

export type ImportResult = { success: boolean; error?: string }

/**
 * Export = archive a scope's `.shofer/` tree (default: the user scope) to a
 * caller-chosen path. Secrets are not in the archive by construction.
 */
export async function exportScopeSettingsArchive(destPath: string, scopeRoot: string = defaultUserScopeRoot()) {
	const dirname = path.dirname(destPath)
	await fs.mkdir(dirname, { recursive: true })
	await exportScopeArchive(scopeRoot, destPath)
}

/**
 * Import = unpack a scope archive into a scope root (default: the user scope).
 * Any secrets are applied out of band, never from the archive.
 */
export async function importScopeSettingsArchive(archivePath: string, scopeRoot: string = defaultUserScopeRoot()) {
	await importScopeArchive(archivePath, scopeRoot)
}

/** Export the user scope's `.shofer/` via a save dialog. */
export const exportSettings = async ({ contextProxy }: { contextProxy: ContextProxy }) => {
	const defaultUri = await resolveDefaultSaveUri(contextProxy, "lastSettingsExportPath", DEFAULT_ARCHIVE_NAME, {
		useWorkspace: false,
		fallbackDir: path.join(os.homedir(), "Downloads"),
	})

	const uri = await vscode.window.showSaveDialog({
		filters: { Archive: ["tgz", "gz"] },
		defaultUri,
	})

	if (!uri) {
		return
	}

	await saveLastExportPath(contextProxy, "lastSettingsExportPath", uri)

	try {
		await exportScopeSettingsArchive(uri.fsPath)
	} catch (e) {
		configLog.error("Failed to export settings:", e)
		// Don't re-throw - the UI will handle showing error messages
	}
}

/**
 * Import a scope archive into the user scope and refresh the live consumers.
 * The settings overlay is re-read immediately; modes re-merge on next read;
 * MCP servers and provider profiles follow their scope watchers / per-call
 * file reads.
 */
async function applyScopeArchive(
	archivePath: string,
	{ contextProxy, customModesManager }: ImportOptions,
): Promise<ImportResult> {
	try {
		await importScopeSettingsArchive(archivePath)
		await contextProxy.refreshLayeredOverlay()
		customModesManager.invalidateCache()
		await customModesManager.getCustomModes()
		return { success: true }
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) }
	}
}

/** Import a scope archive chosen via a file dialog. */
export const importSettings = async (options: ImportOptions): Promise<ImportResult> => {
	// Use the last export path as a sensible default, falling back to Downloads
	const defaultUri = resolveDefaultSaveUri(options.contextProxy, "lastSettingsExportPath", DEFAULT_ARCHIVE_NAME, {
		useWorkspace: false,
		fallbackDir: path.join(os.homedir(), "Downloads"),
	})

	const uris = await vscode.window.showOpenDialog({
		filters: { Archive: ["tgz", "gz"] },
		canSelectMany: false,
		defaultUri,
	})

	if (!uris) {
		return { success: false, error: "User cancelled file selection" }
	}

	return applyScopeArchive(uris[0].fsPath, options)
}

/**
 * Import a scope archive with complete UI feedback and provider state updates.
 * @param filePath - Optional archive path. Without it, a file dialog is shown.
 */
export const importSettingsWithFeedback = async (
	{ contextProxy, customModesManager, provider }: ImportWithProviderOptions,
	filePath?: string,
) => {
	let result: ImportResult

	if (filePath) {
		try {
			await fs.access(filePath, fs.constants.F_OK | fs.constants.R_OK)
			result = await applyScopeArchive(filePath, { contextProxy, customModesManager })
		} catch (error) {
			result = {
				success: false,
				error: `Cannot access file at path "${filePath}": ${error instanceof Error ? error.message : "Unknown error"}`,
			}
		}
	} else {
		result = await importSettings({ contextProxy, customModesManager })
	}

	if (result.success) {
		provider.settingsImportedAt = Date.now()
		await provider.postInitState()
		getHost().notifier.info(t("common:info.settings_imported"))
	} else if (result.error) {
		getHost().notifier.error(t("common:errors.settings_import_failed", { error: result.error }))
	}
}
