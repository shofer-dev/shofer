import { z } from "zod"

/**
 * Interface for follow-up data structure used in follow-up questions
 * This represents the data structure for follow-up questions that the LLM can ask
 * to gather more information needed to complete a task.
 */
export interface FollowUpData {
	/** The question being asked by the LLM */
	question?: string
	/** Array of suggested answers that the user can select */
	suggest?: Array<SuggestionItem>
	/**
	 * Typed input fields for a structured form. Used by workflow flow-parameter
	 * collection: instead of asking one free-text question per parameter, the
	 * WorkflowTask sends a single followup carrying every parameter's name,
	 * type and default. The webview renders a typed form (string→text,
	 * number→number, boolean→checkbox) and submits all answers at once as a
	 * JSON object via the normal messageResponse path. When present, the form
	 * is rendered instead of the free-text suggestion chips.
	 */
	paramForm?: Array<ParamField>
}

/** A single typed input field in a {@link FollowUpData.paramForm}. */
export interface ParamField {
	/** Parameter name (the JSON key the answer is submitted under). */
	name: string
	/** Input type — drives the rendered widget and answer coercion. */
	type: "string" | "number" | "boolean"
	/** Optional default value, used when the field is left blank. */
	default?: string | number | boolean
	/** Optional markdown description shown beneath the field label. */
	description?: string
}

/**
 * Interface for a suggestion item with optional mode switching
 */
export interface SuggestionItem {
	/** The text of the suggestion */
	answer: string
	/** Optional mode to switch to when selecting this suggestion */
	mode?: string
}

/**
 * Zod schema for SuggestionItem
 */
export const suggestionItemSchema = z.object({
	answer: z.string(),
	mode: z.string().optional(),
})

/**
 * Zod schema for ParamField
 */
export const paramFieldSchema = z.object({
	name: z.string(),
	type: z.enum(["string", "number", "boolean"]),
	default: z.union([z.string(), z.number(), z.boolean()]).optional(),
	description: z.string().optional(),
})

/**
 * Zod schema for FollowUpData
 */
export const followUpDataSchema = z.object({
	question: z.string().optional(),
	suggest: z.array(suggestionItemSchema).optional(),
	paramForm: z.array(paramFieldSchema).optional(),
})

export type FollowUpDataType = z.infer<typeof followUpDataSchema>
