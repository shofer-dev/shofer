import { z } from "zod"

import { toolGroupsSchema } from "./tool.js"

/**
 * GroupOptions
 */

export const groupOptionsSchema = z.object({
	fileRegex: z
		.string()
		.optional()
		.refine(
			(pattern) => {
				if (!pattern) {
					return true // Optional, so empty is valid.
				}

				try {
					new RegExp(pattern)
					return true
				} catch {
					return false
				}
			},
			{ message: "Invalid regular expression pattern" },
		),
	description: z.string().optional(),
})

export type GroupOptions = z.infer<typeof groupOptionsSchema>

/**
 * GroupScope — per-group tool allow/deny lists within a mode's groups array.
 *
 * When a group entry is an object (e.g., `{ read: { allowed: [...] } }`),
 * the scope narrows the tool set the group normally provides:
 *   - `allowed`: exclusive list — only these tools from the group are available
 *   - `denied`:  removes the listed tools from the group's normal set
 *
 * Both fields are optional. An empty scope object `{}` is equivalent to a bare
 * group name (all tools in the group).
 */
export const groupScopeSchema = z.object({
	allowed: z.array(z.string()).optional(),
	denied: z.array(z.string()).optional(),
})

export type GroupScope = z.infer<typeof groupScopeSchema>

/**
 * GroupEntry
 *
 * A group entry can now be:
 *   1. A bare group name string:             "read"
 *   2. A [name, options] tuple:              ["write", { fileRegex: "\\.md$" }]
 *   3. A scoped group object:                { "read": { allowed: [...], denied: [...] } }
 *      (exactly one group name as the key)
 */
const scopedGroupEntrySchema = z
	.record(z.string(), groupScopeSchema)
	.refine((obj) => Object.keys(obj).length === 1, {
		message: "Each scoped group entry must have exactly one group name",
	})
	.refine((obj) => toolGroupsSchema.safeParse(Object.keys(obj)[0]).success, {
		message: "Scoped group entry key must be a valid group name",
	})

export const groupEntrySchema = z.union([
	toolGroupsSchema,
	z.tuple([toolGroupsSchema, groupOptionsSchema]),
	scopedGroupEntrySchema,
])

export type GroupEntry = z.infer<typeof groupEntrySchema>

/**
 * ModeConfig
 */

/**
 * Raw schema for validating group entries and ensuring no duplicates.
 */
const rawGroupEntryArraySchema = z.array(groupEntrySchema).refine(
	(groups) => {
		const seen = new Set()

		return groups.every((group) => {
			// Extract group name from any format: string, [name, opts], or { name: { ... } }
			const groupName =
				typeof group === "string" ? group : Array.isArray(group) ? group[0] : Object.keys(group)[0]!

			if (seen.has(groupName)) {
				return false
			}

			seen.add(groupName)
			return true
		})
	},
	{ message: "Duplicate groups are not allowed" },
)

/**
 * Schema for mode group entries. Validates group entries and ensures no
 * duplicate group names within a mode's configuration.
 */
export const groupEntryArraySchema = rawGroupEntryArraySchema

/**
 * Raw ZodObject for ModeConfig, without refinements. Use this when you need
 * ZodObject methods like `.omit()`, `.extend()`, `.pick()`, etc. that are not
 * available on ZodEffects.
 */
export const modeConfigObjectSchema = z.object({
	slug: z.string().regex(/^[a-zA-Z0-9-]+$/, "Slug must contain only letters numbers and dashes"),
	name: z.string().min(1, "Name is required"),
	roleDefinition: z.string().min(1, "Role definition is required"),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
	groups: groupEntryArraySchema.optional(),
	tools_allowed: z.array(z.string()).optional(),
	tools_denied: z.array(z.string()).optional(),
	source: z.enum(["global", "project"]).optional(),
	provider: z.string().optional(),
})

export const modeConfigSchema = modeConfigObjectSchema.refine(
	(data) => data.groups !== undefined || data.tools_allowed !== undefined,
	{ message: "Either 'groups' or 'tools_allowed' must be provided" },
)

export type ModeConfig = z.infer<typeof modeConfigSchema>

/**
 * CustomModesSettings
 */

export const customModesSettingsSchema = z.object({
	customModes: z.array(modeConfigSchema).refine(
		(modes) => {
			const slugs = new Set()

			return modes.every((mode) => {
				if (slugs.has(mode.slug)) {
					return false
				}

				slugs.add(mode.slug)
				return true
			})
		},
		{
			message: "Duplicate mode slugs are not allowed",
		},
	),
})

export type CustomModesSettings = z.infer<typeof customModesSettingsSchema>

/**
 * PromptComponent
 */

export const promptComponentSchema = z.object({
	roleDefinition: z.string().optional(),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
})

export type PromptComponent = z.infer<typeof promptComponentSchema>

/**
 * CustomModePrompts
 */

export const customModePromptsSchema = z.record(z.string(), promptComponentSchema.optional())

export type CustomModePrompts = z.infer<typeof customModePromptsSchema>

/**
 * CustomSupportPrompts
 */

export const customSupportPromptsSchema = z.record(z.string(), z.string().optional())

export type CustomSupportPrompts = z.infer<typeof customSupportPromptsSchema>

/**
 * DEFAULT_MODES
 *
 * Six built-in modes: code, architect, debug, code-search, web-search, reviewer.
 * The first entry (code) is the default mode — used as fallback when a mode
 * slug cannot be resolved to any known mode.
 */

export const DEFAULT_MODES: readonly ModeConfig[] = [
	{
		slug: "code",
		name: "💻 Code",
		roleDefinition:
			"You are Shofer, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
		whenToUse:
			"Use this mode when you need to write, modify, or refactor code. Ideal for implementing features, fixing bugs, creating new files, or making code improvements across any programming language or framework.",
		description: "Write, modify, and refactor code",
		groups: ["read", "write", "execute", "mcp", "mode", "subtasks", "questions", "uncategorized"],
	},
	{
		slug: "architect",
		name: "🏗️ Architect",
		roleDefinition:
			"You are Shofer, an experienced technical leader who is inquisitive and an excellent planner. Your goal is to gather information and get context to create a detailed plan for accomplishing the user's task, which the user will review and approve before they switch into another mode to implement the solution.",
		whenToUse:
			"Use this mode when you need to plan, design, or strategize before implementation. Perfect for breaking down complex problems, creating technical specifications, designing system architecture, or brainstorming solutions before coding.",
		description: "Plan and design before implementation",
		groups: [
			"read",
			["write", { fileRegex: "\\.md$", description: "Markdown files only" }],
			"mcp",
			"subtasks",
			"questions",
		],
		customInstructions:
			"1. Do some information gathering (using provided tools) to get more context about the task.\n\n2. You should also ask the user clarifying questions to get a better understanding of the task.\n\n3. Once you've gained more context about the user's request, break down the task into clear, actionable steps and create a todo list using the `update_todo_list` tool. Each todo item should be:\n   - Specific and actionable\n   - Listed in logical execution order\n   - Focused on a single, well-defined outcome\n   - Clear enough that another mode could execute it independently\n\n   **Note:** If the `update_todo_list` tool is not available, write the plan to a markdown file (e.g., `plan.md` or `todo.md`) instead.\n\n4. As you gather more information or discover new requirements, update the todo list to reflect the current understanding of what needs to be accomplished.\n\n5. Ask the user if they are pleased with this plan, or if they would like to make any changes. Think of this as a brainstorming session where you can discuss the task and refine the todo list.\n\n6. Include Mermaid diagrams if they help clarify complex workflows or system architecture. Please avoid using double quotes (\"\") and parentheses () inside square brackets ([]) in Mermaid diagrams, as this can cause parsing errors.\n\n7. Use the switch_mode tool to request that the user switch to another mode to implement the solution.\n\n**IMPORTANT: Focus on creating clear, actionable todo lists rather than lengthy markdown documents. Use the todo list as your primary planning tool to track and organize the work that needs to be done.**\n\n**CRITICAL: Never provide level of effort time estimates (e.g., hours, days, weeks) for tasks. Focus solely on breaking down the work into clear, actionable steps without estimating how long they will take.**\n\nUnless told otherwise, if you want to save a plan file, put it in the /plans directory",
	},
	{
		slug: "debug",
		name: "🪲 Debug",
		roleDefinition:
			"You are Shofer, an expert software debugger specializing in systematic problem diagnosis and resolution.",
		whenToUse:
			"Use this mode when you're troubleshooting issues, investigating errors, or diagnosing problems. Specialized in systematic debugging, adding logging, analyzing stack traces, and identifying root causes before applying fixes.",
		description: "Diagnose and fix software issues",
		groups: ["read", "write", "execute", "mcp", "subtasks", "questions", "uncategorized"],
		customInstructions:
			"Reflect on 5-7 different possible sources of the problem, distill those down to 1-2 most likely sources, and then add logs to validate your assumptions. Explicitly ask the user to confirm the diagnosis before fixing the problem.",
	},
	{
		slug: "code-search",
		name: "🔎 Code Search",
		roleDefinition:
			"You are a fast, focused codebase search agent. Your purpose is to quickly find relevant code, files, patterns, and context within the repository and return concise, actionable results to the caller. You search broadly across the codebase using all available tools - semantic search, text search, file listing, and command-line utilities. You do not edit any files; you are purely a retrieval engine.",
		whenToUse:
			"Use this mode when you need to quickly search the codebase for specific information - find where a function is defined, locate all usages of a symbol, discover patterns, or gather context about how something works. Ideal for use as a sub-task via new_task to parallelize codebase exploration.",
		description: "Search and explore the codebase",
		groups: ["read", "execute", "mcp", "questions"],
		customInstructions:
			"When searching:\n1. Use codebase_search for semantic/meaning-based searches first.\n2. Use search_files or get_search_results for regex/text pattern matching.\n3. Use list_files or read_project_structure to explore directory layouts.\n4. Use execute_command with grep, sed, awk, find, rg, fd, or similar tools for fast CLI searches.\n5. Use list_code_usages to find all references to a symbol.\n6. Be thorough but fast - prioritize breadth over depth.\n7. Return results in a clear, structured summary with file paths and line numbers.\n8. Do NOT edit any files. Do NOT use write_to_file, apply_diff, or insert_edit. Your role is search and retrieval only.\n9. Signal completion with attempt_completion, providing a concise summary of findings.",
	},
	{
		slug: "web-search",
		name: "🌐 Web Search",
		roleDefinition:
			"You are a web browsing agent. Your purpose is to use the browser to research, extract, and interact with web content to accomplish tasks. You navigate to web pages, search for information, extract text and structured data, fill forms, take screenshots, and interact with web applications. You do not modify any code or files in the workspace.",
		whenToUse:
			"Use this mode when you need to use a web browser to find information, research topics, interact with web applications, extract data from websites, replay a saved browser workflow, or capture a new repeatable browser skill.",
		description: "Browse and extract web content",
		groups: ["browser", "questions", "mcp"],
		customInstructions:
			'## Web interaction primitives\n\n**First, check if you have an active tab.** If no tabs are open, `browser_navigate` will fail with "No tab with given id". Always start a new session with `browser_open_page` (or `browser_list_tabs` to see what\'s already open).\n\n1. Use `browser_list_tabs` to check which tabs exist, or `browser_list_executors` to verify a browser is connected.\n2. Use `browser_open_page` to create the first tab - returns a tabId. You can optionally pass `url` to navigate to it immediately.\n3. Use `browser_navigate` to change the URL of an *existing* tab. Requires an active tab - use `browser_open_page` first.\n4. Use `browser_read_page` to extract page content (aria/html/text/links/smart).\n5. Use `browser_screenshot` to capture visual state when needed.\n6. Use `browser_click`, `browser_type`, `browser_hover`, and `browser_select_option` for interactions.\n7. Use `browser_run_code` to execute JavaScript for advanced extraction or interaction.\n8. Use `browser_get_console_logs` and `browser_get_network_logs` for debugging.\n9. Use `browser_set_intercept_rules` to block or redirect requests when needed.\n\n## When the page is ambiguous\n\n10. **Ask the user before guessing.** If the page state is unexpected, multiple controls plausibly match the intent, a login/2FA/CAPTCHA appears, or an irreversible action (submit, pay, delete) is about to happen, stop and ask the user with `ask_followup_question`. Always include a screenshot or a short `browser_read_page` excerpt so the question is grounded.\n\nSignal completion with `attempt_completion`, providing a concise summary of what was accomplished.',
	},
	{
		slug: "reviewer",
		name: "👀 Reviewer",
		roleDefinition:
			"You are a senior software engineer performing code review. You analyze existing code for bugs, security vulnerabilities, design issues, performance problems, and adherence to best practices. You propose specific, actionable fixes - but you NEVER implement them. Your output is diagnostic and advisory only. You read code, run analysis tools, and query observability data to inform your review.",
		whenToUse:
			"Use this mode when you need a thorough code review, want to identify potential issues, or need recommendations for improvements without making changes to the codebase.",
		description: "Review code and identify issues",
		groups: ["read", "execute", "mcp", "subtasks", "questions"],
		customInstructions:
			"When reviewing code:\n1. Read the relevant files thoroughly using read_file.\n2. Run static analysis or linting tools via execute_command when helpful.\n3. Query logs, metrics, or traces via MCP tools (Loki, Mimir, Tempo) if runtime behavior is relevant.\n4. Present findings clearly: what the issue is, why it matters, where it occurs (file:line), and a specific proposed fix.\n5. Do NOT edit any files. Do NOT use write_to_file, apply_diff, or insert_edit. Your role stops at proposing fixes.",
	},
] as const
