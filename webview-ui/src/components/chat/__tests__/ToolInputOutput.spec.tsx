// npx vitest src/components/chat/__tests__/ToolInputOutput.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ShoferSayTool } from "@shofer/types"

import { ToolInputSection, ToolOutputSection } from "../ToolInputOutput"

const experiments: { showToolInputOutput?: boolean } = { showToolInputOutput: true }
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ experiments }),
}))

vi.mock("../../common/CodeAccordion", () => ({
	default: ({ code, language }: { code: string; language: string }) => (
		<pre data-testid={`accordion-${language}`}>{code}</pre>
	),
}))

const onToggle = vi.fn()

beforeEach(() => {
	vi.clearAllMocks()
	experiments.showToolInputOutput = true
})

describe("ToolInputSection", () => {
	it("renders nothing while the experiment is off", () => {
		experiments.showToolInputOutput = false
		const { container } = render(
			<ToolInputSection tool={{ tool: "readFile" } as ShoferSayTool} isExpanded onToggle={onToggle} />,
		)
		expect(container).toBeEmptyDOMElement()
	})

	it("shows the header collapsed and the JSON once expanded", () => {
		const { rerender } = render(
			<ToolInputSection
				tool={{ tool: "readFile", path: "a.ts" } as ShoferSayTool}
				isExpanded={false}
				onToggle={onToggle}
			/>,
		)
		expect(screen.getByText("Input")).toBeInTheDocument()
		expect(screen.queryByTestId("accordion-json")).not.toBeInTheDocument()

		rerender(
			<ToolInputSection
				tool={{ tool: "readFile", path: "a.ts" } as ShoferSayTool}
				isExpanded
				onToggle={onToggle}
			/>,
		)
		expect(screen.getByTestId("accordion-json").textContent).toContain('"path": "a.ts"')
	})

	it("toggles from a click and from the keyboard", () => {
		render(<ToolInputSection tool={{ tool: "readFile" } as ShoferSayTool} isExpanded onToggle={onToggle} />)
		const header = screen.getByRole("button")

		fireEvent.click(header)
		fireEvent.keyDown(header, { key: "Enter" })
		fireEvent.keyDown(header, { key: " " })
		expect(onToggle).toHaveBeenCalledTimes(3)

		fireEvent.keyDown(header, { key: "a" })
		expect(onToggle).toHaveBeenCalledTimes(3)
	})

	it("summarises batch arrays and truncates long content and diffs", () => {
		render(
			<ToolInputSection
				tool={
					{
						tool: "readFile",
						batchFiles: [{}, {}, {}],
						batchDiffs: [{}],
						content: "x".repeat(600),
						diff: "y".repeat(600),
						nothing: undefined,
						alsoNothing: null,
					} as unknown as ShoferSayTool
				}
				isExpanded
				onToggle={onToggle}
			/>,
		)
		const json = screen.getByTestId("accordion-json").textContent!
		expect(json).toContain('"batchFiles": "[3 files]"')
		expect(json).toContain('"batchDiffs": "[1 diffs]"')
		expect(json).toContain("(600 chars total)")
		expect(json).not.toContain("nothing")
	})
})

describe("ToolOutputSection", () => {
	it("renders nothing while the experiment is off", () => {
		experiments.showToolInputOutput = false
		const { container } = render(<ToolOutputSection tool="readFile" output="hi" />)
		expect(container).toBeEmptyDOMElement()
	})

	it("reveals the output on click", () => {
		render(<ToolOutputSection tool="readFile" output="the result" />)
		expect(screen.queryByTestId("accordion-text")).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByTestId("accordion-text")).toHaveTextContent("the result")
	})

	it("reports the full size of a large output", () => {
		const output = "z".repeat(9000)
		render(<ToolOutputSection tool="readFile" output={output} />)

		fireEvent.click(screen.getByRole("button"))
		// NOTE: the component computes a truncated `displayContent` for the
		// not-expanded case, but the accordion only renders WHEN expanded — so
		// what a reader actually sees is always the full output.
		expect(screen.getByTestId("accordion-text").textContent).toHaveLength(9000)
		expect(screen.getByText(/9,000 chars total/)).toBeInTheDocument()
	})

	it("shows no size line for a small output", () => {
		render(<ToolOutputSection tool="readFile" output="tiny" />)
		fireEvent.click(screen.getByRole("button"))
		expect(screen.queryByText(/chars total/)).not.toBeInTheDocument()
	})

	it("toggles from the keyboard", () => {
		render(<ToolOutputSection tool="readFile" output="short" />)
		const header = screen.getByRole("button")
		fireEvent.keyDown(header, { key: "Enter" })
		expect(screen.getByTestId("accordion-text")).toBeInTheDocument()
		fireEvent.keyDown(header, { key: " " })
		expect(screen.queryByTestId("accordion-text")).not.toBeInTheDocument()
		fireEvent.keyDown(header, { key: "x" })
		expect(screen.queryByTestId("accordion-text")).not.toBeInTheDocument()
	})
})
