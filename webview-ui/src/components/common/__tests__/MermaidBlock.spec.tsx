// npx vitest src/components/common/__tests__/MermaidBlock.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import MermaidBlock from "../MermaidBlock"

const parse = vi.fn()
const renderDiagram = vi.fn()
vi.mock("mermaid", () => ({
	default: {
		initialize: vi.fn(),
		parse: (...a: never[]) => parse(...a),
		render: (...a: never[]) => renderDiagram(...a),
	},
}))

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

const copyWithFeedback = vi.fn().mockResolvedValue(true)
vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback, showCopyFeedback: false }),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("../CodeBlock", () => ({
	default: ({ source }: { source: string }) => <pre data-testid="code-block">{source}</pre>,
}))

/** The debounce before mermaid is asked to render is 500ms. */
const settle = async () => {
	await act(async () => {
		vi.advanceTimersByTime(600)
	})
	await act(async () => {
		await Promise.resolve()
		await Promise.resolve()
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers()
	parse.mockResolvedValue(true)
	renderDiagram.mockResolvedValue({ svg: "<svg id='chart'><rect/></svg>" })
})

afterEach(() => vi.useRealTimers())

describe("MermaidBlock", () => {
	it("shows the loading message until the debounce elapses", async () => {
		render(<MermaidBlock code="graph TD; a-->b" />)
		expect(screen.getByText("common:mermaid.loading")).toBeInTheDocument()
		expect(parse).not.toHaveBeenCalled()

		await settle()
		expect(parse).toHaveBeenCalledWith("graph TD; a-->b")
		expect(screen.queryByText("common:mermaid.loading")).not.toBeInTheDocument()
	})

	it("injects the rendered svg into the container", async () => {
		const { container } = render(<MermaidBlock code="graph TD; a-->b" />)
		await settle()
		expect(container.querySelector("svg#chart")).toBeTruthy()
	})

	it("surfaces a parse failure, collapsed, and expands to the source", async () => {
		parse.mockRejectedValue(new Error("bad syntax on line 1"))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		render(<MermaidBlock code="not a diagram" />)
		await settle()

		expect(screen.getByText("common:mermaid.render_error")).toBeInTheDocument()
		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()

		fireEvent.click(screen.getByText("common:mermaid.render_error"))
		expect(screen.getByText("bad syntax on line 1")).toBeInTheDocument()
		expect(screen.getByTestId("code-block")).toHaveTextContent("not a diagram")
		warn.mockRestore()
	})

	it("falls back to a generic message when the failure carries none", async () => {
		parse.mockRejectedValue({})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		render(<MermaidBlock code="x" />)
		await settle()
		fireEvent.click(screen.getByText("common:mermaid.render_error"))
		expect(screen.getByText("Failed to render Mermaid diagram")).toBeInTheDocument()
		warn.mockRestore()
	})

	it("copies the error together with the source", async () => {
		parse.mockRejectedValue(new Error("boom"))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const { container } = render(<MermaidBlock code="graph X" />)
		await settle()

		await act(async () => {
			fireEvent.click(container.querySelector(".codicon-copy")!.closest("button")!)
		})
		expect(copyWithFeedback).toHaveBeenCalledWith("Error: boom\n\n```mermaid\ngraph X\n```", expect.anything())
		warn.mockRestore()
	})

	it("re-renders when the code changes and clears a previous error", async () => {
		parse.mockRejectedValueOnce(new Error("bad"))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const { rerender } = render(<MermaidBlock code="bad" />)
		await settle()
		expect(screen.getByText("common:mermaid.render_error")).toBeInTheDocument()

		rerender(<MermaidBlock code="good" />)
		await settle()
		expect(screen.queryByText("common:mermaid.render_error")).not.toBeInTheDocument()
		warn.mockRestore()
	})

	it("opens the diagram as an image when it is clicked", async () => {
		const { container } = render(<MermaidBlock code="graph TD; a-->b" />)
		await settle()

		// jsdom has no canvas, so the SVG→PNG step is stubbed at the Image seam:
		// firing `onload` synchronously lets the conversion resolve.
		const OriginalImage = window.Image
		class InstantImage {
			onload: (() => void) | null = null
			onerror: (() => void) | null = null
			set src(_v: string) {
				this.onload?.()
			}
		}
		;(window as unknown as { Image: unknown }).Image = InstantImage
		const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,ok")
		const getContext = vi
			.spyOn(HTMLCanvasElement.prototype, "getContext")
			.mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as never)

		await act(async () => {
			fireEvent.click(container.querySelector("svg")!.parentElement!)
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()
		})
		expect(postMessage).toHaveBeenCalledWith({ type: "openImage", text: "data:image/png;base64,ok" })
		;(window as unknown as { Image: unknown }).Image = OriginalImage
		toDataURL.mockRestore()
		getContext.mockRestore()
	})

	it("offers no toolbox for a non-interactive diagram", async () => {
		const { container } = render(<MermaidBlock code="graph TD; a-->b" interactive={false} />)
		await settle()

		fireEvent.mouseEnter(container.firstElementChild!)
		expect(container.querySelector(".codicon-zoom-in")).toBeNull()
	})
})
