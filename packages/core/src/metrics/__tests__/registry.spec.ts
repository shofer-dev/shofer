import { metrics } from "@opentelemetry/api"

/**
 * The metrics registry is a thin facade over the OpenTelemetry API, and thin is
 * exactly why it needs tests: nothing downstream fails when a label is
 * misspelled or a counter is created twice under different names — the numbers
 * simply do not add up in a dashboard nobody is looking at yet.
 *
 * A recording meter is installed as the global provider, so every assertion is
 * about the instrument name, the value and the LABEL SET that actually reached
 * OTel.
 */

interface Recorded {
	instrument: string
	value: number
	labels?: Record<string, string>
}

const recorded: Recorded[] = []
const created: string[] = []
const observableCallbacks = new Map<string, (result: unknown) => void>()

function makeRecordingMeter() {
	const instrument = (name: string) => ({
		add: (value: number, labels?: Record<string, string>) => recorded.push({ instrument: name, value, labels }),
		record: (value: number, labels?: Record<string, string>) => recorded.push({ instrument: name, value, labels }),
	})
	return {
		createCounter: (name: string) => (created.push(name), instrument(name)),
		createHistogram: (name: string) => (created.push(name), instrument(name)),
		createGauge: (name: string) => (created.push(name), instrument(name)),
		createObservableGauge: (name: string) => {
			created.push(name)
			return { addCallback: (cb: (r: unknown) => void) => observableCallbacks.set(name, cb) }
		},
	}
}

vi.spyOn(metrics, "getMeter").mockReturnValue(makeRecordingMeter() as never)

const {
	classifyLlmError,
	classifyMcpError,
	classifyToolError,
	incLlmCalls,
	incLlmCost,
	incLlmErrors,
	incLlmTokens,
	incMcpCalls,
	incMcpErrors,
	incTaskCompleted,
	incTaskCreated,
	incTaskErrored,
	incToolCalls,
	incToolErrors,
	incWebviewPushError,
	mcpErrorTypeToStatus,
	recordLlmDuration,
	recordMcpDuration,
	recordToolDuration,
	registry,
} = await import("../registry.js")

beforeEach(() => {
	recorded.length = 0
	created.length = 0
})

function only(instrument: string): Recorded[] {
	return recorded.filter((r) => r.instrument === instrument)
}

describe("registry facade", () => {
	it("creates each instrument once and reuses it", () => {
		registry.incCounter("reused_counter", "help")
		registry.incCounter("reused_counter", "help")
		registry.observeHistogram("reused_hist", "help", 1)
		registry.observeHistogram("reused_hist", "help", 2)
		registry.setGauge("reused_gauge", "help", 3)
		registry.setGauge("reused_gauge", "help", 4)

		expect(created.filter((n) => n === "reused_counter")).toHaveLength(1)
		expect(created.filter((n) => n === "reused_hist")).toHaveLength(1)
		expect(created.filter((n) => n === "reused_gauge")).toHaveLength(1)
		expect(only("reused_counter")).toHaveLength(2)
	})

	it("defaults a counter increment to one and carries an explicit amount", () => {
		registry.incCounter("amounts", "help", { a: "1" })
		registry.incCounter("amounts", "help", { a: "1" }, 7)

		expect(only("amounts").map((r) => r.value)).toEqual([1, 7])
		expect(only("amounts")[0]!.labels).toEqual({ a: "1" })
	})

	it("registers an observable gauge at most once, keeping the first callback", () => {
		const first = vi.fn()
		const second = vi.fn()
		registry.registerObservableGauge("obs_gauge", "help", first)
		registry.registerObservableGauge("obs_gauge", "help", second)

		expect(created.filter((n) => n === "obs_gauge")).toHaveLength(1)
		observableCallbacks.get("obs_gauge")!({})
		expect(first).toHaveBeenCalled()
		expect(second).not.toHaveBeenCalled()
	})
})

describe("LLM metrics", () => {
	it("labels a duration with the provider and model", () => {
		recordLlmDuration("anthropic", "claude", 120)

		expect(only("shofer_llm_duration_ms")[0]).toMatchObject({
			value: 120,
			labels: { provider: "anthropic", modelId: "claude" },
		})
	})

	it("labels calls by status and errors by errorType", () => {
		incLlmCalls("anthropic", "claude", "success")
		incLlmErrors("anthropic", "claude", "rate_limit")

		expect(only("shofer_llm_calls_total")[0]!.labels).toEqual({
			provider: "anthropic",
			modelId: "claude",
			status: "success",
		})
		expect(only("shofer_llm_errors_total")[0]!.labels).toEqual({
			provider: "anthropic",
			modelId: "claude",
			errorType: "rate_limit",
		})
	})

	it("ignores a cost that is zero, negative or not finite", () => {
		incLlmCost("p", "m", 0)
		incLlmCost("p", "m", -1)
		incLlmCost("p", "m", Number.NaN)
		incLlmCost("p", "m", Number.POSITIVE_INFINITY)
		expect(only("shofer_llm_cost_usd_total")).toHaveLength(0)

		incLlmCost("p", "m", 0.25)
		expect(only("shofer_llm_cost_usd_total")[0]!.value).toBe(0.25)
	})

	it("splits tokens by direction and drops the empty ones", () => {
		incLlmTokens("p", "m", { input: 100, output: 20, cacheRead: 0, cacheWrite: 5 })

		expect(only("shofer_llm_tokens_total").map((r) => [r.labels!.direction, r.value])).toEqual([
			["input", 100],
			["output", 20],
			["cache_write", 5],
		])
	})
})

describe("tool, MCP and task-lifecycle metrics", () => {
	it("labels tool metrics by tool, status and errorType", () => {
		recordToolDuration("read_file", 5)
		incToolCalls("read_file", "error")
		incToolErrors("read_file", "not_found")

		expect(only("shofer_tool_duration_ms")[0]!.labels).toEqual({ tool: "read_file" })
		expect(only("shofer_tool_calls_total")[0]!.labels).toEqual({ tool: "read_file", status: "error" })
		expect(only("shofer_tool_errors_total")[0]!.labels).toEqual({ tool: "read_file", errorType: "not_found" })
	})

	it("labels MCP metrics by server and tool", () => {
		recordMcpDuration("srv", "t", 9)
		incMcpCalls("srv", "t", "timeout")
		incMcpErrors("srv", "t", "server_error")

		expect(only("shofer_mcp_duration_ms")[0]!.labels).toEqual({ server: "srv", tool: "t" })
		expect(only("shofer_mcp_calls_total")[0]!.labels).toEqual({ server: "srv", tool: "t", status: "timeout" })
		expect(only("shofer_mcp_errors_total")[0]!.labels).toEqual({
			server: "srv",
			tool: "t",
			errorType: "server_error",
		})
	})

	it("counts task lifecycle transitions", () => {
		incTaskCreated("code")
		incTaskCompleted("code", "well")
		incTaskErrored("code", "api_error")
		incWebviewPushError()

		expect(only("shofer_tasks_created_total")[0]!.labels).toEqual({ mode: "code" })
		expect(only("shofer_tasks_completed_total")[0]!.labels).toEqual({ mode: "code", rating: "well" })
		expect(only("shofer_tasks_errored_total")[0]!.labels).toEqual({ mode: "code", errorType: "api_error" })
		expect(only("shofer_metrics_webview_push_errors_total")).toHaveLength(1)
	})
})

describe("error classifiers", () => {
	it.each([
		["Rate limit exceeded", "rate_limit"],
		["quota exceeded for this rate", "rate_limit"],
		["Request timeout", "timeout"],
		["the request timed out", "timeout"],
		["unauthorized: bad credential", "auth_error"],
		["context window exceeded", "context_window"],
		["HTTP 500 from api", "api_error"],
		["something else entirely", "unknown"],
	])("classifies an LLM error %j as %s", (message, expected) => {
		expect(classifyLlmError(new Error(message))).toBe(expected)
	})

	it("classifies a non-Error LLM failure by its string form", () => {
		expect(classifyLlmError("connection timeout")).toBe("timeout")
	})

	it.each([
		["timed out", "timeout"],
		["request aborted", "cancelled"],
		["server error 500", "server_error"],
		["mystery", "unknown"],
	])("classifies an MCP error %j as %s", (message, expected) => {
		expect(classifyMcpError(new Error(message))).toBe(expected)
	})

	it.each([
		["operation timed out", "timeout"],
		["ENOENT: no such file", "not_found"],
		["EACCES permission denied", "permission"],
		["cancelled by user", "cancelled"],
		["mystery", "unknown"],
	])("classifies a tool error %j as %s", (message, expected) => {
		expect(classifyToolError(new Error(message))).toBe(expected)
	})

	it("classifies a thrown non-Error as unknown rather than inspecting it", () => {
		expect(classifyToolError("timed out")).toBe("unknown")
	})

	it.each([
		["timeout", "timeout"],
		["cancelled", "cancelled"],
		["server_error", "error"],
		["unknown", "error"],
	] as const)("maps the MCP error type %s onto the %s status label", (given, expected) => {
		expect(mcpErrorTypeToStatus(given)).toBe(expected)
	})
})

describe("time() routing", () => {
	it("routes a known operation to its own histogram and an unknown one to the catch-all", async () => {
		const { time } = await import("../../utils/perf.js")

		await time("saveShoferMessages", async () => undefined)
		await time("some-ad-hoc-operation", async () => undefined)

		expect(only("shofer_save_messages_duration_ms")).toHaveLength(1)
		expect(only("shofer_generic_duration_ms")[0]!.labels).toEqual({ operation: "some-ad-hoc-operation" })
	})
})
