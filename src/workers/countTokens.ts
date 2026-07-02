import workerpool from "workerpool"

import { Anthropic } from "@anthropic-ai/sdk"

import { tiktoken, type CountTokensResult } from "@shofer/core"

async function countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<CountTokensResult> {
	try {
		const count = await tiktoken(content)
		return { success: true, count }
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		}
	}
}

workerpool.worker({ countTokens })
