import * as path from "path"
import * as fs from "fs/promises"
import { constants as fsConstants } from "fs"

import { getHost } from "@shofer/types"

import { t } from "../i18n/index.js"
import { fsLog } from "../logging/subsystems.js"

/**
 * Host seam for the user-configured custom storage path.
 *
 * The base-path *logic* (validation, fallback, directory layout) is host-agnostic
 * and lives here in core. Only the source of the raw custom-path string is
 * host-specific — in the VS Code front-end it comes from
 * `workspace.getConfiguration(...).customStoragePath`. The extension registers a
 * resolver at activation via {@link setCustomStoragePathResolver}; headless hosts
 * leave it unset, so the base path is always the passed default.
 */
type CustomStoragePathResolver = () => Promise<string>

let customStoragePathResolver: CustomStoragePathResolver = async () => ""

/** Register the host resolver for the user-configured custom storage path. */
export function setCustomStoragePathResolver(resolver: CustomStoragePathResolver): void {
	customStoragePathResolver = resolver
}

/**
 * Gets the base storage path for conversations.
 * If a custom path is configured (via the host resolver), validates and uses it;
 * otherwise (or on any failure) uses the default path.
 */
export async function getStorageBasePath(defaultPath: string): Promise<string> {
	let customStoragePath = ""

	try {
		customStoragePath = await customStoragePathResolver()
	} catch {
		fsLog.warn("Could not resolve custom storage path - using default path")
		return defaultPath
	}

	// If no custom path is set, use default path
	if (!customStoragePath) {
		return defaultPath
	}

	try {
		// Ensure custom path exists
		await fs.mkdir(customStoragePath, { recursive: true })

		// Check directory write permission without creating temp files
		await fs.access(customStoragePath, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)

		return customStoragePath
	} catch (error) {
		// If path is unusable, report error and fall back to default path
		fsLog.error(`Custom storage path is unusable: ${error instanceof Error ? error.message : String(error)}`)
		getHost().notifier.error(t("common:errors.custom_storage_path_unusable", { path: customStoragePath }))
		return defaultPath
	}
}

/**
 * Gets the storage directory path for a task
 */
export async function getTaskDirectoryPath(globalStoragePath: string, taskId: string): Promise<string> {
	const basePath = await getStorageBasePath(globalStoragePath)
	const taskDir = path.join(basePath, "tasks", taskId)
	await fs.mkdir(taskDir, { recursive: true })
	return taskDir
}

/**
 * Gets the settings directory path
 */
export async function getSettingsDirectoryPath(globalStoragePath: string): Promise<string> {
	const basePath = await getStorageBasePath(globalStoragePath)
	const settingsDir = path.join(basePath, "settings")
	await fs.mkdir(settingsDir, { recursive: true })
	return settingsDir
}

/**
 * Gets the cache directory path
 */
export async function getCacheDirectoryPath(globalStoragePath: string): Promise<string> {
	const basePath = await getStorageBasePath(globalStoragePath)
	const cacheDir = path.join(basePath, "cache")
	await fs.mkdir(cacheDir, { recursive: true })
	return cacheDir
}
