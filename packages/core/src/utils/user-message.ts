/**
 * The `<user_message>` wrapper — built and read back in one place.
 *
 * Shofer wraps the human's words in `<user_message>…</user_message>` when it
 * assembles a turn, and appends `<environment_details>` as a sibling text block.
 * Both are part of the PROMPT the model reads, so neither may be dropped,
 * reordered or re-spelled. The cost lands on whoever later has to tell the
 * human's own words apart from the scaffolding around them — historically a
 * regex in a downstream transcript reader, pattern-matching markup it did not
 * own and could not keep in step.
 *
 * This module removes the guessing by making the wrapper structural on OUR side:
 * {@link humanMessageBlock} builds the block and MARKS it, and
 * {@link humanTextOfLastMessage} reads the mark back. The Shofer provider ships
 * the recovered text alongside the request (as the `human_text` field llm-router
 * records beside the verbatim content), so a transcript reader looks up a field
 * instead of matching a pattern. Nothing about the request the model receives
 * changes.
 *
 * # Why the mark is a Symbol
 *
 * A symbol-keyed property is invisible to `JSON.stringify`, so it can reach
 * neither a provider's wire format nor the persisted `apiConversationHistory`:
 * the bytes the model is sent are exactly what they were before this module
 * existed, for every provider and not just the Shofer one. It IS copied by
 * object spread (`{...block}`), which is how every in-process transform on the
 * path rebuilds blocks (mention expansion, blob-ref resolution, consecutive
 * message merging), so the mark survives from assembly to the API handler. The
 * trade: a block reloaded from disk has lost its mark. That costs nothing —
 * only the turn being sent right now carries fresh human text, and that block is
 * always built in-process.
 *
 * # Note on the wrapper's own text
 *
 * The wrapped block is NOT necessarily `OPEN + human + CLOSE` by the time it is
 * sent: mention expansion rewrites the text inside the tags (`@file` becomes a
 * clean path) and APPENDS sections after the closing tag
 * (`<workspace_diagnostics>`, `<git_working_state>`, …). So the human segment is
 * read as "between the opening tag and the FIRST closing tag", and what is
 * recovered is the post-expansion text — which is what the model actually read,
 * and therefore what an honest transcript should show.
 */

import type { Anthropic } from "@anthropic-ai/sdk"

/** The opening tag, including the newline that follows it. */
export const USER_MESSAGE_OPEN = "<user_message>\n"

/** The closing tag, including the newline that precedes it. */
export const USER_MESSAGE_CLOSE = "\n</user_message>"

/**
 * Marks a text block as the wrapped human message. `Symbol.for` (rather than a
 * fresh symbol) so two copies of this module — a bundled one and a linked one —
 * still recognise each other's marks.
 */
const HUMAN_MESSAGE_MARK = Symbol.for("shofer.humanMessage")

/** A text block carrying the human's own words, marked as such. */
export type HumanMessageBlock = Anthropic.Messages.TextBlockParam & {
	readonly [HUMAN_MESSAGE_MARK]?: true
}

/** The prompt text for a human turn: the words as the model will read them. */
export function wrapUserMessage(text: string): string {
	return `${USER_MESSAGE_OPEN}${text}${USER_MESSAGE_CLOSE}`
}

/** Builds the marked content block for a human turn. */
export function humanMessageBlock(text: string): HumanMessageBlock {
	return { type: "text", text: wrapUserMessage(text), [HUMAN_MESSAGE_MARK]: true }
}

/**
 * The human's own words inside a marked block, or `undefined` for any block this
 * module did not build.
 *
 * Fails closed: an unmarked block, a block whose text no longer opens with the
 * wrapper, and a block with no closing tag all yield `undefined` rather than a
 * guess. Nothing downstream has to trust a heuristic.
 */
export function humanTextOfBlock(block: unknown): string | undefined {
	if (block === null || typeof block !== "object") {
		return undefined
	}
	const candidate = block as Record<PropertyKey, unknown>
	if (candidate[HUMAN_MESSAGE_MARK] !== true) {
		return undefined
	}
	const text = candidate.text
	if (typeof text !== "string" || !text.startsWith(USER_MESSAGE_OPEN)) {
		return undefined
	}
	const end = text.indexOf(USER_MESSAGE_CLOSE, USER_MESSAGE_OPEN.length)
	if (end < 0) {
		return undefined
	}
	return text.slice(USER_MESSAGE_OPEN.length, end)
}

/**
 * The human's own words in the LAST message of a request, or `undefined` when
 * that message carries none — a tool-result round, an environment refresh, a
 * protocol nudge.
 *
 * The last message is the one that matters because it is the turn's stimulus:
 * it is what a transcript recorder keys on, and the only message that can carry
 * words typed since the previous request.
 */
export function humanTextOfLastMessage(messages: readonly Anthropic.Messages.MessageParam[]): string | undefined {
	const last = messages[messages.length - 1]
	if (!last || last.role !== "user" || !Array.isArray(last.content)) {
		return undefined
	}
	for (const block of last.content) {
		const human = humanTextOfBlock(block)
		if (human !== undefined) {
			return human
		}
	}
	return undefined
}
