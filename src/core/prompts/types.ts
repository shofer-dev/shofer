/**
 * Settings passed to system prompt generation functions
 */
export interface SystemPromptSettings {
	todoListEnabled: boolean
	useAgentRules: boolean
	/** When true, recursively discover and load .shofer/rules from subdirectories */
	enableSubfolderRules?: boolean
	newTaskRequireTodos: boolean
	/** When true, model should hide vendor/company identity in responses */
	isStealthModel?: boolean
	/**
	 * Per-task tool-group allow-list (workflow agents' `.slang` `tools:`). When
	 * set, the CAPABILITIES section is gated to only the capabilities the agent
	 * actually has (mode groups ∩ these), so a restricted agent isn't told it can
	 * read/write/execute when those tools aren't in its catalog. Undefined ⇒ no
	 * gating (normal tasks render the full capabilities prose unchanged).
	 */
	agentToolGroups?: string[]
}
