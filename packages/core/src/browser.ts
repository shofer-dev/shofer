/**
 * Browser-safe exports for the core package. These can safely be used
 * in browser environments like `webview-ui`.
 */

export {
	type ParsedApiReqStartedTextType,
	consolidateTokenUsage,
	hasTokenUsageChanged,
	hasToolUsageChanged,
	consolidateApiRequests,
	consolidateCommands,
	COMMAND_OUTPUT_STRING,
	safeJsonParse,
} from "@shofer/types"
