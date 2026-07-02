import type { ExtensionContext } from "vscode"
import { getSettingsDirectoryPath } from "@shofer/core"

export async function ensureSettingsDirectoryExists(context: ExtensionContext): Promise<string> {
	// getSettingsDirectoryPath already handles the custom storage path setting
	return await getSettingsDirectoryPath(context.globalStorageUri.fsPath)
}
