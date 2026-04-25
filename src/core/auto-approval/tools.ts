import type { ClineSayTool } from "@roo-code/types"

export function isWriteToolAction(tool: ClineSayTool): boolean {
	return ["editedExistingFile", "appliedDiff", "newFileCreated", "generateImage"].includes(tool.tool)
}

export function isReadOnlyToolAction(tool: ClineSayTool): boolean {
	return [
		"readFile",
		"listFiles",
		"listFilesTopLevel",
		"listFilesRecursive",
		"searchFiles",
		"codebaseSearch",
		"codebaseSearchWithLsp",
		"runSlashCommand",
		"findFiles",
		"viewImage",
		"getErrors",
		"getChangedFiles",
		"getProjectSetupInfo",
		"getSearchResults",
		"readProjectStructure",
		"listCodeUsages",
		"fetchWebPage",
	].includes(tool.tool)
}
