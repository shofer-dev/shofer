// npx vitest src/components/common/__tests__/CodeAccordion.spec.tsx
//
// The collapsible code panel every tool row wraps its payload in. Its header
// has four mutually exclusive shapes (server header, user-edits feedback, a
// path, none at all), and the body is either a diff or a highlighted block —
// chosen by LANGUAGE, not by whether the text looks like a diff.

import { render, screen, fireEvent } from "@/utils/test-utils"

import CodeAccordion from "../CodeAccordion"

vi.mock("../CodeBlock", () => ({
	default: ({ source, language }: { source: string; language: string }) => (
		<div data-testid="code-block" data-language={language}>
			{source}
		</div>
	),
}))
vi.mock("../DiffView", () => ({
	default: ({ source, filePath }: { source: string; filePath?: string }) => (
		<div data-testid="diff-view" data-path={filePath ?? ""}>
			{source}
		</div>
	),
}))

const onToggleExpand = vi.fn()
const onJumpToFile = vi.fn()

const renderIt = (props: Record<string, unknown> = {}) =>
	render(<CodeAccordion language="ts" isExpanded={false} onToggleExpand={onToggleExpand} {...(props as object)} />)

const icon = (name: string) => document.querySelector(`.codicon-${name}`)

beforeEach(() => vi.clearAllMocks())

describe("the header", () => {
	it("names the file, and toggles when clicked", () => {
		renderIt({ path: "src/app.ts", code: "const a = 1" })

		// The label carries a trailing LRM mark, so it is matched by prefix.
		const label = screen.getByText((text) => text.startsWith("src/app.ts"))
		expect(label).toBeInTheDocument()
		fireEvent.click(label)
		expect(onToggleExpand).toHaveBeenCalled()
	})

	it("prefers an explicit header over the path", () => {
		renderIt({ path: "src/app.ts", header: "weather-server", code: "x" })

		expect(screen.getByText("weather-server")).toBeInTheDocument()
		expect(icon("server")).toBeTruthy()
	})

	it("labels a feedback payload as user edits", () => {
		renderIt({ isFeedback: true, code: "x" })
		expect(screen.getByText("User Edits")).toBeInTheDocument()
	})

	it("shows a progress ring while the tool is still running", () => {
		renderIt({ path: "a.ts", isLoading: true, code: "x" })
		expect(document.querySelector("vscode-progress-ring")).toBeTruthy()
	})

	it("renders the tool's own progress text and icon", () => {
		renderIt({ path: "a.ts", code: "x", progressStatus: { text: "3 matches", icon: "search" } })

		expect(screen.getByText("3 matches")).toBeInTheDocument()
		expect(icon("search")).toBeTruthy()
	})

	it("prefers diff stats over the progress indicator", () => {
		renderIt({
			path: "a.ts",
			code: "x",
			progressStatus: { text: "3 matches" },
			diffStats: { added: 4, removed: 2 },
		})

		expect(screen.queryByText("3 matches")).not.toBeInTheDocument()
		expect(screen.getByText(/4/)).toBeInTheDocument()
	})

	it("ignores an empty diff-stat pair", () => {
		renderIt({
			path: "a.ts",
			code: "x",
			progressStatus: { text: "3 matches" },
			diffStats: { added: 0, removed: 0 },
		})
		expect(screen.getByText("3 matches")).toBeInTheDocument()
	})

	it("offers a jump-to-file affordance without toggling the panel", () => {
		renderIt({ path: "src/app.ts", code: "x", onJumpToFile })

		fireEvent.click(screen.getByLabelText("Open file: src/app.ts"))
		expect(onJumpToFile).toHaveBeenCalled()
		expect(onToggleExpand).not.toHaveBeenCalled()
	})

	it("shows the chevron only when there is no jump affordance", () => {
		const { unmount } = renderIt({ path: "a.ts", code: "x" })
		expect(icon("chevron-down")).toBeTruthy()
		unmount()

		renderIt({ path: "a.ts", code: "x", isExpanded: true })
		expect(icon("chevron-up")).toBeTruthy()
	})
})

describe("the body", () => {
	it("stays collapsed behind a header until expanded", () => {
		const { rerender } = renderIt({ path: "a.ts", code: "const a = 1" })
		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()

		rerender(<CodeAccordion language="ts" path="a.ts" code="const a = 1" isExpanded onToggleExpand={vi.fn()} />)
		expect(screen.getByTestId("code-block")).toBeInTheDocument()
	})

	it("is always visible when there is no header to collapse behind", () => {
		renderIt({ code: "const a = 1" })
		expect(screen.getByTestId("code-block")).toHaveTextContent("const a = 1")
	})

	it("trims the payload before rendering it", () => {
		renderIt({ code: "\n\n  const a = 1  \n\n" })
		expect(screen.getByTestId("code-block")).toHaveTextContent("const a = 1")
	})

	it("renders a diff through the diff view, carrying the path", () => {
		renderIt({ language: "diff", path: "src/app.ts", isExpanded: true, code: "@@ -1 +1 @@" })

		expect(screen.getByTestId("diff-view")).toHaveAttribute("data-path", "src/app.ts")
		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
	})

	it("passes the declared language through to the highlighter", () => {
		renderIt({ language: "python", code: "x = 1" })
		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "python")
	})
})
