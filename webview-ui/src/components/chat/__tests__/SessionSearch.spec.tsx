import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ShoferMessage } from "@shofer/types"

import SessionSearch from "../SessionSearch"

// The CSS Custom Highlight API is not available in jsdom; stub it so the
// highlight-painting effect doesn't throw.
vi.stubGlobal("CSS", { highlights: { set: vi.fn(), delete: vi.fn() } })
vi.stubGlobal("Highlight", class {})

// MutationObserver is not in jsdom by default.
class MockMutationObserver {
	observe = vi.fn()
	disconnect = vi.fn()
	takeRecords = vi.fn(() => [])
}
vi.stubGlobal("MutationObserver", MockMutationObserver)

const baseSay = (overrides: Partial<ShoferMessage>): ShoferMessage => ({
	ts: Date.now(),
	type: "say",
	...overrides,
})

describe("SessionSearch", () => {
	it("does not match against api_req_started machine data (the wire-request JSON)", () => {
		const messages: ShoferMessage[] = [
			// A visible text message that does NOT contain "proxy".
			baseSay({ ts: 1, say: "text", text: "Here is the config file you asked for." }),
			// An api_req_started whose hidden text payload DOES contain "proxy".
			baseSay({
				ts: 2,
				say: "api_req_started",
				text: JSON.stringify({
					wireRequest: '{"proxy":"http://localhost:8080","model":"glm-5.2"}',
					cost: 0.01,
				}),
			}),
		]

		render(<SessionSearch messages={messages} isOpen onClose={vi.fn()} onNavigate={vi.fn()} />)

		const input = screen.getByLabelText("Find in session")
		fireEvent.change(input, { target: { value: "proxy" } })

		// Should find 0 matches — the only occurrence is inside hidden machine data.
		expect(screen.getByText("0 / 0")).toBeInTheDocument()
	})

	it("matches visible text messages normally", () => {
		const messages: ShoferMessage[] = [
			baseSay({ ts: 1, say: "text", text: "Configured the proxy server correctly." }),
			baseSay({ ts: 2, say: "text", text: "Nothing relevant here." }),
		]

		render(<SessionSearch messages={messages} isOpen onClose={vi.fn()} onNavigate={vi.fn()} />)

		const input = screen.getByLabelText("Find in session")
		fireEvent.change(input, { target: { value: "proxy" } })

		// Exactly one visible message contains "proxy".
		expect(screen.getByText("1 / 1")).toBeInTheDocument()
	})

	it("skips all machine-data say types", () => {
		const machineTypes = [
			"api_req_started",
			"api_req_finished",
			"api_req_retried",
			"api_req_retry_delayed",
			"api_req_rate_limit_wait",
			"api_req_deleted",
			"checkpoint_saved",
		] as const

		const messages: ShoferMessage[] = machineTypes.map((say, i) =>
			baseSay({ ts: i + 1, say, text: `proxy-machine-data-${i}` }),
		)

		render(<SessionSearch messages={messages} isOpen onClose={vi.fn()} onNavigate={vi.fn()} />)

		const input = screen.getByLabelText("Find in session")
		fireEvent.change(input, { target: { value: "proxy" } })

		// None of the machine-data messages should match.
		expect(screen.getByText("0 / 0")).toBeInTheDocument()
	})

	it("matches user_feedback and other prose message types", () => {
		const messages: ShoferMessage[] = [
			baseSay({ ts: 1, say: "user_feedback", text: "Please use the proxy for this request." }),
			baseSay({ ts: 2, say: "completion_result", text: "Set up proxy forwarding." }),
		]

		render(<SessionSearch messages={messages} isOpen onClose={vi.fn()} onNavigate={vi.fn()} />)

		const input = screen.getByLabelText("Find in session")
		fireEvent.change(input, { target: { value: "proxy" } })

		expect(screen.getByText("1 / 2")).toBeInTheDocument()
	})

	it("shows no status when query is empty", () => {
		const messages: ShoferMessage[] = [baseSay({ ts: 1, say: "text", text: "proxy" })]

		render(<SessionSearch messages={messages} isOpen onClose={vi.fn()} onNavigate={vi.fn()} />)

		// Empty query → empty status string (no "0 / 0").
		expect(screen.queryByText("0 / 0")).not.toBeInTheDocument()
	})
})
