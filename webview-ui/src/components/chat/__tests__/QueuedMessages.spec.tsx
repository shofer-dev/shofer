// npx vitest src/components/chat/__tests__/QueuedMessages.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { QueuedMessage } from "@shofer/types"

import { QueuedMessages } from "../QueuedMessages"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}))

vi.mock("../../common/Thumbnails", () => ({
	default: ({ images }: { images: string[] }) => <div data-testid="thumbnails">{images.length}</div>,
}))

vi.mock("../Mention", () => ({
	Mention: ({ text }: { text?: string }) => <span>{text}</span>,
}))

const onRemove = vi.fn()
const onUpdate = vi.fn()
const onForceSend = vi.fn()

const message = (over: Partial<QueuedMessage> & { id: string }): QueuedMessage =>
	({ text: `text ${over.id}`, timestamp: 1, ...over }) as QueuedMessage

const expand = () => fireEvent.click(screen.getByText("queuedMessages.header"))

beforeEach(() => vi.clearAllMocks())

describe("QueuedMessages", () => {
	it("renders nothing when the queue is empty", () => {
		const { container } = render(<QueuedMessages queue={[]} onRemove={onRemove} onUpdate={onUpdate} />)
		expect(container).toBeEmptyDOMElement()
	})

	it("stays collapsed until the header is clicked", () => {
		render(<QueuedMessages queue={[message({ id: "1" })]} onRemove={onRemove} onUpdate={onUpdate} />)
		expect(screen.queryByTestId("queued-messages")).not.toBeInTheDocument()

		expand()
		expect(screen.getByTestId("queued-messages")).toBeInTheDocument()
		expect(screen.getByText("text 1")).toBeInTheDocument()
	})

	it("offers Send Now only when the caller supplies the handler", () => {
		const { rerender } = render(
			<QueuedMessages queue={[message({ id: "1" })]} onRemove={onRemove} onUpdate={onUpdate} />,
		)
		expect(screen.queryByText("queuedMessages.sendNow")).not.toBeInTheDocument()

		rerender(
			<QueuedMessages
				queue={[message({ id: "1" })]}
				onRemove={onRemove}
				onUpdate={onUpdate}
				onForceSend={onForceSend}
			/>,
		)
		fireEvent.click(screen.getByText("queuedMessages.sendNow"))
		expect(onForceSend).toHaveBeenCalled()
		// Sending now must not also toggle the panel open.
		expect(screen.queryByTestId("queued-messages")).not.toBeInTheDocument()
	})

	it("removes a message by its queue index", () => {
		render(
			<QueuedMessages
				queue={[message({ id: "1" }), message({ id: "2" })]}
				onRemove={onRemove}
				onUpdate={onUpdate}
			/>,
		)
		expand()
		fireEvent.click(screen.getAllByRole("button").at(-1)!)
		expect(onRemove).toHaveBeenCalledWith(1)
	})

	it("edits a queued message and commits it on blur", () => {
		render(<QueuedMessages queue={[message({ id: "1" })]} onRemove={onRemove} onUpdate={onUpdate} />)
		expand()

		fireEvent.click(screen.getByText("text 1"))
		const editor = screen.getByRole("textbox")
		fireEvent.change(editor, { target: { value: "rewritten" } })
		fireEvent.blur(editor)

		// The queue itself is the caller's state, so the row keeps rendering the
		// prop it was given; what the component owes is the update and closing
		// the editor.
		expect(onUpdate).toHaveBeenCalledWith(0, "rewritten")
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})

	it("commits on Enter and abandons on Escape", () => {
		render(<QueuedMessages queue={[message({ id: "1" })]} onRemove={onRemove} onUpdate={onUpdate} />)
		expand()

		fireEvent.click(screen.getByText("text 1"))
		let editor = screen.getByRole("textbox")
		fireEvent.change(editor, { target: { value: "by enter" } })
		fireEvent.keyDown(editor, { key: "Enter" })
		expect(onUpdate).toHaveBeenCalledWith(0, "by enter")

		onUpdate.mockClear()
		fireEvent.click(screen.getByText("text 1"))
		editor = screen.getByRole("textbox")
		fireEvent.change(editor, { target: { value: "abandoned" } })
		fireEvent.keyDown(editor, { key: "Escape" })
		expect(onUpdate).not.toHaveBeenCalled()
	})

	it("keeps the editor open on a shift-enter newline", () => {
		render(<QueuedMessages queue={[message({ id: "1" })]} onRemove={onRemove} onUpdate={onUpdate} />)
		expand()

		fireEvent.click(screen.getByText("text 1"))
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true })
		expect(onUpdate).not.toHaveBeenCalled()
		expect(screen.getByRole("textbox")).toBeInTheDocument()
	})

	it("shows thumbnails for a message that carries images", () => {
		render(
			<QueuedMessages
				queue={[message({ id: "1", images: ["data:image/png;base64,aaa"] })]}
				onRemove={onRemove}
				onUpdate={onUpdate}
			/>,
		)
		expand()
		expect(screen.getByTestId("thumbnails")).toHaveTextContent("1")
	})
})
