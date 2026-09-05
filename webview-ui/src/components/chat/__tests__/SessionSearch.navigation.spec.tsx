// npx vitest src/components/chat/__tests__/SessionSearch.navigation.spec.tsx
//
// The in-session find box: match navigation (wrapping in both directions), the
// keyboard contract, and the DOM highlighting it paints through the CSS Custom
// Highlight API — which jsdom does not implement, so the component must degrade
// rather than throw when the registry is absent.

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import type { ShoferMessage } from "@shofer/types"

import SessionSearch from "../SessionSearch"

const onClose = vi.fn()
const onNavigate = vi.fn()

const say = (ts: number, text: string): ShoferMessage => ({ ts, type: "say", say: "text", text }) as ShoferMessage

const messages = [say(1, "alpha and beta"), say(2, "beta only"), say(3, "gamma")]

const renderSearch = (props: Record<string, unknown> = {}) =>
	render(
		<SessionSearch messages={messages} isOpen onClose={onClose} onNavigate={onNavigate} {...(props as object)} />,
	)

const input = () => screen.getByLabelText("Find in session")
const search = (value: string) => fireEvent.change(input(), { target: { value } })

beforeEach(() => vi.clearAllMocks())

describe("SessionSearch", () => {
	it("renders nothing while closed", () => {
		const { container } = renderSearch({ isOpen: false })
		expect(container).toBeEmptyDOMElement()
	})

	it("shows no status until there is a query", () => {
		renderSearch()
		expect(screen.queryByText(/\d+ \/ \d+/)).not.toBeInTheDocument()
	})

	it("counts the matching messages and reports the first as current", () => {
		renderSearch()
		search("beta")
		expect(screen.getByText("1 / 2")).toBeInTheDocument()
		expect(onNavigate).toHaveBeenCalledWith(1)
	})

	it("says zero for a query nothing matches, and reports no target", () => {
		renderSearch()
		search("zzz")
		expect(screen.getByText("0 / 0")).toBeInTheDocument()
		expect(onNavigate).toHaveBeenLastCalledWith(null)
	})

	it("treats the query case-insensitively", () => {
		renderSearch()
		search("BETA")
		expect(screen.getByText("1 / 2")).toBeInTheDocument()
	})

	it("navigates forward and wraps", () => {
		renderSearch()
		search("beta")

		fireEvent.click(screen.getByLabelText("Next match"))
		expect(screen.getByText("2 / 2")).toBeInTheDocument()
		expect(onNavigate).toHaveBeenLastCalledWith(2)

		fireEvent.click(screen.getByLabelText("Next match"))
		expect(screen.getByText("1 / 2")).toBeInTheDocument()
	})

	it("navigates backward and wraps", () => {
		renderSearch()
		search("beta")

		fireEvent.click(screen.getByLabelText("Previous match"))
		expect(screen.getByText("2 / 2")).toBeInTheDocument()
	})

	it("disables both navigation buttons when nothing matches", () => {
		renderSearch()
		search("zzz")
		expect(screen.getByLabelText("Next match")).toBeDisabled()
		expect(screen.getByLabelText("Previous match")).toBeDisabled()

		fireEvent.click(screen.getByLabelText("Next match"))
		expect(screen.getByText("0 / 0")).toBeInTheDocument()
	})

	it("moves on Enter and Shift+Enter, and closes on Escape", () => {
		renderSearch()
		search("beta")

		fireEvent.keyDown(input(), { key: "Enter" })
		expect(screen.getByText("2 / 2")).toBeInTheDocument()

		fireEvent.keyDown(input(), { key: "Enter", shiftKey: true })
		expect(screen.getByText("1 / 2")).toBeInTheDocument()

		fireEvent.keyDown(input(), { key: "Escape" })
		expect(onClose).toHaveBeenCalled()
	})

	it("ignores any other key", () => {
		renderSearch()
		search("beta")
		fireEvent.keyDown(input(), { key: "a" })
		expect(screen.getByText("1 / 2")).toBeInTheDocument()
		expect(onClose).not.toHaveBeenCalled()
	})

	it("closes from the close button", () => {
		renderSearch()
		fireEvent.click(screen.getByLabelText("Close search"))
		expect(onClose).toHaveBeenCalled()
	})

	it("focuses and selects the box when it opens", () => {
		// The setup file replaces HTMLElement.focus with a no-op stub (a FAST
		// compatibility fix), so what is observable is that focus + select were
		// attempted on the input.
		const focus = vi.fn()
		const select = vi.fn()
		vi.useFakeTimers()
		renderSearch()
		Object.assign(input(), { focus, select })

		act(() => {
			vi.advanceTimersByTime(10)
		})
		expect(focus).toHaveBeenCalled()
		expect(select).toHaveBeenCalled()
		vi.useRealTimers()
	})

	it("degrades quietly when the browser has no highlight registry", () => {
		// jsdom implements neither `CSS.highlights` nor `Highlight`; the
		// component must still count and navigate.
		renderSearch()
		expect(() => search("beta")).not.toThrow()
		expect(screen.getByText("1 / 2")).toBeInTheDocument()
	})

	it("paints the match ranges when the registry does exist", () => {
		const set = vi.fn()
		const remove = vi.fn()
		vi.stubGlobal("CSS", { highlights: { set, delete: remove } })
		vi.stubGlobal(
			"Highlight",
			class {
				constructor(...ranges: Range[]) {
					this.ranges = ranges
				}
				ranges: Range[]
			},
		)

		renderSearch()
		search("beta")
		expect(set).toHaveBeenCalled()
		vi.unstubAllGlobals()
	})
})
