import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import { createInMemoryHost, TelemetryEventName, type PluginPermissions } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { createPluginSandbox } from "../plugin-sandbox.js"

/**
 * `ctx.host.telemetry` — the seam a plugin reports product events through.
 *
 * Three properties are load-bearing and none of them is the plugin's to enforce, which is
 * why they are tested here rather than trusted to each plugin author:
 *
 *  - a plugin cannot name a **top-level** event (the catalog is core's), so everything
 *    arrives as `PLUGIN_EVENT` tagged with who sent it;
 *  - properties are **scrubbed** to primitives, because a plugin sees workspace content
 *    and telemetry leaves the machine;
 *  - a denied call **warns and drops** rather than throwing — reporting an error must not
 *    fail differently because reporting was refused.
 */
describe("ctx.host.telemetry", () => {
	let captured: { event: TelemetryEventName; properties?: Record<string, unknown> }[]
	let warnings: string[]

	beforeEach(() => {
		captured = []
		warnings = []
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		// `captureEvent` fans out to observers regardless of the telemetry opt-in, which is
		// what lets this assert on what WOULD be sent without standing up a client.
		TelemetryService.instance.onEvent((event, properties) => {
			captured.push({ event, properties })
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function sandbox(permissions: PluginPermissions | undefined) {
		return createPluginSandbox({
			pluginName: "rag-indexing",
			permissions,
			pluginRoot: "/plugins/rag-indexing",
			workspacePath: "/ws",
			host: createInMemoryHost(),
			warn: (message: string) => warnings.push(message),
		})
	}

	it("namespaces a granted plugin's event under the single catalog entry", () => {
		sandbox({ telemetry: true }).telemetry.capture("indexing_error", { subsystem: "OpenAiEmbedder" })

		expect(captured).toHaveLength(1)
		expect(captured[0]!.event).toBe(TelemetryEventName.PLUGIN_EVENT)
		expect(captured[0]!.properties).toEqual({
			plugin: "rag-indexing",
			event: "indexing_error",
			subsystem: "OpenAiEmbedder",
		})
	})

	it("drops everything that is not a primitive, and truncates long strings", () => {
		sandbox({ telemetry: true }).telemetry.capture("failed", {
			// The realistic leak: someone spreads an Error, or a file's contents.
			stack: "x".repeat(1000),
			details: { path: "/ws/secret.env", contents: "API_KEY=…" },
			paths: ["/ws/a.ts", "/ws/b.ts"],
			attempts: 3,
			retried: true,
		})

		const properties = captured[0]!.properties as Record<string, unknown>
		expect(properties.details).toBeUndefined()
		expect(properties.paths).toBeUndefined()
		expect(properties.attempts).toBe(3)
		expect(properties.retried).toBe(true)
		expect((properties.stack as string).length).toBe(257) // 256 + the ellipsis
	})

	it("refuses to let a plugin misattribute its own events", () => {
		sandbox({ telemetry: true }).telemetry.capture("mine", { plugin: "someone-else", event: "Task Completed" })

		expect(captured[0]!.properties).toEqual({ plugin: "rag-indexing", event: "mine" })
	})

	it("warns and drops when the plugin has no grant — it never throws", () => {
		expect(() => sandbox({}).telemetry.capture("indexing_error")).not.toThrow()

		expect(captured).toHaveLength(0)
		expect(warnings.join("\n")).toMatch(/no permissions\.telemetry grant/)
	})
})
