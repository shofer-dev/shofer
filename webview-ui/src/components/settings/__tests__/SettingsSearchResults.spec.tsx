// npx vitest src/components/settings/__tests__/SettingsSearchResults.spec.tsx

import { Bot, Cog } from "lucide-react"
import { render, screen, fireEvent } from "@/utils/test-utils"

import { SettingsSearchResults } from "../SettingsSearchResults"
import type { SearchResult } from "../useSettingsSearch"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${Object.values(opts).join(",")}` : key),
	}),
}))

const result = (over: Partial<SearchResult> & { settingId: string }): SearchResult =>
	({
		section: "providers",
		label: `label ${over.settingId}`,
		sectionLabel: "Providers",
		positions: new Set<number>(),
		...over,
	}) as SearchResult

const sections = [
	{ id: "providers", icon: Bot },
	{ id: "browser", icon: Cog },
] as never

const onSelectResult = vi.fn()

const renderResults = (results: SearchResult[], highlightedResultId?: string) =>
	render(
		<SettingsSearchResults
			results={results}
			query="term"
			onSelectResult={onSelectResult}
			sections={sections}
			highlightedResultId={highlightedResultId}
		/>,
	)

beforeEach(() => vi.clearAllMocks())

describe("SettingsSearchResults", () => {
	it("says so, with the query, when nothing matched", () => {
		renderResults([])
		expect(screen.getByText("settings:search.noResults:term")).toBeInTheDocument()
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
	})

	it("groups results under their section header", () => {
		renderResults([
			result({ settingId: "a" }),
			result({ settingId: "b" }),
			result({ settingId: "c", section: "browser" as never }),
		])

		expect(screen.getByText("settings:sections.providers")).toBeInTheDocument()
		expect(screen.getByText("settings:sections.browser")).toBeInTheDocument()
		expect(screen.getAllByRole("option")).toHaveLength(3)
	})

	it("renders a section with no registered icon", () => {
		renderResults([result({ settingId: "a", section: "unknown-section" as never })])
		expect(screen.getByText("settings:sections.unknown-section")).toBeInTheDocument()
	})

	it("selects a result on click, and suppresses the mousedown that would blur the input", () => {
		const target = result({ settingId: "a" })
		renderResults([target])

		const option = screen.getByRole("option")
		const mouseDown = fireEvent.mouseDown(option)
		expect(mouseDown).toBe(false) // preventDefault() was called

		fireEvent.click(option)
		expect(onSelectResult).toHaveBeenCalledWith(target)
	})

	it("marks the highlighted result as selected", () => {
		renderResults([result({ settingId: "a" }), result({ settingId: "b" })], "b")
		const options = screen.getAllByRole("option")
		expect(options[0]).toHaveAttribute("aria-selected", "false")
		expect(options[1]).toHaveAttribute("aria-selected", "true")
	})

	it("emphasises the matched characters and leaves the rest plain", () => {
		const { container } = renderResults([
			result({ settingId: "a", label: "Auto approve", positions: new Set([0, 1, 5, 6]) }),
		])

		const marks = Array.from(container.querySelectorAll("mark")).map((m) => m.textContent)
		expect(marks).toEqual(["Au", "ap"])
		expect(screen.getByRole("option").textContent).toBe("Auto approve")
	})

	it("renders a label with no matched positions as one plain run", () => {
		const { container } = renderResults([result({ settingId: "a", label: "Plain label" })])
		expect(container.querySelectorAll("mark")).toHaveLength(0)
		expect(screen.getByRole("option").textContent).toBe("Plain label")
	})

	it("emphasises a match that runs to the end of the label", () => {
		const { container } = renderResults([result({ settingId: "a", label: "abc", positions: new Set([1, 2]) })])
		expect(Array.from(container.querySelectorAll("mark")).map((m) => m.textContent)).toEqual(["bc"])
	})
})
