// npx vitest src/components/chat/__tests__/ErrorRow.variants.spec.tsx
//
// One component renders every error the chat shows, so its per-type title, its
// optional docs link (which is either an external URL or an internal
// `shofer://settings` route) and its details dialog are what a reader actually
// gets when something fails.

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import ErrorRow, { type ErrorRowProps } from "../ErrorRow"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

const copyWithFeedback = vi.fn().mockResolvedValue(true)
vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback }),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
	}),
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ version: "9.9.9", apiConfiguration: { apiProvider: "anthropic" } }),
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ provider: "anthropic", id: "claude-sonnet-4-5" }),
}))

vi.mock("../../common/CodeBlock", () => ({
	default: ({ source }: { source: string }) => <pre data-testid="code-block">{source}</pre>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, className }: any) => (
		<button className={className} onClick={onClick}>
			{children}
		</button>
	),
}))

const renderRow = (props: Partial<ErrorRowProps> & { type: ErrorRowProps["type"] }) =>
	render(<ErrorRow message="something went wrong" {...props} />)

beforeEach(() => vi.clearAllMocks())

describe("per-type titles", () => {
	it.each([
		["error", "chat:error"],
		["mistake_limit", "chat:troubleMessage"],
		["api_failure", "chat:apiRequest.failed"],
		["diff_error", "chat:diffError.title"],
		["streaming_failed", "chat:apiRequest.streamingFailed"],
		["cancelled", "chat:apiRequest.cancelled"],
	])("%s is titled %s", (type, title) => {
		renderRow({ type: type as ErrorRowProps["type"] })
		expect(screen.getByText(title)).toBeInTheDocument()
	})

	it("interpolates the status code into a retry-delay title", () => {
		renderRow({ type: "api_req_retry_delayed", code: 429 })
		expect(screen.getByText(/chat:apiRequest.errorTitle/)).toBeInTheDocument()
	})
})

describe("the docs link", () => {
	it("is absent without a URL, and opens an external one through the host", () => {
		const { unmount } = renderRow({ type: "error" })
		expect(screen.queryByText("chat:apiRequest.errorMessage.docs")).not.toBeInTheDocument()
		unmount()

		renderRow({ type: "error", docsURL: "https://docs.test/x" })
		fireEvent.click(screen.getByText("chat:apiRequest.errorMessage.docs"))
		expect(postMessage).toHaveBeenCalledWith({ type: "openExternal", url: "https://docs.test/x" })
	})

	it("routes an internal settings URL to the settings tab instead", () => {
		renderRow({ type: "error", docsURL: "shofer://settings" })
		fireEvent.click(screen.getByText("Settings"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "switchTab",
			tab: "settings",
			values: { section: "providers" },
		})
	})
})

describe("the details dialog", () => {
	it("is offered only when there are details", () => {
		const { unmount } = renderRow({ type: "error" })
		expect(screen.queryByText("chat:errorDetails.link")).not.toBeInTheDocument()
		unmount()

		renderRow({ type: "error", errorDetails: "a stack trace" })
		expect(screen.getByText("chat:errorDetails.link")).toBeInTheDocument()
	})

	it("opens with the details, alongside the version and model context", () => {
		renderRow({ type: "error", errorDetails: "a stack trace" })
		fireEvent.click(screen.getByText("chat:errorDetails.link"))
		expect(screen.getByText(/a stack trace/)).toBeInTheDocument()
	})
})

describe("the collapsible diff error", () => {
	it("starts collapsed and expands to a code block", () => {
		const { container } = renderRow({ type: "diff_error", message: "the patch failed", expandable: true })
		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()

		fireEvent.click(screen.getByText("chat:diffError.title"))
		expect(screen.getByTestId("code-block")).toHaveTextContent("the patch failed")
		expect(container.querySelector(".codicon-chevron-up")).toBeTruthy()
	})

	it("can start expanded", () => {
		renderRow({ type: "diff_error", expandable: true, defaultExpanded: true })
		expect(screen.getByTestId("code-block")).toBeInTheDocument()
	})

	it("copies the message and flashes the check glyph", async () => {
		vi.useFakeTimers()
		const { container } = renderRow({
			type: "diff_error",
			message: "the patch failed",
			expandable: true,
			showCopyButton: true,
		})

		await act(async () => {
			fireEvent.click(container.querySelector(".codicon-copy")!.closest("button")!)
		})
		expect(copyWithFeedback).toHaveBeenCalledWith("the patch failed")
		expect(container.querySelector(".codicon-check")).toBeTruthy()

		act(() => {
			vi.advanceTimersByTime(1500)
		})
		expect(container.querySelector(".codicon-check")).toBeNull()
		vi.useRealTimers()
	})

	it("leaves the glyph alone when the copy fails", async () => {
		copyWithFeedback.mockResolvedValueOnce(false)
		const { container } = renderRow({
			type: "diff_error",
			expandable: true,
			showCopyButton: true,
		})

		await act(async () => {
			fireEvent.click(container.querySelector(".codicon-copy")!.closest("button")!)
		})
		expect(container.querySelector(".codicon-check")).toBeNull()
	})
})

describe("extras", () => {
	it("renders the caller's own title and additional content", () => {
		renderRow({
			type: "error",
			title: "A specific title",
			additionalContent: <span data-testid="extra">more</span>,
		})
		expect(screen.getByText("A specific title")).toBeInTheDocument()
		expect(screen.getByTestId("extra")).toBeInTheDocument()
	})
})
