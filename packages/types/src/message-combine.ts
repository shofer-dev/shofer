// Legacy alias names for the message-consolidation helpers. Consumers (webview,
// core) historically imported these `combine*`/`getApiMetrics` names; they map
// one-to-one onto the `consolidate*` helpers in ./message-utils.
export {
	consolidateApiRequests as combineApiRequests,
	consolidateCommands as combineCommandSequences,
	consolidateTokenUsage as getApiMetrics,
} from "./message-utils/index.js"
