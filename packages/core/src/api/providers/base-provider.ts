import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@shofer/types"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../api-handler-types.js"
import { ApiStream, countTokens, isMcpTool } from "./_deps.js"

/**
 * Base class for API providers that implements common functionality.
 */
export abstract class BaseProvider implements ApiHandler {
	abstract createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	abstract getModel(): { id: string; info: ModelInfo }

	/**
	 * Converts an array of tools to be compatible with OpenAI's strict mode.
	 * Filters for function tools, applies schema conversion to their parameters,
	 * and ensures all tools have consistent strict: true values.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected convertToolsForOpenAI(tools: any[] | undefined): any[] | undefined {
		if (!tools) {
			return undefined
		}

		return tools.map((tool) => {
			if (tool.type !== "function") {
				return tool
			}

			// MCP tools use the 'mcp--' prefix - disable strict mode for them
			// to preserve optional parameters from the MCP server schema
			const isMcp = isMcpTool(tool.function.name)

			return {
				...tool,
				function: {
					...tool.function,
					strict: !isMcp,
					parameters: isMcp
						? tool.function.parameters
						: this.convertToolSchemaForOpenAI(tool.function.parameters),
				},
			}
		})
	}

	/**
	 * The OpenAI-shaped tool parameters for one request — or NOTHING at all.
	 *
	 * A turn can legitimately carry no tools: `toolCallingEnabled === false`
	 * makes the turn conversational and the tool array empty. The parameters
	 * must then be OMITTED rather than sent as `undefined`/`true`, because
	 * `tool_choice` and `parallel_tool_calls` are only valid alongside a
	 * non-empty `tools`, and sending them bare is a 400 from most OpenAI-
	 * compatible endpoints.
	 *
	 * Spread the result into the request body so absent keys never serialize.
	 */
	protected openAiToolParams(metadata?: ApiHandlerCreateMessageMetadata): {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		tools?: any[]
		tool_choice?: ApiHandlerCreateMessageMetadata["tool_choice"]
		parallel_tool_calls?: boolean
	} {
		const tools = this.convertToolsForOpenAI(metadata?.tools)

		if (!tools || tools.length === 0) {
			return {}
		}

		return {
			tools,
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}
	}

	/**
	 * Converts tool schemas to be compatible with OpenAI's strict mode by:
	 * - Ensuring all properties are in the required array (strict mode requirement)
	 * - Converting nullable types (["type", "null"]) to non-nullable ("type")
	 * - Adding additionalProperties: false to all object schemas (required by OpenAI Responses API)
	 * - Recursively processing nested objects and arrays
	 *
	 * This matches the behavior of ensureAllRequired in openai-native.ts
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected convertToolSchemaForOpenAI(schema: any): any {
		if (!schema || typeof schema !== "object" || schema.type !== "object") {
			return schema
		}

		const result = { ...schema }

		// OpenAI Responses API requires additionalProperties: false on all object schemas
		// Only add if not already set to false (to avoid unnecessary mutations)
		if (result.additionalProperties !== false) {
			result.additionalProperties = false
		}

		if (result.properties) {
			const allKeys = Object.keys(result.properties)
			// OpenAI strict mode requires ALL properties to be in required array
			result.required = allKeys

			// Recursively process nested objects and convert nullable types
			const newProps = { ...result.properties }
			for (const key of allKeys) {
				const prop = newProps[key]

				// Handle nullable types by removing null
				if (prop && Array.isArray(prop.type) && prop.type.includes("null")) {
					const nonNullTypes = prop.type.filter((t: string) => t !== "null")
					prop.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes
				}

				// Drop JSON `null` entries from an enum. A null enum value is malformed
				// for every OpenAI-compatible provider, and Moonshot/Kimi rejects the
				// whole request (`enum value (<nil>) does not match any type`). Cheap,
				// universal insurance; provider-specific subsets (e.g. Moonshot's) still
				// apply their own fuller normalization on top.
				if (prop && Array.isArray(prop.enum) && prop.enum.includes(null)) {
					prop.enum = prop.enum.filter((v: unknown) => v !== null)
				}

				// Recursively process nested objects
				if (prop && prop.type === "object") {
					newProps[key] = this.convertToolSchemaForOpenAI(prop)
				} else if (prop && prop.type === "array" && prop.items?.type === "object") {
					newProps[key] = {
						...prop,
						items: this.convertToolSchemaForOpenAI(prop.items),
					}
				}
			}
			result.properties = newProps
		}

		return result
	}

	/**
	 * Default token counting implementation using tiktoken.
	 * Providers can override this to use their native token counting endpoints.
	 *
	 * @param content The content to count tokens for
	 * @returns A promise resolving to the token count
	 */
	async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		if (content.length === 0) {
			return 0
		}

		return countTokens(content)
	}
}
