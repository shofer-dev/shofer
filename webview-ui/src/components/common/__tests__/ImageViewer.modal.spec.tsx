// npx vitest src/components/common/__tests__/ImageViewer.modal.spec.tsx
//
// The hover toolbar and the zoom modal an image row offers: copying the file
// path, saving through the host, opening it in an editor, and the modal's
// zoom/pan controls.

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { ImageViewer } from "../ImageViewer"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

const copyWithFeedback = vi.fn().mockResolvedValue(true)
vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback, showCopyFeedback: false }),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const renderViewer = (props: Partial<React.ComponentProps<typeof ImageViewer>> = {}) =>
	render(<ImageViewer imageUri="vscode-resource://img.png" imagePath="/out/img.png" {...props} />)

const toolbar = () => document.querySelector(".absolute.bottom-2") as HTMLElement | null
const modal = () => document.querySelector(".fixed.inset-0") as HTMLElement | null
const btn = (scope: HTMLElement | null, icon: string, index = 0) => {
	const found = Array.from(scope?.querySelectorAll(`.codicon-${icon}`) ?? [])
	const el = found[index]?.closest("button")
	if (!el) throw new Error(`no button with icon ${icon} (#${index})`)
	return el as HTMLButtonElement
}

const hover = (container: HTMLElement) => fireEvent.mouseEnter(container.firstElementChild!)

beforeEach(() => {
	vi.clearAllMocks()
	copyWithFeedback.mockResolvedValue(true)
})

describe("the hover toolbar", () => {
	it("appears on hover and disappears again", () => {
		const { container } = renderViewer()
		expect(toolbar()).toBeNull()

		hover(container)
		expect(toolbar()).not.toBeNull()

		fireEvent.mouseLeave(container.firstElementChild!)
		expect(toolbar()).toBeNull()
	})

	it("is suppressed when the caller hides the controls", () => {
		const { container } = renderViewer({ showControls: false })
		hover(container)
		expect(toolbar()).toBeNull()
	})

	it("copies the file path and flashes the check glyph", async () => {
		vi.useFakeTimers()
		const { container } = renderViewer()
		hover(container)

		await act(async () => {
			fireEvent.click(btn(toolbar(), "copy"))
		})
		expect(copyWithFeedback).toHaveBeenCalledWith("/out/img.png", expect.anything())
		expect(document.querySelector(".codicon-check")).toBeTruthy()

		act(() => {
			vi.advanceTimersByTime(2000)
		})
		expect(document.querySelector(".codicon-check")).toBeNull()
		vi.useRealTimers()
	})

	it("copies nothing when there is no path to copy", async () => {
		const { container } = renderViewer({ imagePath: undefined })
		hover(container)
		await act(async () => {
			fireEvent.click(btn(toolbar(), "copy"))
		})
		expect(copyWithFeedback).not.toHaveBeenCalled()
	})

	it("reports a clipboard failure rather than throwing", async () => {
		copyWithFeedback.mockRejectedValueOnce(new Error("denied"))
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const { container } = renderViewer()
		hover(container)

		await act(async () => {
			fireEvent.click(btn(toolbar(), "copy"))
		})
		expect(error).toHaveBeenCalled()
		error.mockRestore()
	})

	it("asks the host to save the image", async () => {
		const { container } = renderViewer()
		hover(container)

		await act(async () => {
			fireEvent.click(btn(toolbar(), "save"))
		})
		expect(postMessage).toHaveBeenCalledWith({ type: "saveImage", dataUri: "vscode-resource://img.png" })
	})
})

describe("the zoom modal", () => {
	const open = (container: HTMLElement) => {
		hover(container)
		fireEvent.click(btn(toolbar(), "zoom-in"))
	}

	it("opens at 100% and closes from the close button", () => {
		const { container } = renderViewer()
		open(container)
		expect(screen.getAllByText("100%").length).toBeGreaterThan(0)

		fireEvent.click(btn(modal(), "close"))
		expect(modal()).toBeNull()
	})

	it("closes when the backdrop is clicked but not the panel", () => {
		const { container } = renderViewer()
		open(container)

		const backdrop = modal()!
		fireEvent.click(backdrop.firstElementChild as HTMLElement)
		expect(modal()).not.toBeNull()

		fireEvent.click(backdrop)
		expect(modal()).toBeNull()
	})

	it("zooms with the wheel, clamped at both ends", () => {
		const { container } = renderViewer()
		open(container)

		const canvas = document.querySelector('[class^="flex-1"]') as HTMLElement
		fireEvent.wheel(canvas, { deltaY: -1 })
		expect(screen.getAllByText("120%").length).toBeGreaterThan(0)

		for (let i = 0; i < 12; i++) fireEvent.wheel(canvas, { deltaY: 1 })
		expect(screen.getAllByText("50%").length).toBeGreaterThan(0)
	})

	it("zooms from the footer controls", () => {
		const { container } = renderViewer()
		open(container)

		fireEvent.mouseDown(btn(modal(), "zoom-in"))
		expect(screen.getAllByText("120%").length).toBeGreaterThan(0)
		fireEvent.mouseUp(btn(modal(), "zoom-in"))
	})

	it("pans while the pointer is held", () => {
		const { container } = renderViewer()
		open(container)

		const pane = document.querySelector('[style*="transform: scale"]') as HTMLElement
		const drag = (dx: number, dy: number) => {
			const event = new MouseEvent("mousemove", { bubbles: true })
			Object.defineProperty(event, "movementX", { value: dx })
			Object.defineProperty(event, "movementY", { value: dy })
			fireEvent(pane, event)
		}

		drag(10, 5)
		expect(pane.style.transform).toContain("translate(0px, 0px)")

		fireEvent.mouseDown(pane)
		drag(10, 5)
		expect(pane.style.transform).toContain("translate(10px, 5px)")

		fireEvent.mouseUp(pane)
		drag(10, 5)
		expect(pane.style.transform).toContain("translate(10px, 5px)")
	})
})

describe("failure and empty states", () => {
	it("shows an error placeholder when the image fails to load", () => {
		renderViewer()
		fireEvent.error(screen.getByRole("img"))
		expect(screen.queryByRole("img")).not.toBeInTheDocument()
	})

	it("says so when there is no image at all", () => {
		const { container } = renderViewer({ imageUri: "" })
		expect(container.querySelector("img")).toBeNull()
	})
})
