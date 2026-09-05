// pnpm --filter @shofer/telemetry test src/__tests__/BaseTelemetryClient.test.ts

import { type TelemetryEvent, type TelemetryEventSubscription, TelemetryEventName } from "@shofer/types"

import { BaseTelemetryClient } from "../BaseTelemetryClient.js"

/**
 * The subscription filter is the base class's whole policy surface: a client
 * declares an `include` or an `exclude` list (or neither, meaning "everything"),
 * and `isEventCapturable` is what every transport gates on. The PostHog suite
 * covers the `exclude` shape it happens to use; both other shapes live here.
 */
class TestClient extends BaseTelemetryClient {
	public readonly captured: TelemetryEvent[] = []

	constructor(subscription?: TelemetryEventSubscription) {
		super(subscription)
		this.telemetryEnabled = true
	}

	public override async capture(event: TelemetryEvent): Promise<void> {
		this.captured.push(event)
	}

	public override async captureException(): Promise<void> {}

	public override updateTelemetryState(didUserOptIn: boolean): void {
		this.telemetryEnabled = didUserOptIn
	}

	public override async shutdown(): Promise<void> {}

	/** `isEventCapturable` is protected; the filter is what these tests are about. */
	public canCapture(eventName: TelemetryEventName): boolean {
		return this.isEventCapturable(eventName)
	}
}

describe("BaseTelemetryClient subscription filtering", () => {
	it("captures everything when no subscription is declared", () => {
		const client = new TestClient()
		expect(client.canCapture(TelemetryEventName.TASK_CREATED)).toBe(true)
		expect(client.canCapture(TelemetryEventName.LLM_COMPLETION)).toBe(true)
	})

	it("an include subscription is an allow-list", () => {
		const client = new TestClient({ type: "include", events: [TelemetryEventName.TASK_CREATED] })
		expect(client.canCapture(TelemetryEventName.TASK_CREATED)).toBe(true)
		expect(client.canCapture(TelemetryEventName.TASK_COMPLETED)).toBe(false)
	})

	it("an exclude subscription is a deny-list", () => {
		const client = new TestClient({ type: "exclude", events: [TelemetryEventName.LLM_COMPLETION] })
		expect(client.canCapture(TelemetryEventName.LLM_COMPLETION)).toBe(false)
		expect(client.canCapture(TelemetryEventName.TASK_CREATED)).toBe(true)
	})

	it("tracks the opt-in state it is told about", () => {
		const client = new TestClient()
		expect(client.isTelemetryEnabled()).toBe(true)
		client.updateTelemetryState(false)
		expect(client.isTelemetryEnabled()).toBe(false)
	})

	it("holds the properties provider WEAKLY, and merges its properties under the event's", async () => {
		const client = new TestClient()
		client.setProvider({
			getTelemetryProperties: async () => ({ mode: "code", taskId: "from-provider" }) as never,
		})

		const properties = await (
			client as unknown as { getEventProperties(e: TelemetryEvent): Promise<Record<string, unknown>> }
		).getEventProperties({ event: TelemetryEventName.TASK_CREATED, properties: { taskId: "from-event" } })

		expect(properties).toEqual({ mode: "code", taskId: "from-event" })
	})
})
