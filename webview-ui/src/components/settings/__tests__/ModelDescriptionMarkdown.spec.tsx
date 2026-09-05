// npx vitest src/components/settings/__tests__/ModelDescriptionMarkdown.spec.tsx
//
// The clamped model blurb under the model picker. The More/Less affordance is
// not driven by the text's length but by a MEASUREMENT — it appears only when
// the rendered markdown actually overflows four lines — which is why jsdom's
// zero-height layout has to be stubbed for the expandable case.

import { render, screen, fireEvent } from "@/utils/test-utils"

import { ModelDescriptionMarkdown } from "../ModelDescriptionMarkdown"

vi.mock("react-remark", () => ({
	useRemark: () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mockReact = require("react")
		const [content, setContent] = mockReact.useState(null)
		return [content, setContent]
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, ...rest }: any) => <a {...rest}>{children}</a>,
}))

const setIsExpanded = vi.fn()

const renderIt = (props: Record<string, unknown> = {}) =>
	render(
		<ModelDescriptionMarkdown
			markdown="A capable model."
			key="claude"
			isExpanded={false}
			setIsExpanded={setIsExpanded}
			{...(props as object)}
		/>,
	)

/** Make the inner text taller than its clamping container. */
const overflowing = () => {
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500)
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80)
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe("ModelDescriptionMarkdown", () => {
	it("renders the description", () => {
		renderIt()
		expect(screen.getByText("A capable model.")).toBeInTheDocument()
	})

	it("clamps the text while collapsed and stops clamping when expanded", () => {
		const { container, rerender } = renderIt()
		expect(container.querySelector(".line-clamp-4")).toBeTruthy()

		rerender(
			<ModelDescriptionMarkdown markdown="A capable model." key="claude" isExpanded setIsExpanded={vi.fn()} />,
		)
		expect(container.querySelector(".line-clamp-4")).toBeFalsy()
	})

	it("hides the More link when the text already fits", () => {
		const { container } = renderIt()
		expect(container.querySelector("a")).toHaveClass("hidden")
	})

	it("offers More when the text overflows, and reports the toggle upward", () => {
		overflowing()
		const { container } = renderIt()

		const link = container.querySelector("a") as HTMLElement
		expect(link).not.toHaveClass("hidden")
		expect(link).toHaveTextContent("More")

		fireEvent.click(link)
		expect(setIsExpanded).toHaveBeenCalledWith(true)
	})

	it("says Less once expanded", () => {
		overflowing()
		const { container } = renderIt({ isExpanded: true })
		expect(container.querySelector("a")).toHaveTextContent("Less")
	})

	it("renders an empty description without a toggle", () => {
		const { container } = renderIt({ markdown: undefined })
		expect(container.querySelector("a")).toHaveClass("hidden")
	})
})
