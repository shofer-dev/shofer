/**
 * Per-REQUEST transport headers for model API calls — the seam that lets a
 * plugin hand one LLM request a header the provider's client could not carry.
 *
 * This is the LLM-side twin of `services/mcp/call-headers.ts`, and everything
 * below mirrors it on purpose: two seams that answer the same question in two
 * shapes would drift, and a plugin author should be able to read one and know
 * the other.
 *
 * # Why a client-level header is not enough
 *
 * `buildApiHandler` constructs a provider handler — and with it the SDK client
 * that owns the connection — ONCE, out of an API configuration, and that handler
 * is then reused for every request the profile serves. Its `defaultHeaders` are
 * therefore the HOST's, fixed for the process's life. They cannot express a value
 * that belongs to the RUN: a short-lived credential re-minted per run, or a
 * correlation header whose value changes with every request. Nothing else on this
 * boundary is per-run either — the only per-request fact a provider carries today
 * is whatever it chooses to put in the request BODY (the `shofer` provider's
 * `task_id`, requesty's `trace_id`), which is not a header and is not generic.
 *
 * # The seam, and why it is a broadcast
 *
 * `@shofer/core` must not learn what such a header is, where it comes from, or
 * which profiles deserve one — that is deployment knowledge, and the Core
 * Self-Sufficiency Rule keeps it out. So core asks the same way it asks where a
 * task should run: `pluginRegistry.requestAll("resolve-model-call-headers", …)`,
 * the established broadcast for "core needs a fact a FEATURE owns, without
 * knowing which plugin (if any) provides it" — the shape `resolve-task-cwd`,
 * `resolve-task-placement`, `task-stats` and `resolve-mcp-call-headers` already
 * use. With no plugin answering, the merge is empty, no header is added, and the
 * request is byte-for-byte the one that went out before this existed.
 *
 * As with the MCP seam there is **no error channel**: a plugin that cannot
 * produce a header must degrade to the pre-plugin request, because a header here
 * refines attribution and never grants access. Turning its absence into a failed
 * model call would invent an outage where the design promises a lossless
 * fallback.
 *
 * # An answered header can never authorize, and that is structural
 *
 * Two independent rules, both here rather than in any provider:
 *
 * 1. {@link RESERVED_HEADERS} are refused at the merge — the credential names
 *    every provider SDK authenticates with, the ones a fetch implementation
 *    computes from the body, and the ones that decide where the request goes.
 * 2. {@link fetchWithModelCallHeaders} only sets a header the request does not
 *    already carry. The provider's own headers therefore always win, so even a
 *    name nobody thought to reserve cannot displace what the SDK put there.
 *
 * That is what makes it safe for the question to name no URL (see
 * {@link ModelCallHeadersQuestion}): an answer annotates the call the operator
 * already configured, and can neither re-point nor re-authenticate it.
 *
 * # How the header reaches the wire
 *
 * There is no single HTTP client behind `ApiHandler` — each provider builds its
 * own from its own SDK — so the value cannot be threaded down as an argument
 * without inventing a headers parameter on every provider's private call path,
 * and mutating a client's `defaultHeaders` per request would race every
 * concurrent task sharing that handler.
 *
 * What the SDKs do offer is a custom `fetch`. So the value travels from the
 * request's start to that `fetch` through an {@link AsyncLocalStorage} — the same
 * mechanism core already uses to attribute logs to a task
 * (`logging/logContext.ts`) and to carry per-call MCP headers — which is
 * per-async-context and therefore correct under concurrency, with no shared
 * mutable state to race on. Providers pass {@link fetchWithModelCallHeaders} to
 * their client; a provider whose SDK cannot take a `fetch` (the AWS Bedrock and
 * Google GenAI clients) simply never sees the headers, which degrades to the
 * pre-plugin request exactly like having no plugin at all.
 *
 * The context is established once per logical request, around the whole stream,
 * in {@link modelCallHeadersStream} — so an SDK-internal retry of the same
 * request carries the same headers, while requests the client makes OUTSIDE one
 * (fetching a model catalog, a health probe) are outside the context and are
 * correctly untouched.
 */

import { AsyncLocalStorage } from "node:async_hooks"

import type { ModelCallHeadersQuestion } from "@shofer/types"
import { modelCallHeadersAnswerSchema } from "@shofer/types"

import { pluginRegistry } from "../plugins/plugin-registry.js"
import { apiLog } from "../logging/subsystems.js"

/** The broadcast method name plugins answer. */
export const RESOLVE_MODEL_CALL_HEADERS = "resolve-model-call-headers"

/**
 * Headers a plugin may never set on a model API request.
 *
 * Three groups, and each is a different failure if it were allowed: the
 * CREDENTIAL names every provider SDK authenticates with (`authorization`,
 * `x-api-key`, `api-key`, and the Google/Azure spellings), which an answered
 * header must never be able to replace; the ones a fetch implementation computes
 * from the body or the connection; and `host`, which decides where the request
 * goes. Anthropic's `anthropic-version` is here too — it selects the API shape
 * the SDK then parses, so overriding it corrupts the response rather than
 * annotating the call.
 */
const RESERVED_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"anthropic-version",
	"api-key",
	"authorization",
	"connection",
	"content-length",
	"content-type",
	"host",
	"proxy-authorization",
	"transfer-encoding",
	"x-api-key",
	"x-goog-api-key",
])

const storage = new AsyncLocalStorage<Readonly<Record<string, string>>>()

/**
 * The headers resolved for the model request whose async context we are inside,
 * or `undefined` when there are none (which is every call outside
 * {@link modelCallHeadersStream} / {@link modelCallHeadersCall}).
 */
export function currentModelCallHeaders(): Readonly<Record<string, string>> | undefined {
	return storage.getStore()
}

/**
 * Ask every plugin what headers this request should carry, and merge the answers.
 *
 * **First answer wins per header name**, compared case-insensitively: two plugins
 * claiming the same header is a configuration mistake, and silently letting
 * registration order decide which value is presented would be the worse of the
 * two failures. The loser is logged.
 *
 * Never throws: a broadcast failure resolves to "no headers", because the
 * fallback must stay lossless.
 */
export async function resolveModelCallHeaders(question: ModelCallHeadersQuestion): Promise<Record<string, string>> {
	let answers: unknown[]
	try {
		answers = await pluginRegistry.requestAll(RESOLVE_MODEL_CALL_HEADERS, question, { taskId: question.taskId })
	} catch (error) {
		apiLog.warn(
			`Resolving per-request headers for ${question.provider ?? "the model provider"} failed ` +
				`(${error instanceof Error ? error.message : String(error)}); the request goes out without them.`,
		)
		return {}
	}

	const merged: Record<string, string> = {}
	const claimed = new Set<string>()
	for (const answer of answers) {
		const parsed = modelCallHeadersAnswerSchema.safeParse(answer)
		if (!parsed.success) {
			continue
		}
		for (const [rawName, value] of Object.entries(parsed.data.headers)) {
			const name = rawName.trim()
			if (!name) {
				continue
			}
			const lowered = name.toLowerCase()
			if (RESERVED_HEADERS.has(lowered)) {
				apiLog.warn(`A plugin tried to set the reserved header "${name}" on a model API request; ignored.`)
				continue
			}
			if (claimed.has(lowered)) {
				apiLog.warn(
					`Two plugins answered with the header "${name}" for a model API request; ` +
						"keeping the first and ignoring the rest.",
				)
				continue
			}
			claimed.add(lowered)
			merged[name] = value
		}
	}
	return merged
}

/**
 * Run `fn` with `headers` visible to a provider client's `fetch`. An empty or
 * absent set runs `fn` untouched, so the no-plugin path does not even enter an
 * async context.
 */
export function withModelCallHeaders<T>(headers: Record<string, string> | undefined, fn: () => T): T {
	if (!headers || Object.keys(headers).length === 0) {
		return fn()
	}
	return storage.run(Object.freeze({ ...headers }), fn)
}

/**
 * Wrap one streaming model request: resolve the headers, then pull the
 * provider's stream inside their async context.
 *
 * `question` is a thunk because the facts it needs — the resolved model id above
 * all — are only knowable once the caller has committed to the request, and
 * because reading them can throw (a provider with no model configured does), in
 * which case the request must fail on the provider's own error, not on ours.
 *
 * Each `next()` is pulled inside the context rather than merely creating the
 * generator inside it: an async generator's body resumes in the context of
 * whoever called `next()`, so establishing the store around creation alone would
 * leave every segment after the first outside it — silently, with the request
 * still succeeding and the header simply absent.
 */
export async function* modelCallHeadersStream<T>(
	question: () => ModelCallHeadersQuestion,
	start: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
	const headers = await resolveHeadersQuietly(question)
	if (!headers) {
		yield* start()
		return
	}
	const iterator = start()[Symbol.asyncIterator]()
	try {
		while (true) {
			const next = await withModelCallHeaders(headers, () => iterator.next())
			if (next.done) {
				return
			}
			yield next.value
		}
	} finally {
		// A consumer that abandons the stream (an aborted request, a `break`)
		// must still tear the provider's generator down; without this the
		// provider's own `finally` — where abort handling and cleanup live —
		// would never run.
		await iterator.return?.(undefined as never)
	}
}

/**
 * Wrap one non-streaming model request (`completePrompt`) the same way.
 */
export async function modelCallHeadersCall<T>(
	question: () => ModelCallHeadersQuestion,
	run: () => Promise<T>,
): Promise<T> {
	const headers = await resolveHeadersQuietly(question)
	return withModelCallHeaders(headers, run)
}

/**
 * Build the question and resolve it, or answer `undefined` if building it threw.
 *
 * Nothing about observing a request may change whether it happens, so a thunk
 * that throws — `getModel()` on a handler with no model configured is the real
 * case — must leave the request to fail on its own terms further down.
 */
async function resolveHeadersQuietly(
	question: () => ModelCallHeadersQuestion,
): Promise<Record<string, string> | undefined> {
	let asked: ModelCallHeadersQuestion
	try {
		asked = question()
	} catch {
		return undefined
	}
	const headers = await resolveModelCallHeaders(asked)
	return Object.keys(headers).length > 0 ? headers : undefined
}

/**
 * The `fetch` a provider's SDK client is constructed with: the global one, plus
 * whatever the enclosing model request put in scope.
 *
 * An answered header **never displaces one the request already carries**. The
 * provider owns its own request — its credential, its content negotiation, its
 * API-version pin — and a plugin annotates what is left over. This is the second
 * of the two rules that make an answer non-authorizing; see the module docstring.
 */
export const fetchWithModelCallHeaders = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const extra = currentModelCallHeaders()
	if (!extra) {
		return fetch(input as RequestInfo, init)
	}
	// The SDKs differ in where they put the request's own headers: most pass an
	// `init`, some hand over a fully built `Request`. Reading the `Request`'s
	// headers when there is no `init` is what keeps rule 2 true in both shapes —
	// otherwise the provider's headers would be invisible here and an answered
	// name could displace one after all.
	const carried = init?.headers ?? (input instanceof Request ? input.headers : undefined)
	const headers = new Headers(carried)
	for (const [name, value] of Object.entries(extra)) {
		if (!headers.has(name)) {
			headers.set(name, value)
		}
	}
	return fetch(input as RequestInfo, { ...init, headers })
}

/**
 * {@link fetchWithModelCallHeaders}, for an SDK whose `fetch` option is declared
 * against **`node-fetch`**'s `Request`/`Response` rather than the runtime globals
 * — the Anthropic SDK at the version we pin, and everything built on it.
 *
 * The implementation is the same function: the two `Request` types are
 * structurally different but describe the same runtime object, and this shim
 * reads only `headers`, which they agree on. The cast is the whole difference,
 * and it lives here once rather than at each provider that needs it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const nodeFetchWithModelCallHeaders: any = fetchWithModelCallHeaders
