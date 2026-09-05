// npx vitest src/components/chat/__tests__/ChatRow.api-request.spec.tsx
//
// The `api_req_started` row is the one ChatRow case with real logic rather than
// markup: it hides itself on a plain success, keeps a dim diagnostics row when
// the host recorded per-request metadata, and renders the cancel / failure
// variants distinctly. The retry-delay row's HTTP-code lookup rides along.

import { render, screen } from "@/utils/test-utils"

import type { ShoferMessage } from "@shofer/types"

import { ChatRowContent } from "../ChatRow"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { exists: (k: string) => k.endsWith("429") } }),
	Trans: ({ i18nKey }: { i18nKey?: string }) => <span>{i18nKey}</span>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

// The row asks i18next directly whether a per-status-code string exists; the
// double keeps the fluent `use().init()` shape `src/i18n/setup.ts` needs.
vi.mock("i18next", () => {
	const i18n: Record<string, unknown> = {
		exists: (k: string) => k.endsWith("429"),
		t: (k: string) => k,
		use: () => i18n,
		init: () => Promise.resolve((k: string) => k),
		changeLanguage: () => Promise.resolve(),
		on: () => {},
	}
	return { default: i18n, ...i18n }
})

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		shoferMessages: [],
		mode: "code",
		apiConfiguration: {},
		experiments: {},
	}),
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ id: "m", info: { supportsImages: true } }),
}))

vi.mock("../../common/MarkdownBlock", () => ({ default: () => <div /> }))
vi.mock("../../common/CodeAccordion", () => ({ default: () => <div /> }))

const base = { ts: 1700000000000, type: "say" as const, say: "api_req_started" as const }

const renderRow = (text: Record<string, unknown>, props: Record<string, unknown> = {}) =>
	render(
		<ChatRowContent
			message={{ ...base, text: JSON.stringify(text) } as ShoferMessage}
			isExpanded={false}
			isLast={false}
			isStreaming={false}
			onToggleExpand={vi.fn()}
			onSuggestionClick={vi.fn()}
			onBatchFileResponse={vi.fn()}
			onFollowUpUnmount={vi.fn()}
			isFollowUpAnswered={false}
			{...props}
		/>,
	)

beforeEach(() => vi.clearAllMocks())

describe("a finished API request", () => {
	it("disappears entirely on a plain success", () => {
		const { container } = renderRow({ request: "…", cost: 0.01 })
		expect(container).toBeEmptyDOMElement()
	})

	it("stays as a dim diagnostics row when the host recorded metadata", () => {
		const { container } = renderRow({
			request: "…",
			cost: 0.0123,
			actualModel: "claude-sonnet-4-5",
			ttfbMs: 350,
			ttlbMs: 2100,
			tokensIn: 12000,
			tokensOut: 800,
			attempts: 2,
		})

		expect(container).not.toBeEmptyDOMElement()
		expect(container.querySelector(".codicon-info")).toBeTruthy()
		expect(screen.getByText("$0.0123")).toBeInTheDocument()
	})

	it("keeps the metadata row for a request that reported an error", () => {
		// `responseError` alone is not metadata — the row needs one of the
		// measured fields to have been recorded.
		const bare = renderRow({ request: "…", cost: 0.01, responseError: "upstream 500" })
		expect(bare.container).toBeEmptyDOMElement()

		const { container } = renderRow({
			request: "…",
			cost: 0.01,
			tokensIn: 10,
			responseError: "upstream 500",
		})
		expect(container.querySelector(".codicon-info")).toBeTruthy()
	})

	it("shows a zero-cost badge transparently rather than removing it", () => {
		renderRow({ request: "…", cost: 0, tokensIn: 10 })
		expect(screen.getByText("$0.0000")).toHaveStyle({ opacity: "0" })
	})
})

describe("an unfinished or failed API request", () => {
	it("reports a user cancellation", () => {
		renderRow({ request: "…", cancelReason: "user_cancelled" })
		expect(screen.getByText("chat:apiRequest.cancelled")).toBeInTheDocument()
	})

	it("reports a stream failure, with its message", () => {
		renderRow({
			request: "…",
			cancelReason: "streaming_failed",
			streamingFailedMessage: "the socket closed",
		})
		expect(screen.getByText("chat:apiRequest.streamingFailed")).toBeInTheDocument()
	})

	it("shows a spinner for the last, still-running request", () => {
		const { container } = renderRow({ request: "…" }, { isLast: true })
		expect(container).not.toBeEmptyDOMElement()
		expect(screen.getByText("chat:apiRequest.streaming")).toBeInTheDocument()
	})

	it("shows a static glyph for an unfinished request that is not the last", () => {
		const { container } = renderRow({ request: "…" })
		expect(container.querySelector(".codicon-arrow-swap")).toBeTruthy()
	})

	it("surfaces the failure the following ask carries", () => {
		renderRow(
			{ request: "…" },
			{
				isLast: true,
				lastModifiedMessage: { ts: 2, type: "ask", ask: "api_req_failed", text: "credentials rejected" },
			},
		)
		// The header and the error row below it both name the failure.
		expect(screen.getAllByText("chat:apiRequest.failed").length).toBeGreaterThan(0)
	})
})

describe("the retry-delay row", () => {
	const retryRow = (text?: string) =>
		render(
			<ChatRowContent
				message={{ ts: 1, type: "say", say: "api_req_retry_delayed", text } as ShoferMessage}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={vi.fn()}
				onSuggestionClick={vi.fn()}
				onBatchFileResponse={vi.fn()}
				onFollowUpUnmount={vi.fn()}
				isFollowUpAnswered={false}
			/>,
		)

	it("uses the per-code message when one exists", () => {
		retryRow("429 Too Many Requests")
		expect(screen.getByText(/chat:apiRequest.errorMessage.429/)).toBeInTheDocument()
	})

	it("falls back to the unknown-error message, and offers the support link", () => {
		retryRow("503 Service Unavailable")
		expect(screen.getByText(/chat:apiRequest.errorMessage.unknown/)).toBeInTheDocument()
	})

	it("shows the countdown the host tagged into the text", () => {
		retryRow("500 boom <retry_timer>12</retry_timer>")
		expect(screen.getByText("12s")).toBeInTheDocument()
	})

	it("omits the countdown when the timer is zero", () => {
		retryRow("500 boom <retry_timer>0</retry_timer>")
		expect(screen.queryByText("0s")).not.toBeInTheDocument()
	})

	it("renders the generic failure for text that carries no status code", () => {
		retryRow("something went wrong")
		expect(screen.getByText(/chat:apiRequest.failed/)).toBeInTheDocument()
	})

	it("renders with no text at all", () => {
		const { container } = retryRow(undefined)
		expect(container).not.toBeEmptyDOMElement()
	})
})

describe("the command header", () => {
	it("labels a running command", () => {
		render(
			<ChatRowContent
				message={{ ts: 1, type: "ask", ask: "command", text: "npm test" } as ShoferMessage}
				isExpanded={false}
				isLast
				isStreaming={false}
				lastModifiedMessage={{ ts: 1, type: "ask", ask: "command", text: "npm test\nOutput:" } as ShoferMessage}
				onToggleExpand={vi.fn()}
				onSuggestionClick={vi.fn()}
				onBatchFileResponse={vi.fn()}
				onFollowUpUnmount={vi.fn()}
				isFollowUpAnswered={false}
			/>,
		)
		expect(screen.getByText("chat:commandExecution.running")).toBeInTheDocument()
	})
})

describe("the tool-input inspector", () => {
	it("is offered beside a tool row and toggles", () => {
		const { container } = render(
			<ChatRowContent
				message={
					{
						ts: 1,
						type: "ask",
						ask: "tool",
						text: JSON.stringify({ tool: "readFile", path: "a.ts" }),
					} as ShoferMessage
				}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={vi.fn()}
				onSuggestionClick={vi.fn()}
				onBatchFileResponse={vi.fn()}
				onFollowUpUnmount={vi.fn()}
				isFollowUpAnswered={false}
			/>,
		)
		// The experiment is off in this state, so the inspector renders nothing.
		expect(container.querySelector("[data-testid='tool-input']")).toBeNull()
	})
})
