import * as os from "os"
import * as path from "path"

import type { Anthropic } from "@anthropic-ai/sdk"
import type { ProviderSettings } from "@shofer/types"
import { createInMemoryHost, setHost } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import type { ApiStreamChunk } from "../../../api/transform/stream.js"
import { Task } from "../../Task.js"

/**
 * A scripted provider stream plus a fake persistence/provider surface, sized to
 * drive `Task`'s real agent loop.
 *
 * Every other Task suite in this package stubs `attemptApiRequest` or
 * `getSystemPrompt` outright, which is why the loop itself has stayed dark:
 * a stub proves the caller's branch and nothing about what the request
 * actually does. This harness goes the other way — the LLM is the ONLY thing
 * faked, and it is faked at the narrowest possible seam (`ApiHandler`), so
 * everything between "a turn starts" and "the bytes leave" is production code:
 * the system prompt is really assembled, the tool array is really built and
 * cached, context management really runs, the wire request is really
 * snapshotted.
 *
 * The mocks a spec still has to declare itself (vitest hoists `vi.mock` per
 * file, so they cannot live here) are the ones that would otherwise touch the
 * machine: `ShoferIgnoreController` (a real file watcher), `../../utils/storage.js`
 * (real storage paths), `fs/promises`, and `delay` (so backoff countdowns do
 * not actually wait). See any of the sibling specs for the block to copy.
 */

/** What a scripted turn hands back, in the order the provider would. */
export type ScriptedTurn =
	| { chunks: ApiStreamChunk[] }
	/** Throw instead of yielding — the first-chunk failure path. */
	| { throws: unknown }
	/** Yield some chunks, then fail mid-stream. */
	| { chunks: ApiStreamChunk[]; thenThrows: unknown }
	/** Never produce a first chunk — the window a user's Stop press lands in. */
	| { hangs: true }

export interface ScriptedApiOptions {
	modelId?: string
	info?: Record<string, unknown>
	/** Token count returned by `countTokens` (drives the context-management gate). */
	tokenCount?: number
}

export interface ScriptedApi {
	/** The `ApiHandler`-shaped object to install on a task. */

	handler: any
	/** One entry per `createMessage` call: the arguments it was given. */
	calls: Array<{ systemPrompt: string; messages: unknown[]; metadata: Record<string, unknown> }>
}

/** The sentinel a run past the end of the script throws. */
const SCRIPT_EXHAUSTED = () =>
	Object.assign(new Error("scripted turns exhausted"), { status: 401, name: "ScriptExhausted" })

/** True when `error` is the harness's end-of-script sentinel. */
export function scriptedTurnsExhausted(error: unknown): boolean {
	return error instanceof Error && error.name === "ScriptExhausted"
}

const DEFAULT_MODEL_INFO = {
	maxTokens: 4096,
	contextWindow: 200_000,
	supportsImages: false,
	supportsPromptCache: false,
	inputPrice: 1,
	outputPrice: 2,
}

/**
 * Build an `ApiHandler` that replays `turns`, one per `createMessage` call.
 *
 * Running PAST the end of the script throws a 401-shaped error on purpose.
 * The agent loop retries a tool-free reply by pushing the "you did not use a
 * tool" nudge back onto its own stack, so a script that simply ran out would
 * spin forever; a NON-RETRYABLE status is the one failure the loop refuses to
 * retry, so it unwinds immediately and the test sees exactly the turns it
 * scripted. `scriptedTurnsExhausted()` recognises it.
 */
export function scriptedApi(turns: ScriptedTurn[], opts: ScriptedApiOptions = {}): ScriptedApi {
	const calls: ScriptedApi["calls"] = []
	let index = 0

	const handler = {
		getModel: () => ({ id: opts.modelId ?? "test-model", info: { ...DEFAULT_MODEL_INFO, ...(opts.info ?? {}) } }),
		countTokens: vi.fn(async () => opts.tokenCount ?? 0),
		createMessage: vi.fn(function (
			systemPrompt: string,
			messages: Anthropic.Messages.MessageParam[],
			metadata: Record<string, unknown>,
		) {
			calls.push({ systemPrompt, messages, metadata })
			const turn = turns[index++]
			return (async function* () {
				if (!turn) {
					throw SCRIPT_EXHAUSTED()
				}
				if ("hangs" in turn) {
					await new Promise<never>(() => {})
					return
				}
				if ("throws" in turn) {
					throw turn.throws
				}
				for (const chunk of turn.chunks) {
					yield chunk
				}
				if ("thenThrows" in turn) {
					throw turn.thenThrows
				}
			})()
		}),
	}

	return { handler, calls }
}

export type FakeProvider = any

export interface MakeProviderOptions {
	/** Merged into what `getState()` resolves with. */
	state?: Record<string, unknown>
	/** History rows keyed by task id, for `getTaskWithId`. */
	history?: Record<string, Record<string, unknown>>
	overrides?: Record<string, unknown>
}

/** A `TaskProviderLike`-shaped fake with spies on everything a turn touches. */
export function makeProvider(opts: MakeProviderOptions = {}): FakeProvider {
	const { state = {}, history = {}, overrides = {} } = opts
	const storageUri = { fsPath: path.join(os.tmpdir(), "shofer-scripted-task") }

	return {
		context: { globalStorageUri: storageUri, extensionPath: "/ext", extensionUri: storageUri },
		getState: vi.fn().mockResolvedValue(state),
		log: vi.fn(),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postTaskStateUpdate: vi.fn(),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		getMcpHub: vi.fn().mockReturnValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue([]),
		getTaskWithId: vi.fn(async (id: string) => {
			const row = history[id]
			if (!row) throw new Error(`no such task ${id}`)
			return { historyItem: { id, ...row } }
		}),
		...overrides,
	}
}

export const BASE_API_CONFIG: ProviderSettings = {
	apiProvider: "anthropic",
	apiModelId: "claude-3-5-sonnet-20241022",
	apiKey: "test-api-key",
}

export interface MakeScriptedTaskOptions {
	provider?: FakeProvider
	apiConfiguration?: ProviderSettings
	/** Turns the fake LLM replays, in order. */
	turns?: ScriptedTurn[]
	api?: ScriptedApiOptions
	/** Extra `Task` constructor options (parentTask, agentContext, …). */

	taskOptions?: Record<string, any>
}

export interface ScriptedTask {
	task: Task
	provider: FakeProvider
	api: ScriptedApi
}

/**
 * Construct an unstarted `Task` wired to a scripted LLM. `startTask: false`
 * means nothing runs until a test calls the method it is exercising.
 */
export function makeScriptedTask(opts: MakeScriptedTaskOptions = {}): ScriptedTask {
	const provider = opts.provider ?? makeProvider()
	const api = scriptedApi(opts.turns ?? [], opts.api)

	const task = new Task({
		provider,
		apiConfiguration: opts.apiConfiguration ?? BASE_API_CONFIG,
		task: "do a thing",
		startTask: false,
		...(opts.taskOptions ?? {}),
	} as never)

	// The one faked seam: everything upstream of the provider client is real.
	;(task as never as { api: unknown }).api = api.handler

	return { task, provider, api }
}

/** Install the in-memory host and a telemetry instance. Call from `beforeEach`. */
export function resetScriptedEnvironment(): void {
	setHost(createInMemoryHost())
	if (!TelemetryService.hasInstance()) {
		TelemetryService.createInstance([])
	}
}

/** Collect an async iterable into an array. */
export async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const chunk of stream) out.push(chunk)
	return out
}

/** The `say` calls a task made, as `[type, text]` pairs. */

export function sayCalls(task: Task): Array<[string, string | undefined]> {
	const say = task.say as unknown as { mock?: { calls: any[][] } }
	if (!say.mock) throw new Error("task.say is not a spy — wrap it with vi.spyOn first")
	return say.mock.calls.map((c) => [c[0], c[1]])
}
