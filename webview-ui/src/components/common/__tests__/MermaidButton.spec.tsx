// npx vitest src/components/common/__tests__/MermaidButton.spec.tsx

import { createRef } from "react"
import { render, screen, fireEvent, waitFor, act } from "@/utils/test-utils"

import { MermaidButton } from "../MermaidButton"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

const copyWithFeedback = vi.fn().mockResolvedValue(true)
vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback, showCopyFeedback: false }),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const svgToPng = vi.fn().mockResolvedValue("data:image/png;base64,zzz")

/** A container ref that already holds a rendered diagram, as MermaidBlock's does. */
const diagramRef = () => {
	const ref = createRef<HTMLDivElement>() as React.MutableRefObject<HTMLDivElement | null>
	const el = document.createElement("div")
	el.innerHTML = "<svg><rect/></svg>"
	ref.current = el
	return ref as React.RefObject<HTMLDivElement>
}

const renderButton = (props: Partial<React.ComponentProps<typeof MermaidButton>> = {}) =>
	render(
		<MermaidButton
			containerRef={diagramRef()}
			code="graph TD; a-->b"
			isLoading={false}
			svgToPng={svgToPng}
			{...props}>
			<div data-testid="diagram">diagram</div>
		</MermaidButton>,
	)

const hoverToolbar = (container: HTMLElement) => fireEvent.mouseEnter(container.firstElementChild!)

// `IconButton` only carries an aria-label when it is given a `title`, and the
// mermaid toolbar labels via a tooltip instead — so the buttons are addressed
// by their codicon glyph, scoped to the toolbar or the modal.
const toolbar = () => document.querySelector(".absolute.bottom-2") as HTMLElement
const modal = () => document.querySelector(".fixed.inset-0") as HTMLElement
const btn = (scope: HTMLElement | null, icon: string, index = 0) => {
	const found = Array.from(scope?.querySelectorAll(`.codicon-${icon}`) ?? [])
	const el = found[index]?.closest("button")
	if (!el) throw new Error(`no button with icon ${icon} (#${index}) in scope`)
	return el as HTMLButtonElement
}

beforeEach(() => {
	vi.clearAllMocks()
	svgToPng.mockResolvedValue("data:image/png;base64,zzz")
})

describe("MermaidButton", () => {
	it("reveals the toolbar on hover and hides it again", () => {
		const { container } = renderButton()
		expect(toolbar()).toBeNull()

		hoverToolbar(container)
		expect(toolbar()).not.toBeNull()

		fireEvent.mouseLeave(container.firstElementChild!)
		expect(toolbar()).toBeNull()
	})

	it("keeps the toolbar hidden while the diagram is still rendering", () => {
		const { container } = renderButton({ isLoading: true })
		hoverToolbar(container)
		expect(toolbar()).toBeNull()
	})

	it("opens the modal on the diagram tab from Zoom", () => {
		const { container } = renderButton()
		hoverToolbar(container)
		fireEvent.click(btn(toolbar(), "zoom-in"))

		expect(screen.getByText("common:mermaid.tabs.diagram")).toBeInTheDocument()
		// Both the overlay badge and the footer control report the zoom level.
		expect(screen.getAllByText("100%")).toHaveLength(2)
	})

	it("opens the modal straight onto the code tab from View code", () => {
		const { container } = renderButton()
		hoverToolbar(container)
		fireEvent.click(btn(toolbar(), "code"))

		expect(screen.getByRole("textbox")).toHaveValue("graph TD; a-->b")
	})

	it("switches between the diagram and code tabs", () => {
		const { container } = renderButton()
		hoverToolbar(container)
		fireEvent.click(btn(toolbar(), "zoom-in"))

		fireEvent.click(screen.getByText("common:mermaid.tabs.code"))
		expect(screen.getByRole("textbox")).toBeInTheDocument()

		fireEvent.click(screen.getByText("common:mermaid.tabs.diagram"))
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})

	it("closes the modal from the close button and from the backdrop", () => {
		const { container } = renderButton()
		hoverToolbar(container)
		fireEvent.click(btn(toolbar(), "zoom-in"))

		fireEvent.click(btn(modal(), "close"))
		expect(screen.queryByText("common:mermaid.tabs.diagram")).not.toBeInTheDocument()

		fireEvent.click(btn(toolbar(), "zoom-in"))
		const backdrop = document.querySelector(".fixed.inset-0") as HTMLElement
		fireEvent.click(backdrop.firstElementChild as HTMLElement)
		expect(screen.getByText("common:mermaid.tabs.diagram")).toBeInTheDocument()
		fireEvent.click(backdrop)
		expect(screen.queryByText("common:mermaid.tabs.diagram")).not.toBeInTheDocument()
	})

	it("copies the diagram source and flashes the check glyph", async () => {
		vi.useFakeTimers()
		const { container } = renderButton()
		hoverToolbar(container)

		await act(async () => {
			fireEvent.click(btn(toolbar(), "copy"))
		})
		expect(copyWithFeedback).toHaveBeenCalledWith("graph TD; a-->b", expect.anything())
		expect(document.querySelector(".codicon-check")).toBeTruthy()

		act(() => {
			vi.advanceTimersByTime(2000)
		})
		expect(document.querySelector(".codicon-check")).toBeNull()
		vi.useRealTimers()
	})

	it("survives a clipboard failure", async () => {
		copyWithFeedback.mockRejectedValueOnce(new Error("denied"))
		const spy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { container } = renderButton()
		hoverToolbar(container)

		await act(async () => {
			fireEvent.click(btn(toolbar(), "copy"))
		})
		expect(spy).toHaveBeenCalled()
		spy.mockRestore()
	})

	it("saves the diagram as a PNG through the host", async () => {
		const { container } = renderButton()
		hoverToolbar(container)

		await act(async () => {
			fireEvent.click(btn(toolbar(), "save"))
		})
		await waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith({ type: "saveImage", dataUri: "data:image/png;base64,zzz" }),
		)
	})

	it("reports a conversion failure rather than posting a broken image", async () => {
		svgToPng.mockRejectedValueOnce(new Error("no canvas"))
		const spy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { container } = renderButton()
		hoverToolbar(container)

		await act(async () => {
			fireEvent.click(btn(toolbar(), "save"))
		})
		expect(postMessage).not.toHaveBeenCalled()
		expect(spy).toHaveBeenCalled()
		spy.mockRestore()
	})

	it("refuses to save when the container holds no svg", async () => {
		const emptyRef = { current: document.createElement("div") } as React.RefObject<HTMLDivElement>
		const spy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { container } = render(
			<MermaidButton containerRef={emptyRef} code="x" isLoading={false} svgToPng={svgToPng}>
				<div />
			</MermaidButton>,
		)
		hoverToolbar(container)

		await act(async () => {
			fireEvent.click(btn(toolbar(), "save"))
		})
		expect(svgToPng).not.toHaveBeenCalled()
		expect(spy).toHaveBeenCalledWith("SVG element not found")
		spy.mockRestore()
	})

	it("zooms the modal with the wheel, clamped at both ends", () => {
		const { container } = renderButton()
		hoverToolbar(container)
		fireEvent.click(btn(toolbar(), "zoom-in"))

		const canvas = document.querySelector('[class^="flex-1 p-4"]') as HTMLElement
		fireEvent.wheel(canvas, { deltaY: -1 })
		expect(screen.getAllByText("120%").length).toBeGreaterThan(0)

		for (let i = 0; i < 10; i++) fireEvent.wheel(canvas, { deltaY: 1 })
		expect(screen.getAllByText("50%").length).toBeGreaterThan(0)
	})

	it("zooms the modal from the footer controls, held down for continuous zoom", () => {
		vi.useFakeTimers()
		const { container } = renderButton()
		hoverToolbar(container)
		fireEvent.click(btn(toolbar(), "zoom-in"))

		const zoomIn = btn(modal(), "zoom-in")
		fireEvent.mouseDown(zoomIn)
		expect(screen.getAllByText("120%").length).toBeGreaterThan(0)

		act(() => {
			vi.advanceTimersByTime(300)
		})
		expect(screen.getAllByText("160%").length).toBeGreaterThan(0)

		fireEvent.mouseUp(zoomIn)
		act(() => {
			vi.advanceTimersByTime(600)
		})
		expect(screen.getAllByText("160%").length).toBeGreaterThan(0)

		// Mouse-leave also stops a held zoom.
		const zoomOut = btn(modal(), "zoom-out")
		fireEvent.mouseDown(zoomOut)
		fireEvent.mouseLeave(zoomOut)
		act(() => {
			vi.advanceTimersByTime(600)
		})
		expect(screen.getAllByText("140%").length).toBeGreaterThan(0)
		vi.useRealTimers()
	})

	it("pans the diagram while the pointer is held down", () => {
		const { container } = renderButton()
		hoverToolbar(container)
		fireEvent.click(btn(toolbar(), "zoom-in"))

		const pane = document.querySelector('[style*="transform: scale"]') as HTMLElement
		// jsdom does not populate `movementX`/`movementY` from a MouseEvent init.
		const drag = (dx: number, dy: number) => {
			const event = new MouseEvent("mousemove", { bubbles: true })
			Object.defineProperty(event, "movementX", { value: dx })
			Object.defineProperty(event, "movementY", { value: dy })
			fireEvent(pane, event)
		}

		drag(10, 5)
		expect(pane.style.transform).toContain("translate(0px, 0px)")

		fireEvent.mouseDown(pane)
		expect(pane.style.cursor).toBe("grabbing")
		drag(10, 5)
		expect(pane.style.transform).toContain("translate(10px, 5px)")

		fireEvent.mouseUp(pane)
		expect(pane.style.cursor).toBe("grab")
		drag(10, 5)
		expect(pane.style.transform).toContain("translate(10px, 5px)")

		fireEvent.mouseDown(pane)
		fireEvent.mouseLeave(pane)
		drag(10, 5)
		expect(pane.style.transform).toContain("translate(10px, 5px)")
	})

	it("copies from the code tab's own copy button", async () => {
		const { container } = renderButton()
		hoverToolbar(container)
		fireEvent.click(btn(toolbar(), "code"))

		await act(async () => {
			fireEvent.click(btn(modal(), "copy"))
		})
		expect(copyWithFeedback).toHaveBeenCalledWith("graph TD; a-->b", expect.anything())
	})
})
