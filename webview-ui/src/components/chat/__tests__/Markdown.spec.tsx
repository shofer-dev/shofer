// npx vitest src/components/chat/__tests__/Markdown.spec.tsx

import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"

import { Markdown } from "../Markdown"

const copyWithFeedback = vi.fn().mockResolvedValue(true)
vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback }),
}))

vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown?: string }) => <div data-testid="block">{markdown}</div>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, className }: any) => (
		<button className={className} onClick={onClick}>
			{children}
		</button>
	),
}))

beforeEach(() => vi.clearAllMocks())

describe("Markdown", () => {
	it("renders nothing for missing or empty markdown", () => {
		const { container, rerender } = render(<Markdown />)
		expect(container).toBeEmptyDOMElement()

		rerender(<Markdown markdown="" />)
		expect(container).toBeEmptyDOMElement()
	})

	it("renders the block and hides the copy affordance until hover", () => {
		const { container } = render(<Markdown markdown="hello" />)
		expect(screen.getByTestId("block")).toHaveTextContent("hello")
		expect(container.querySelector(".copy-button")).toBeNull()

		fireEvent.mouseEnter(container.firstElementChild!)
		expect(container.querySelector(".copy-button")).toBeTruthy()

		fireEvent.mouseLeave(container.firstElementChild!)
		expect(container.querySelector(".copy-button")).toBeNull()
	})

	it("offers no copy affordance while the message is still streaming", () => {
		const { container } = render(<Markdown markdown="hello" partial />)
		fireEvent.mouseEnter(container.firstElementChild!)
		expect(container.querySelector(".copy-button")).toBeNull()
	})

	it("copies the source markdown and flashes the button", async () => {
		const { container } = render(<Markdown markdown="# heading" />)
		fireEvent.mouseEnter(container.firstElementChild!)

		const button = container.querySelector(".copy-button") as HTMLButtonElement
		button.focus()
		fireEvent.click(button)

		await waitFor(() => expect(copyWithFeedback).toHaveBeenCalledWith("# heading"))
	})

	it("does not flash when the copy fails", async () => {
		copyWithFeedback.mockResolvedValueOnce(false)
		const { container } = render(<Markdown markdown="x" />)
		fireEvent.mouseEnter(container.firstElementChild!)
		fireEvent.click(container.querySelector(".copy-button") as HTMLButtonElement)
		await waitFor(() => expect(copyWithFeedback).toHaveBeenCalled())
	})
})
