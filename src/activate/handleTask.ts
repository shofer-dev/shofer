import * as vscode from "vscode"

import { Package } from "../shared/package"
import { ShoferProvider } from "../core/webview/ShoferProvider"
import { t } from "../i18n"

/**
 * Handles the "New Task" command (pencil icon in sidebar header).
 * Uses createManagedTask to preserve the current task in the background
 * rather than aborting it, enabling parallel task execution.
 */
export const handleNewTask = async (params: { prompt?: string } | null | undefined) => {
	let prompt = params?.prompt

	if (!prompt) {
		prompt = await vscode.window.showInputBox({
			prompt: t("common:input.task_prompt"),
			placeHolder: t("common:input.task_placeholder"),
		})
	}

	if (!prompt) {
		await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
		return
	}

	// Use createManagedTask to preserve current task in background (parallel execution)
	const visibleProvider = await ShoferProvider.getInstance()
	if (visibleProvider) {
		await visibleProvider.createManagedTask(undefined, prompt, undefined)
	}
}
