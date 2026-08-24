/**
 * Settings passed to system prompt generation functions.
 *
 * All `include*` / `require*` fields default to `true` (enabled) unless overridden
 * by a per-task `agentContext`.
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
	 * Per-task tool-group allow-list. When
	 * set, the CAPABILITIES section is gated to only the capabilities the agent
	 * actually has (mode groups ∩ these), so a restricted agent isn't told it can
	 * read/write/execute when those tools aren't in its catalog. Undefined ⇒ no
	 * gating (normal tasks render the full capabilities prose unchanged).
	 */
	agentToolGroups?: string[]
	/**
	 * Per-agent context overrides.
	 * Each boolean gates a system-prompt component for this task. Absent/default
	 * ⇒ inherit the global setting.
	 */
	includeModeRules?: boolean
	includeUserRules?: boolean
	includeSkills?: boolean
	includeSystemInfo?: boolean
	includeMcp?: boolean
	/**
	 * Section gates for the parts of the prompt that were previously
	 * unconditional. Each drops exactly one assembled section when `false`;
	 * absent or `true` renders it, so a caller that sets none gets the prompt
	 * byte-for-byte as before.
	 *
	 * Unlike the five above, these are also readable from a GLOBAL setting
	 * (`includeMarkdownFormattingSection` and friends), because their intended
	 * user is a deployment pinning the shape of every prompt a node builds. That
	 * distinction matters for more than convenience: the provider's prompt-prefix
	 * cache only hits while the system prompt is byte-stable across turns, so
	 * these must be settled per deployment/mode and never varied per turn.
	 *
	 * `includeToolUse` covers the TOOL USE and Tool Use Guidelines pair, which
	 * are one subject split across two functions — gating them apart would let a
	 * prompt state the tool protocol without its rules, or the reverse.
	 */
	includeMarkdownFormatting?: boolean
	includeToolUse?: boolean
	includeCapabilities?: boolean
	includeModes?: boolean
	includeRules?: boolean
	includeObjective?: boolean
	/**
	 * Whether the agent has a tool plane this turn (`ProviderSettings.toolCallingEnabled`).
	 *
	 * `false` selects the CONVERSATIONAL prompt: role definition, skills and
	 * system info only. Every tool-mediated section is omitted, because each of
	 * them mandates behaviour that is wrong for an agent whose reply is prose
	 * (and may be spoken aloud) — "you must call at least one tool", "use the
	 * attempt_completion tool", "NOT engage in a back and forth conversation",
	 * clickable `[`path`](path:line)` references. Undefined/true ⇒ the full
	 * agentic prompt, unchanged.
	 */
	toolCallingEnabled?: boolean
}
