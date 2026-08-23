/**
 * The paragraph appended when the mode tiers its tool schemas
 * (`ModeConfig.tools_full_schema`): most tools then reach the model as stubs,
 * and a prompt that did not say so would describe a tool plane the request does
 * not have. Static per mode, like the section itself — the prompt is the head of
 * every request and only pays while it is byte-stable from turn to turn.
 */
const DEFERRED_SCHEMA_PARAGRAPH = `Some tools are listed with a one-line description and no parameters — their description says so and names describe_tools. Their arguments were omitted to keep this list small, not because they take none. Call describe_tools with the names you need (all of them in one call), read the schemas it returns, then call those tools normally. Do not guess a stubbed tool's arguments.`

/**
 * @param toolSchemasOnDemand When true, the mode declares a full-schema tier and
 *   every other tool is stubbed, so the protocol paragraph is appended. Absent /
 *   false renders the section byte-for-byte as it always was.
 */
export function getSharedToolUseSection(toolSchemasOnDemand?: boolean): string {
	return `====

TOOL USE

You have access to a set of tools that are executed upon the user's approval. Use the provider-native tool-calling mechanism. Do not include XML markup or examples. You must call at least one tool per assistant response. Prefer calling as many tools as are reasonably needed in a single response to reduce back-and-forth and complete tasks faster.${
		toolSchemasOnDemand ? `\n\n${DEFERRED_SCHEMA_PARAGRAPH}` : ""
	}`
}
