import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { getTaskDirectoryPath } from "../../utils/storage"

export interface ErrorDiagnosticsValues {
	timestamp?: string
	version?: string
	provider?: string
	model?: string
	details?: string
}

export interface GenerateDiagnosticsParams {
	taskId: string
	globalStoragePath: string
	values?: ErrorDiagnosticsValues
	log: (message: string) => void
}

export interface GenerateDiagnosticsResult {
	success: boolean
	filePath?: string
	error?: string
}

/**
 * Generates an error diagnostics file containing error metadata and API conversation history.
 * The file is created in the system temp directory and opened in VS Code for the user to review
 * before sharing with support.
 */
export async function generateErrorDiagnostics(params: GenerateDiagnosticsParams): Promise<GenerateDiagnosticsResult> {
	const { taskId, globalStoragePath, values, log } = params

	try {
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, taskId)

		// Load API conversation history from the JSONL log used by openDebugApiHistory.
		const { readApiMessages } = await import("../task-persistence/apiMessages")
		let history: unknown = []
		try {
			history = await readApiMessages({ taskId, globalStoragePath })
		} catch (e) {
			vscode.window.showErrorMessage("Failed to read api_conversation_history.jsonl")
			log(`Failed to read api_conversation_history.jsonl: ${e instanceof Error ? e.message : String(e)}`)
		}

		const diagnostics = {
			error: {
				timestamp: values?.timestamp ?? new Date().toISOString(),
				version: values?.version ?? "",
				provider: values?.provider ?? "",
				model: values?.model ?? "",
				details: values?.details ?? "",
			},
			history,
		}

		// Prepend human-readable guidance comments before the JSON payload
		const headerComment =
			"// Please share this file with Shofer Support (alsterg@gmail.com) to diagnose the issue faster\n" +
			"// Just make sure you're OK sharing the contents of the conversation below.\n\n"
		const jsonContent = JSON.stringify(diagnostics, null, 2)
		const fullContent = headerComment + jsonContent

		// Create a temporary diagnostics file
		const tmpDir = os.tmpdir()
		const timestamp = Date.now()
		const tempFileName = `shofer-diagnostics-${taskId.slice(0, 8)}-${timestamp}.json`
		const tempFilePath = path.join(tmpDir, tempFileName)

		await fs.writeFile(tempFilePath, fullContent, "utf8")

		// Open the diagnostics file in VS Code
		const doc = await vscode.workspace.openTextDocument(tempFilePath)
		await vscode.window.showTextDocument(doc, { preview: true })

		return { success: true, filePath: tempFilePath }
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		log(`Error generating diagnostics: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to generate diagnostics: ${errorMessage}`)
		return { success: false, error: errorMessage }
	}
}
