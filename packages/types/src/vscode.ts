import { z } from "zod"

/**
 * CodeAction
 */

export const codeActionIds = ["explainCode", "fixCode", "improveCode", "addToContext", "newTask"] as const

export type CodeActionId = (typeof codeActionIds)[number]

export type CodeActionName = "EXPLAIN" | "FIX" | "IMPROVE" | "ADD_TO_CONTEXT" | "NEW_TASK"

/**
 * TerminalAction
 */

export const terminalActionIds = ["terminalAddToContext", "terminalFixCommand", "terminalExplainCommand"] as const

export type TerminalActionId = (typeof terminalActionIds)[number]

export type TerminalActionName = "ADD_TO_CONTEXT" | "FIX" | "EXPLAIN"

export type TerminalActionPromptType = `TERMINAL_${TerminalActionName}`

/**
 * Command
 */

export const commandIds = [
	"activationCompleted",

	"plusButtonClicked",
	"newWorkflowButtonClicked",
	"tasksButtonClicked",
	"historyButtonClicked",
	"marketplaceButtonClicked",
	"popoutButtonClicked",
	"settingsButtonClicked",

	"openInNewTab",

	"newTask",

	"setCustomStoragePath",
	"importSettings",

	"focusInput",
	"acceptInput",
	"focusPanel",
	"toggleAutoApprove",

	// Assistant Agent
	"assistantAgent.start",
	"assistantAgent.stop",
	"assistantAgent.clearContext",
	"assistantAgent.showChat",
	"assistantAgent.openSettings",

	// Git Index
	"startGitIndexing",
	"stopGitIndexing",
	"clearGitIndexData",

	// Webview
	"refreshWebview",
	// Webview
	"refreshWebview",
	"reloadWindow",

	// Walkthrough
	"walkthrough.open",
	"walkthrough.openDocumentation",
	"walkthrough.joinDiscord",
	"walkthrough.openCopilotGuide",
	"walkthrough.openRoocodeGuide",

	// Diagnostics
	"heapSnapshot",
] as const

export type CommandId = (typeof commandIds)[number]

/**
 * Language
 */

export const languages = [
	"ca",
	"de",
	"en",
	"es",
	"fr",
	"hi",
	"id",
	"it",
	"ja",
	"ko",
	"nl",
	"pl",
	"pt-BR",
	"ru",
	"tr",
	"vi",
	"zh-CN",
	"zh-TW",
] as const

export const languagesSchema = z.enum(languages)

export type Language = z.infer<typeof languagesSchema>

export const isLanguage = (value: string): value is Language => languages.includes(value as Language)
