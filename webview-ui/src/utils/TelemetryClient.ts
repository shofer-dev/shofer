import posthog from "posthog-js"

import type { TelemetrySetting } from "@shofer/types"

/**
 * The webview telemetry client is disabled by default.
 * Set TELEMETRY_ENABLED=true to enable PostHog initialization and event capture.
 * No server-side infrastructure is required when telemetry is disabled (the default).
 */
const TELEMETRY_ENABLED = process.env.TELEMETRY_ENABLED === "true"

class TelemetryClient {
	private static instance: TelemetryClient
	private static telemetryEnabled: boolean = false

	/**
	 * Returns whether telemetry has been globally enabled via the
	 * TELEMETRY_ENABLED environment variable.
	 */
	public static isGloballyEnabled(): boolean {
		return TELEMETRY_ENABLED
	}

	public updateTelemetryState(telemetrySetting: TelemetrySetting, apiKey?: string, distinctId?: string) {
		if (!TELEMETRY_ENABLED) {
			TelemetryClient.telemetryEnabled = false
			return
		}

		posthog.reset()

		if (telemetrySetting !== "disabled" && apiKey && distinctId) {
			TelemetryClient.telemetryEnabled = true

			posthog.init(apiKey, {
				api_host: "https://ph.shofer.com",
				ui_host: "https://us.posthog.com",
				persistence: "localStorage",
				loaded: () => posthog.identify(distinctId),
				capture_pageview: false,
				capture_pageleave: false,
				autocapture: false,
			})
		} else {
			TelemetryClient.telemetryEnabled = false
		}
	}

	public static getInstance(): TelemetryClient {
		if (!TelemetryClient.instance) {
			TelemetryClient.instance = new TelemetryClient()
		}

		return TelemetryClient.instance
	}

	public capture(eventName: string, properties?: Record<string, any>) {
		if (!TELEMETRY_ENABLED) {
			return
		}

		if (TelemetryClient.telemetryEnabled) {
			try {
				posthog.capture(eventName, properties)
			} catch (_error) {
				// Silently fail if there's an error capturing an event.
			}
		}
	}
}

export const telemetryClient = TelemetryClient.getInstance()
