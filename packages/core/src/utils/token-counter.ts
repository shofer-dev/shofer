import type { Anthropic } from "@anthropic-ai/sdk"

import { tiktoken } from "./tiktoken.js"

/**
 * A token counter takes an array of Anthropic content blocks and returns the
 * (approximate) token count for them.
 */
export type TokenCounter = (content: Anthropic.Messages.ContentBlockParam[]) => Promise<number>

// The default counter is the portable, synchronous `tiktoken` implementation.
// Hosts that can offload token counting (e.g. the VS Code extension's worker
// pool) register a replacement via `setTokenCounter` at activation time.
let counter: TokenCounter = tiktoken

/**
 * Register the token counter used by `countTokens`.
 *
 * The VS Code extension registers a worker-backed counter so token counting is
 * offloaded off the main thread; headless callers keep the portable `tiktoken`
 * default.
 */
export function setTokenCounter(fn: TokenCounter): void {
	counter = fn
}

/** Restore the portable `tiktoken` default. Primarily for tests. */
export function resetTokenCounter(): void {
	counter = tiktoken
}

/**
 * Count tokens for the given content blocks using the registered counter.
 * Defaults to the portable `tiktoken` implementation.
 */
export function countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
	return counter(content)
}
