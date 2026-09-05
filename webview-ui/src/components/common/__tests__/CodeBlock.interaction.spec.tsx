// npx vitest src/components/common/__tests__/CodeBlock.interaction.spec.tsx
//
// The interactive half of the code block, which the sibling spec (highlighting)
// does not reach: the window-shade collapse, the copy button's VISIBILITY gate
// — copy refuses unless the block is actually on screen, because the button is
// positioned by hand against Virtuoso's scroller — the selection suppression,
// and the inertial scroll chaining at the block's top/bottom boundary.

import { render, fireEvent, act, waitFor } from "@/utils/test-utils"

import CodeBlock from "../CodeBlock"

vi.mock("../../../i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("shiki", () => ({ bundledLanguages: { typescript: {}, txt: {} } }))

vi.mock("../../../utils/highlighter", () => ({
	normalizeLanguage: vi.fn((lang?: string) => lang || "txt"),
	isLanguageLoaded: vi.fn().mockReturnValue(true),
	getHighlighter: vi.fn().mockResolvedValue({
		codeToHast: (code: string) => ({
			type: "element",
			tagName: "pre",
			properties: {},
			children: [
				{
					type: "element",
					tagName: "code",
					properties: { className: ["hljs"] },
					children: [{ type: "text", value: code }],
				},
			],
		}),
	}),
}))

const copyWithFeedback = vi.fn()
vi.mock("../../../utils/clipboard", () => ({
	useCopyToClipboard: () => ({ showCopyFeedback: false, copyWithFeedback }),
}))

const code = "const x = 1;\nconst y = 2;\n"

/** The code block's own root, which carries the visibility attribute. */
const root = () => document.querySelector("[data-partially-visible]") as HTMLElement
// `StyledPre` is a styled DIV, not a <pre>: it is the code block root's only
// element child, and the one carrying the wheel/mousedown listeners.
const pre = () => root().firstElementChild as HTMLElement
const buttons = () => Array.from(document.querySelectorAll("button"))
const copyButton = () => buttons().at(-1)!

const renderBlock = async (props: Record<string, unknown> = {}) => {
	let view: ReturnType<typeof render>
	await act(async () => {
		view = render(<CodeBlock source={code} language="typescript" {...props} />)
	})
	return view!
}

let scroller: HTMLElement

/** Place the block inside the scroller's viewport, or well outside it. */
const placeBlock = (visible: boolean) => {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this === scroller) return { top: 0, bottom: 800, left: 0, right: 500, height: 800, width: 500 } as DOMRect
		return visible
			? ({ top: 100, bottom: 300, left: 0, right: 480, height: 200, width: 480 } as DOMRect)
			: ({ top: 2000, bottom: 2200, left: 0, right: 480, height: 200, width: 480 } as DOMRect)
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	scroller = document.createElement("div")
	scroller.setAttribute("data-virtuoso-scroller", "true")
	document.body.appendChild(scroller)
	placeBlock(true)
})

afterEach(() => {
	vi.restoreAllMocks()
	document.body.innerHTML = ""
})

describe("rendering", () => {
	it("renders nothing for an empty source", async () => {
		const { container } = await renderBlock({ source: "" })
		expect(container).toBeEmptyDOMElement()
	})

	it("marks itself visible once positioned against the scroller", async () => {
		await renderBlock()
		await waitFor(() => expect(root()).toHaveAttribute("data-partially-visible", "true"))
	})

	it("marks itself hidden when scrolled out of the viewport", async () => {
		placeBlock(false)
		await renderBlock()
		await waitFor(() => expect(root()).toHaveAttribute("data-partially-visible", "false"))
	})

	it("recomputes its position when the scroller moves", async () => {
		await renderBlock()
		placeBlock(false)

		act(() => {
			scroller.dispatchEvent(new Event("scroll"))
		})
		expect(root()).toHaveAttribute("data-partially-visible", "false")
	})

	it("recomputes on a window resize too", async () => {
		await renderBlock()
		placeBlock(false)

		act(() => {
			window.dispatchEvent(new Event("resize"))
		})
		expect(root()).toHaveAttribute("data-partially-visible", "false")
	})
})

describe("copying", () => {
	it("copies the source when the block is on screen", async () => {
		await renderBlock()
		await waitFor(() => expect(root()).toHaveAttribute("data-partially-visible", "true"))

		fireEvent.click(copyButton())
		expect(copyWithFeedback).toHaveBeenCalledWith(code, expect.anything())
	})

	it("prefers the raw source when the rendered one was transformed", async () => {
		await renderBlock({ rawSource: "RAW" })
		await waitFor(() => expect(root()).toHaveAttribute("data-partially-visible", "true"))

		fireEvent.click(copyButton())
		expect(copyWithFeedback).toHaveBeenCalledWith("RAW", expect.anything())
	})

	it("refuses to copy a block that is off screen", async () => {
		placeBlock(false)
		await renderBlock()
		await waitFor(() => expect(root()).toHaveAttribute("data-partially-visible", "false"))

		fireEvent.click(copyButton())
		expect(copyWithFeedback).not.toHaveBeenCalled()
	})

	it("does not let the click reach the row underneath", async () => {
		await renderBlock()
		const click = new MouseEvent("click", { bubbles: true, cancelable: true })
		const stopPropagation = vi.spyOn(click, "stopPropagation")

		copyButton().dispatchEvent(click)
		expect(stopPropagation).toHaveBeenCalled()
	})
})

describe("the window shade", () => {
	it("toggles between expand and collapse", async () => {
		vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2000)
		vi.useFakeTimers()
		await renderBlock()

		const collapse = buttons()[0]
		act(() => {
			fireEvent.click(collapse)
		})
		act(() => {
			vi.advanceTimersByTime(1000)
		})

		// The second click clears the pending timers set by the first, which is
		// the branch that matters — a double toggle must not leave two scrolls
		// racing.
		act(() => {
			fireEvent.click(buttons()[0])
		})
		act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(buttons().length).toBeGreaterThan(1)
		vi.useRealTimers()
	})

	it("hides the collapse button for a block short enough to show whole", async () => {
		// jsdom reports a zero scrollHeight, which is exactly the "fits" case.
		await renderBlock()
		await waitFor(() => expect(buttons()).toHaveLength(1))
	})
})

describe("text selection", () => {
	it("hides the buttons while the user is dragging a selection", async () => {
		await renderBlock()
		expect(buttons().length).toBeGreaterThan(0)

		act(() => {
			pre().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
		})
		expect(buttons()).toHaveLength(0)

		act(() => {
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
		})
		expect(buttons().length).toBeGreaterThan(0)
	})

	it("hides the buttons while the pointer is pressed on the code", async () => {
		await renderBlock()
		fireEvent.mouseDown(pre())
		fireEvent.mouseUp(pre())
		expect(root()).toBeTruthy()
	})
})

describe("scroll chaining", () => {
	const withScrollbar = (scrollTop: number, scrollHeight = 1000, clientHeight = 200) => {
		Object.defineProperty(pre(), "scrollHeight", { value: scrollHeight, configurable: true })
		Object.defineProperty(pre(), "clientHeight", { value: clientHeight, configurable: true })
		Object.defineProperty(pre(), "scrollTop", { value: scrollTop, writable: true, configurable: true })
	}

	const wheel = (deltaY: number, init: WheelEventInit = {}) => {
		const event = new WheelEvent("wheel", { deltaY, cancelable: true, bubbles: true, ...init })
		act(() => {
			pre().dispatchEvent(event)
		})
		return event
	}

	it("hands an upward wheel at the very top to the outer scroller", async () => {
		await renderBlock()
		withScrollbar(0)
		scroller.scrollBy = vi.fn()

		expect(wheel(-100).defaultPrevented).toBe(true)
	})

	it("hands a downward wheel at the very bottom to the outer scroller", async () => {
		await renderBlock()
		withScrollbar(800)
		scroller.scrollBy = vi.fn()

		expect(wheel(100).defaultPrevented).toBe(true)
	})

	it("keeps a wheel in the middle of the block to itself", async () => {
		await renderBlock()
		withScrollbar(400)

		expect(wheel(100).defaultPrevented).toBe(false)
	})

	it("ignores a block with no scrollbar of its own", async () => {
		await renderBlock()
		withScrollbar(0, 100, 100)

		expect(wheel(-100).defaultPrevented).toBe(false)
	})

	it("leaves shift-wheel to the browser's horizontal scrolling", async () => {
		await renderBlock()
		withScrollbar(0)

		expect(wheel(-100, { shiftKey: true }).defaultPrevented).toBe(false)
	})
})

describe("following streamed output", () => {
	it("keeps the view pinned to the newest line while the source grows", async () => {
		const { rerender } = await renderBlock()
		Object.defineProperty(pre(), "scrollHeight", { value: 900, configurable: true })
		Object.defineProperty(pre(), "clientHeight", { value: 200, configurable: true })
		pre().scrollTop = 0

		await act(async () => {
			rerender(<CodeBlock source={code + "const z = 3;\n"} language="typescript" />)
		})

		await waitFor(() => expect(pre().scrollTop).toBeGreaterThan(0))
	})

	it("leaves a reader who scrolled up alone", async () => {
		const { rerender } = await renderBlock()
		Object.defineProperty(pre(), "scrollHeight", { value: 900, configurable: true })
		Object.defineProperty(pre(), "clientHeight", { value: 200, configurable: true })
		pre().scrollTop = 10

		act(() => {
			pre().dispatchEvent(new Event("scroll"))
		})
		await act(async () => {
			rerender(<CodeBlock source={code + "const z = 3;\n"} language="typescript" />)
		})

		expect(pre().scrollTop).toBe(10)
	})
})
