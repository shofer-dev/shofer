import { trace, SpanStatusCode, type Attributes } from "@opentelemetry/api"

import type { TelemetryEvent } from "@shofer/types"

import { BaseTelemetryClient } from "./BaseTelemetryClient"

/**
 * OpenTelemetry transport for the typed telemetry catalog
 * (todos/opencode_inspired_work.md §8).
 *
 * Emits each captured event as an OpenTelemetry span via `@opentelemetry/api`,
 * keeping shofer's rich typed event taxonomy as the *data* and OTel as the
 * *transport* — so any standards-based backend (incl. Prometheus via the OTel
 * collector) can consume it, instead of a bespoke exporter.
 *
 * `@opentelemetry/api` is a **no-op until an OTel SDK is registered** by the host
 * (e.g. `NodeSDK` with an OTLP exporter), so this client is zero-overhead and
 * inert unless telemetry is opted in *and* an SDK is wired up — making OTel
 * adoption an operator choice, not a hard runtime requirement.
 */
export class OtelTelemetryClient extends BaseTelemetryClient {
	private readonly tracer = trace.getTracer("shofer")

	public override async capture(event: TelemetryEvent): Promise<void> {
		if (!this.telemetryEnabled || !this.isEventCapturable(event.event)) {
			return
		}
		const properties = await this.getEventProperties(event)
		const span = this.tracer.startSpan(`shofer.${event.event}`, {
			attributes: toAttributes(properties),
		})
		span.end()
	}

	public override async captureException(
		error: Error,
		additionalProperties?: Record<string, unknown>,
	): Promise<void> {
		if (!this.telemetryEnabled) {
			return
		}
		const span = this.tracer.startSpan("shofer.exception", {
			attributes: toAttributes(additionalProperties),
		})
		span.recordException(error)
		span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
		span.end()
	}

	public override updateTelemetryState(didUserOptIn: boolean): void {
		this.telemetryEnabled = didUserOptIn
	}

	public override async shutdown(): Promise<void> {
		// The OTel SDK (registered by the host) owns exporter flush/shutdown.
	}
}

/**
 * Flatten event properties into OTel span attributes. Attribute values must be
 * primitives or arrays of primitives, so objects/arrays are JSON-stringified and
 * `undefined`/`null` are dropped.
 */
function toAttributes(properties?: Record<string, unknown>): Attributes {
	const attrs: Attributes = {}
	if (!properties) return attrs
	for (const [key, value] of Object.entries(properties)) {
		if (value === undefined || value === null) continue
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			attrs[key] = value
		} else {
			attrs[key] = JSON.stringify(value)
		}
	}
	return attrs
}
