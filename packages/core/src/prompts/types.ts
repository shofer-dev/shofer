/**
 * Settings passed to system prompt generation functions.
 *
 * All `include*` / `require*` fields default to `true` (enabled) unless overridden
 * by a per-task `agentContext` from a workflow agent's `.slang` `context { ... }` block.
 */
export interface SystemPromptSettings {
	todoListEnabled: boolean
	useAgentRules: boolean
	/** When true (default), recursively discover and load subdirectory rules (AGENTS.md and .shofer/rules), on demand */
	enableSubfolderRules?: boolean
	/**
	 * Workspace-relative paths the task has touched so far (read, mentioned,
	 * or edited — from FileContextTracker). Gates on-demand rule loading: a
	 * subfolder's AGENTS.md/.shofer rules load only once a file under it is
	 * touched, and a `paths:`-frontmatter rule loads only when a touched path
	 * matches. Undefined ⇒ the caller has no file context (prompt preview) and
	 * nothing is gated.
	 */
	touchedPaths?: string[]
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
	/**
	 * Per-agent context overrides from `.slang` `context { ... }` block.
	 * Each boolean gates a system-prompt component for this task. Absent/default
	 * ⇒ inherit the global setting.
	 */
	includeModeRules?: boolean
	includeUserRules?: boolean
	includeSkills?: boolean
	includeSystemInfo?: boolean
	includeMcp?: boolean
}
