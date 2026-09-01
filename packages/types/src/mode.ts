import { z } from "zod"

import { toolGroupNameSchema } from "./tool.js"

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
 * GroupScope — per-group tool allow/deny lists within a mode's tools array.
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
	.refine((obj) => toolGroupNameSchema.safeParse(Object.keys(obj)[0]).success, {
		message: "Scoped group entry key must be a valid group name",
	})

/**
 * A group entry names a category by SLUG, not by membership in a closed enum: a
 * mode may list a dynamic category (`salesforce`) exactly as it lists a builtin.
 * A name matching no category simply matches no tools — which is also what a
 * typo now does, since the schema wall that used to reject one is gone.
 */
export const groupEntrySchema = z.union([
	toolGroupNameSchema,
	z.tuple([toolGroupNameSchema, groupOptionsSchema]),
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
/**
 * Mode-slug regex. Accepts either a **natural** slug (`deploy`) — used by built-in,
 * global, and project modes — or a **qualified** plugin slug (`<pluginName>:<slug>`,
 * e.g. `live-memory:verifier`) with a single `:` separator. Plugin-contributed modes
 * are namespaced under their plugin name so a plugin can never silently shadow a
 * built-in or another plugin's mode (design §14.7 → namespacing). Both segments allow
 * only letters, numbers, and dashes.
 */
export const MODE_SLUG_REGEX = /^[a-zA-Z0-9-]+(:[a-zA-Z0-9-]+)?$/

export const modeConfigObjectSchema = z.object({
	slug: z.string().regex(MODE_SLUG_REGEX, "Slug must contain only letters numbers and dashes"),
	name: z.string().min(1, "Name is required"),
	roleDefinition: z.string().min(1, "Role definition is required"),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
	tools: groupEntryArraySchema.optional(),
	tools_allowed: z.array(z.string()).optional(),
	tools_denied: z.array(z.string()).optional(),
	/**
	 * PRESENTATION tier, orthogonal to the three admission fields above: which of
	 * the tools this mode admits are sent to the model with their **full**
	 * parameter schema. Every other admitted tool — native, MCP or plugin — is
	 * declared as a STUB (name, one-line description, permissive parameters) and
	 * the model recovers its real contract on demand with `describe_tools`.
	 *
	 * Absent ⇒ no tiering: every admitted tool carries its full schema, exactly as
	 * before this field existed. Present (including `[]`) ⇒ tiering is on, and
	 * `describe_tools` is added to the mode and always carries its full schema.
	 *
	 * An ALLOW-list rather than a stub-list because the admitted set grows on its
	 * own — an MCP catalog gains a tool, a plugin contributes one — and a
	 * stub-list would silently let each newcomer back into the full-schema tier.
	 * Here a newcomer arrives as a stub, which costs a `describe_tools` round trip
	 * and nothing else. Names are matched exactly as the model sees them, so an
	 * MCP tool is named `mcp--<server>--<tool>`. Denial still wins: a name listed
	 * here that the mode does not admit stays absent.
	 */
	tools_full_schema: z.array(z.string()).optional(),
	source: z.enum(["global", "project", "plugin"]).optional(),
	/**
	 * When `source === "plugin"`, the name of the plugin that contributed this
	 * mode (attribution shown in the UI as `plugin:<pluginName>`). Unset for
	 * built-in / global / project modes.
	 */
	pluginName: z.string().optional(),
	/**
	 * A **private** (internal) contribution — registered and switch-able by its
	 * qualified slug, but hidden from every user-facing surface (the mode
	 * selector/picker and the Plugins settings panel). Primarily set by a plugin
	 * (e.g. a browser plugin's `verifier` mode the agent runs but the user never
	 * picks); a private mode still governs its subtask's tools once switched into.
	 * Absent/false ⇒ a normal, user-visible mode.
	 */
	private: z.boolean().optional(),
	provider: z.string().optional(),
})

export const modeConfigSchema = modeConfigObjectSchema.refine(
	(data) => data.tools !== undefined || data.tools_allowed !== undefined,
	{ message: "Either 'tools' or 'tools_allowed' must be provided" },
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
