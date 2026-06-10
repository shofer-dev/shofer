/**
 * Mock API provider for functional testing.
 *
 * Registered as provider "mock". Returns canned responses so the agent loop
 * runs to completion without a real LLM. It is a faux provider (no external
 * inference, no credentials required) used to drive the scenarios in
 * `docs/test_harness.md` as automated functional tests.
 *
 * Control mechanisms (highest priority first):
 *
 *   1. MOCK_TOOL_NAME=<name> MOCK_TOOL_ARGS='<json>'
 *      Forces a single tool call (not attempt_completion) on every turn. For
 *      tests that need the agent to invoke one specific tool (e.g. read_file).
 *
 *   2. MOCK_RESPONSES_PATH=<file.json>
 *      Full multi-turn scenario file. Each scenario has a "match" (prompt
 *      substring, case-insensitive) and "turns" (one entry per createMessage
 *      call). The handler pins the matched scenario for the lifetime of the
 *      task and replays one turn per agent turn, advancing an instance-local
 *      cursor. Each turn is a high-level step the mock translates into the real
 *      streaming chunk contract (see {@link MockTurn}):
 *        { "reasoning"?, "text"?, "tool"?: { "name", "arguments" }, "response"? }
 *      A turn with "response" is shorthand for an attempt_completion call.
 *
 *   3. MOCK_RESPONSE=<text>
 *      Simple text response wrapped in an attempt_completion tool call.
 *
 *   4. Built-in defaults (substring match on the prompt).
 *
 * Usage:
 *   MOCK_RESPONSE="hello" shofer --provider mock --model mock --print "prompt"
 *   MOCK_TOOL_NAME=read_file MOCK_TOOL_ARGS='{"path":"x.json"}' shofer ...
 *   MOCK_RESPONSES_PATH=scenarios.json shofer ...
 *
 * Streaming contract: tool calls are emitted as the same `tool_call_partial`
 * sequence real providers use (initial chunk carries id+name, subsequent chunks
 * carry argument fragments), terminated by a `tool_call_end` chunk. This is what
 * `NativeToolCallParser` consumes in `Task.ts`; the older
 * `tool_call_start`/`tool_call_delta` chunks are NOT read by the agent loop.
 */

import { Anthropic } from "@anthropic-ai/sdk"
import fs from "fs"
import { z } from "zod"

import type { ModelInfo } from "@shofer/types"

import type { ApiHandler, SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import type { ApiHandlerOptions } from "../../shared/api"
import { ApiStream } from "../transform/stream"

// ── Scenario schema ────────────────────────────────────────────────
// On-disk scenario files are validated with Zod so a corrupt or stale file
// fails closed (falls back to the built-in scenarios) rather than throwing
// from a type assertion.

const mockToolSchema = z.object({
	name: z.string(),
	/** Either a pre-serialized JSON string or an object that will be stringified. */
	arguments: z.union([z.record(z.unknown()), z.string()]).optional(),
})

const mockTurnSchema = z.object({
	reasoning: z.string().optional(),
	text: z.string().optional(),
	tool: mockToolSchema.optional(),
	/** Shorthand for an attempt_completion tool call with this result text. */
	response: z.string().optional(),
})

const mockScenarioSchema = z.object({
	/** Substring to match in the user prompt (case-insensitive). */
	match: z.string(),
	/** Text response for single-turn scenarios (wrapped in attempt_completion). */
	response: z.string().optional(),
	/** Multi-turn steps; one entry replayed per createMessage call. */
	turns: z.array(mockTurnSchema).optional(),
})

const mockConfigSchema = z.object({
	scenarios: z.array(mockScenarioSchema),
})

type MockTurn = z.infer<typeof mockTurnSchema>
type MockScenario = z.infer<typeof mockScenarioSchema>
type MockConfig = z.infer<typeof mockConfigSchema>

type MockToolArguments = z.infer<typeof mockToolSchema>["arguments"]

// ── Built-in defaults ──────────────────────────────────────────────

const BUILT_IN_SCENARIOS: MockScenario[] = [
	{ match: "DEEPSEEK_OK", response: "DEEPSEEK_OK" },
	{ match: "2+2", response: "4" },
	{ match: "STREAM_OK", response: "STREAM_OK" },
	{ match: "STORED", response: "STORED" },
	{ match: "EPHEMERAL_OK", response: "EPHEMERAL_OK" },
	{ match: "API_OK", response: "API_OK" },
	{ match: "TASK_ONE", response: "TASK_ONE" },
	{ match: "TASK_TWO", response: "TASK_TWO" },
	{ match: "EXPORT_TEST", response: "EXPORT_TEST" },
	{ match: "SUBTASK_OK", response: "SUBTASK_OK" },
	{ match: "SESSION_MARKER", response: "SESSION_MARKER" },
	{ match: "SELECTOR_TEST", response: "SELECTOR_TEST" },
	{ match: "BANANA", response: "BANANA" },
	{ match: "SHELL_OK", response: "SHELL_OK" },
	{ match: "WRITE_OK", response: "WRITE_OK" },
	{ match: "WORKFLOW_OK", response: "WORKFLOW_OK" },
	{ match: "42", response: "42" },
	{ match: "Hello", response: "Hello! Mock assistant here." },
	{ match: "number", response: "42" },

	// ── Mode exercises ────────────────────────────────────────────────────────
	{
		match: "what an architect agent does differently from a code agent",
		response:
			"An architect agent plans, designs, and strategizes before implementation, breaking down complex problems into specifications — unlike a code agent which directly writes and modifies code.",
	},

	// ── CLI tool-exercising scenarios ─────────────────────────────────────────
	//
	// Multi-turn scenarios for the tool-use CLI cases (test_harness.md scenarios
	// 10/11/12/20). Turn 1 emits the real `tool_call_partial` contract so the
	// agent actually executes the tool; the final turn emits attempt_completion.
	// Tool arguments are static, so the prompts in test_harness.md use fixed
	// paths/commands that match the values below verbatim. Each `match` is the
	// most-specific prefix of its prompt so it always shadows the bare marker
	// scenarios above (e.g. "WRITE_OK", "SHELL_OK", "SUBTASK_OK").

	// Scenario 10 — read_file: read the extension package.json, report `name`.
	{
		match: "Read the file extensions/shofer/package.json",
		turns: [
			{ tool: { name: "read_file", arguments: { path: "extensions/shofer/package.json" } } },
			{ response: "shofer-code" },
		],
	},

	// Scenario 11 — execute_command: run a shell command and report its output.
	{
		match: "Run the shell command 'echo SHELL_OK'",
		turns: [
			{ tool: { name: "execute_command", arguments: { command: "echo SHELL_OK" } } },
			{ response: "SHELL_OK" },
		],
	},

	// Scenario 12 — write_to_file then read it back. Fixed path so the static
	// tool arguments below match the path baked into the prompt.
	{
		match: "Write the text 'WRITE_OK' to the file",
		turns: [
			{ tool: { name: "write_to_file", arguments: { path: "/tmp/shofer_write_test.txt", content: "WRITE_OK" } } },
			{ tool: { name: "read_file", arguments: { path: "/tmp/shofer_write_test.txt" } } },
			{ response: "confirmed=WRITE_OK" },
		],
	},

	// Scenario 20 — new_task: spawn a blocking foreground subtask. The subtask's
	// own MockHandler pins to the "SUBTASK_OK" scenario above and completes; the
	// parent then reports the result.
	{
		match: "Spawn a subtask",
		turns: [
			{
				tool: {
					name: "new_task",
					arguments: { mode: "code", message: "Reply with: SUBTASK_OK", is_background: "false" },
				},
			},
			{ response: "PARENT_GOT: SUBTASK_OK" },
		],
	},

	// ── Workflow conformance scenarios ────────────────────────────────────────
	//
	// These cover all _* slang workflow test flows so they run against the mock
	// provider with no real LLM. Matches are ordered most-specific first so a
	// more generic pattern never shadows a specific one.
	//
	// All patterns match against the user-message content produced by
	// buildStakePrompt: "Execute: <op>\nArguments: {...}\nOUTPUT CONTRACT:\n  - field: type\n..."

	// _question-relay — Researcher must call ask_followup_question before
	// producing findings. Multi-turn: turn 1 emits the tool call (the harness
	// auto-answers from followupQueue), turn 2 emits attempt_completion.
	{
		match: "Before you do ANY research",
		turns: [
			{
				tool: {
					name: "ask_followup_question",
					arguments: {
						question: "What specific aspect of this topic should I focus on?",
						follow_up: [
							{ text: "Focus on basics", mode: null },
							{ text: "Focus on advanced topics", mode: null },
						],
					},
				},
			},
			{ response: '{"findings":"Key finding 1. Key finding 2. Key finding 3."}' },
		],
	},

	// _output-schema — Worker must return JSON matching { summary, confidence, tags }.
	{ match: "- summary: string", response: '{"summary":"Test summary of the topic.","confidence":0.9,"tags":"test"}' },

	// _peer-messaging — Researcher produces findings JSON (send_message_to_task
	// to the Writer is optional per the role; skipping it is valid).
	{ match: "Execute: produce_findings", response: '{"findings":"Finding 1. Finding 2. Finding 3."}' },

	// _peer-messaging / _question-relay — Writer produces article JSON.
	{ match: "- article: string", response: '{"article":"A concise article about the requested topic."}' },

	// _peer-messaging — Coordinator finalize stake (no output contract).
	{ match: "Execute: finalize", response: "Combined result: research and article complete." },

	// _expressions — match on unique output contract fields (eq/neq/gt/…/contains).
	{
		match: "- eq: boolean",
		response: '{"eq":true,"neq":true,"gt":true,"gte":true,"lt":true,"lte":true,"and":true,"contains":true}',
	},

	// _let-set — match on unique output contract field { value: number, flag: boolean }.
	{ match: "- value: number", response: '{"value":1,"flag":true}' },

	// _when-otherwise — match on unique output contract field { approved: boolean, … }.
	{ match: "- approved: boolean", response: '{"approved":true,"rejected":false}' },

	// _repeat-until — match on unique output contract field { iteration: number }.
	// The loop terminates in one iteration: `set counter = 1; when counter > 0 { set done = true }`.
	{ match: "- iteration: number", response: '{"iteration":1}' },

	// _list-arg — match on unique output contract field { result: string, tags_used: number }.
	{ match: "- result: string", response: '{"result":"processed","tags_used":2}' },

	// Catch-all for any Execute: stake. Returns a generic JSON object
	// matching the `output: { result: "string" }` contract used by most
	// conformance fixtures. Specific patterns above shadow this for
	// fixtures with unique field names.
	{ match: "Execute:", response: '{"result":"step completed"}' },
]

// ── Scenario loading ───────────────────────────────────────────────
// The scenario file is immutable test input, so the parsed config is cached at
// module scope. Per-task replay state lives on the handler instance instead.

let cachedConfig: MockConfig | undefined

function loadConfig(): MockConfig {
	if (cachedConfig) {
		return cachedConfig
	}

	const path = process.env.MOCK_RESPONSES_PATH
	if (path && fs.existsSync(path)) {
		try {
			const parsed = mockConfigSchema.safeParse(JSON.parse(fs.readFileSync(path, "utf-8")))
			if (parsed.success) {
				cachedConfig = parsed.data
				return cachedConfig
			}
		} catch {
			// Malformed JSON — fall through to built-in scenarios.
		}
	}

	cachedConfig = { scenarios: BUILT_IN_SCENARIOS }
	return cachedConfig
}

function findScenario(prompt: string): MockScenario | undefined {
	const cfg = loadConfig()
	const lower = prompt.toLowerCase()
	// Prefer the most specific (longest) match.
	const sorted = [...cfg.scenarios].sort((a, b) => b.match.length - a.match.length)
	return sorted.find((s) => lower.includes(s.match.toLowerCase()))
}

// ── Prompt extraction ──────────────────────────────────────────────

function lastUserMessage(messages: Anthropic.Messages.MessageParam[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role !== "user") continue
		const content = msg.content
		if (typeof content === "string") return content
		if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && "text" in block && typeof block.text === "string") {
					if (block.text.startsWith("<user_message>")) {
						// Extract just the user message from the Shofer wrapper
						const m = block.text.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/)
						if (m) return m[1]
					}
					return block.text
				}
			}
			const toolResults = content.filter(
				(b): b is Anthropic.ToolResultBlockParam =>
					typeof b === "object" && b !== null && "type" in b && b.type === "tool_result",
			)
			if (toolResults.length > 0) {
				const tr = toolResults[0]
				if (typeof tr.content === "string") return tr.content
				if (Array.isArray(tr.content)) {
					for (const c of tr.content) {
						if (typeof c === "object" && "text" in c && typeof c.text === "string") return c.text
					}
				}
			}
		}
	}
	return ""
}

function toolCallId(): string {
	return `toolu_${Math.random().toString(36).slice(2, 11)}`
}

function serializeArgs(args: MockToolArguments | string | undefined): string {
	if (typeof args === "string") return args
	if (args === undefined) return "{}"
	return JSON.stringify(args)
}

// ── Provider ───────────────────────────────────────────────────────

export class MockHandler implements ApiHandler, SingleCompletionHandler {
	private modelId = "mock-model"

	// Per-task replay state. Each Task constructs its own ApiHandler, so the
	// matched scenario is pinned on the first turn and the cursor advances across
	// the subsequent createMessage calls of the same task.
	private scenario: MockScenario | undefined
	private pinned = false
	private turnCursor = 0

	constructor(_options: ApiHandlerOptions) {}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.modelId,
			info: {
				supportsPromptCache: false,
				supportsImages: false,
				maxTokens: 4096,
				contextWindow: 128_000,
				inputPrice: 0,
				outputPrice: 0,
				description: "Mock provider for functional testing",
			},
		}
	}

	/** Emit a tool call as the real streaming `tool_call_partial` contract. */
	private async *streamToolCall(name: string, argsJson: string): ApiStream {
		const id = toolCallId()
		yield { type: "tool_call_partial", index: 0, id, name, arguments: undefined }
		for (let i = 0; i < argsJson.length; i += 24) {
			yield {
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: argsJson.slice(i, i + 24),
			}
		}
		yield { type: "tool_call_end", id }
	}

	/** Emit an attempt_completion tool call carrying `text` as its result. */
	private async *emitCompletion(text: string): ApiStream {
		const argsJson = JSON.stringify({ result: text, rating: "well" })
		yield* this.streamToolCall("attempt_completion", argsJson)
		yield {
			type: "usage",
			inputTokens: 100,
			outputTokens: text.split(/\s+/).length + 5,
			totalCost: 0,
		}
	}

	/** Translate one high-level scenario turn into provider chunks. */
	private async *emitTurn(turn: MockTurn): ApiStream {
		if (turn.reasoning) {
			yield { type: "reasoning", text: turn.reasoning }
		}
		if (turn.text) {
			yield { type: "text", text: turn.text }
		}

		if (turn.tool) {
			yield* this.streamToolCall(turn.tool.name, serializeArgs(turn.tool.arguments))
			yield { type: "usage", inputTokens: 100, outputTokens: 10, totalCost: 0 }
			return
		}

		if (turn.response !== undefined) {
			yield* this.emitCompletion(turn.response)
			return
		}

		// Text-only turn with no tool: still emit usage so the stream terminates.
		yield { type: "usage", inputTokens: 100, outputTokens: 10, totalCost: 0 }
	}

	async *createMessage(
		_systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		_metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const prompt = lastUserMessage(messages)

		// ── Level 1: MOCK_TOOL_NAME + MOCK_TOOL_ARGS env vars ──
		const toolName = process.env.MOCK_TOOL_NAME
		if (toolName) {
			yield* this.streamToolCall(toolName, serializeArgs(process.env.MOCK_TOOL_ARGS))
			yield { type: "usage", inputTokens: 100, outputTokens: 10, totalCost: 0 }
			return
		}

		// Pin the scenario on the first turn so multi-turn replays stay coherent
		// even though later prompts contain tool results instead of the match.
		if (!this.pinned) {
			this.scenario = findScenario(prompt)
			this.pinned = true
		}
		const scenario = this.scenario

		// ── Level 2: Multi-turn scenario ──
		if (scenario?.turns && this.turnCursor < scenario.turns.length) {
			const turn = scenario.turns[this.turnCursor]
			this.turnCursor++
			yield* this.emitTurn(turn)
			return
		}

		// ── Level 3: MOCK_RESPONSE / built-in text → attempt_completion ──
		const responseText = process.env.MOCK_RESPONSE ?? scenario?.response ?? "OK"
		yield* this.emitCompletion(responseText)
	}

	async countTokens(_content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		return 0
	}

	async completePrompt(prompt: string): Promise<string> {
		const envResponse = process.env.MOCK_RESPONSE
		if (envResponse) return envResponse
		const scenario = findScenario(prompt)
		return scenario?.response ?? "OK"
	}
}
