import { Text } from "ink"
import { render } from "ink-testing-library"

import type { AutocompleteItem } from "../types.js"
import { PickerSelect, type PickerSelectProps } from "../PickerSelect.js"

const ESC = "\u001B"

const KEY = {
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	enter: "\r",
	escape: ESC,
} as const

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

interface Item extends AutocompleteItem {
	key: string
	label: string
}

const items = (count: number, from = 0): Item[] =>
	Array.from({ length: count }, (_, i) => ({ key: `k${from + i}`, label: `item-${from + i}` }))

const renderItem = (it: Item, isSelected: boolean) => <Text>{`${isSelected ? "> " : "  "}${it.label}`}</Text>

/** The non-varying half of the props, so a rerender changes only what it means to. */
const pickerProps = (results: Item[]) => ({
	results,
	maxVisible: 5,
	onSelect: () => {},
	onEscape: () => {},
	onIndexChange: () => {},
	renderItem,
})

function renderPicker(props: Partial<PickerSelectProps<Item>> = {}) {
	const merged: PickerSelectProps<Item> = {
		results: items(3),
		selectedIndex: 0,
		onSelect: () => {},
		onEscape: () => {},
		onIndexChange: () => {},
		renderItem,
		...props,
	}
	const result = render(<PickerSelect {...merged} />)
	return {
		...result,
		async press(sequence: string) {
			await tick()
			result.stdin.write(sequence)
			await tick()
		},
	}
}

describe("PickerSelect", () => {
	describe("rendering", () => {
		it("renders every result when they fit", () => {
			const { lastFrame } = renderPicker()
			const output = lastFrame() ?? ""

			expect(output).toContain("item-0")
			expect(output).toContain("item-1")
			expect(output).toContain("item-2")
		})

		it("marks the selected item", () => {
			const { lastFrame } = renderPicker({ selectedIndex: 1 })
			expect(lastFrame()).toContain("> item-1")
		})

		it("shows the default empty message", () => {
			const { lastFrame } = renderPicker({ results: [] })
			expect(lastFrame()).toContain("No results found")
		})

		it("shows a custom empty message", () => {
			const { lastFrame } = renderPicker({ results: [], emptyMessage: "Nothing here" })
			expect(lastFrame()).toContain("Nothing here")
		})

		it("shows the searching message while loading with no results", () => {
			const { lastFrame } = renderPicker({ results: [], isLoading: true })
			const output = lastFrame() ?? ""

			expect(output).toContain("Searching...")
			expect(output).not.toContain("No results found")
		})
	})

	describe("windowing", () => {
		it("caps the rendered rows at maxVisible", () => {
			const { lastFrame } = renderPicker({ results: items(20), maxVisible: 5 })
			const output = lastFrame() ?? ""

			expect(output).toContain("item-0")
			expect(output).not.toContain("item-19")
		})

		it("reports how many results are below the window", () => {
			const { lastFrame } = renderPicker({ results: items(20), maxVisible: 5 })
			expect(lastFrame()).toContain("↓")
		})

		it("scrolls the window down to keep a later selection visible", () => {
			const props = pickerProps(items(20))
			const { lastFrame, rerender } = render(<PickerSelect {...props} selectedIndex={0} />)
			expect(lastFrame()).toContain("item-0")

			rerender(<PickerSelect {...props} selectedIndex={12} />)

			// The window follows the selection: it now ends just past index 12,
			// so eight results sit above it. (The box is `maxVisible` rows tall
			// and the indicators take rows of their own, so the tail of the
			// window is clipped out of the frame — assert on the window, not on
			// the selected row.)
			expect(lastFrame()).toContain("↑ 8 more")
		})

		it("scrolls the window back up for an earlier selection", () => {
			const props = pickerProps(items(20))
			const { lastFrame, rerender } = render(<PickerSelect {...props} selectedIndex={0} />)

			rerender(<PickerSelect {...props} selectedIndex={15} />)
			expect(lastFrame()).toContain("↑ 11 more")

			rerender(<PickerSelect {...props} selectedIndex={1} />)

			expect(lastFrame()).toContain("↑ 1 more")
		})

		it("keeps the window put while the selection stays inside it", () => {
			const renderItem = (it: Item, sel: boolean) => <Text>{`${sel ? "> " : "  "}${it.label}`}</Text>
			const props = {
				results: items(20),
				maxVisible: 5,
				onSelect: () => {},
				onEscape: () => {},
				onIndexChange: () => {},
				renderItem,
			}
			const { lastFrame, rerender } = render(<PickerSelect {...props} selectedIndex={0} />)

			rerender(<PickerSelect {...props} selectedIndex={2} />)

			const output = lastFrame() ?? ""
			expect(output).toContain("item-0")
			expect(output).toContain("> item-2")
			expect(output).not.toContain("↑")
		})

		it("clamps the window when the result set shrinks under it", () => {
			const { lastFrame, rerender } = render(<PickerSelect {...pickerProps(items(20))} selectedIndex={15} />)
			rerender(<PickerSelect {...pickerProps(items(20))} selectedIndex={15} />)
			expect(lastFrame()).toContain("↑ 11 more")

			rerender(<PickerSelect {...pickerProps(items(17))} selectedIndex={15} />)

			// Still inside the window, so the window holds — clamped to the
			// shorter list rather than recomputed.
			expect(lastFrame()).toContain("↑ 11 more")
		})

		it("computes a fresh window when results arrive into an empty picker", () => {
			// The window ref starts at {from: 0, to: 0} for an empty result set,
			// which is the "no previous window" branch the first real results hit.
			const { lastFrame, rerender } = render(<PickerSelect {...pickerProps([])} selectedIndex={0} />)
			expect(lastFrame()).toContain("No results found")

			rerender(<PickerSelect {...pickerProps(items(20))} selectedIndex={3} />)

			expect(lastFrame()).toContain("↑ 3 more")
		})

		it("renders nothing above the window at the top of the list", () => {
			const { lastFrame } = renderPicker({ results: items(20), maxVisible: 5, selectedIndex: 0 })
			expect(lastFrame()).not.toContain("↑")
		})

		it("stops reporting more below at the end of the list", () => {
			const props = pickerProps(items(8))
			const { lastFrame, rerender } = render(<PickerSelect {...props} selectedIndex={0} />)
			rerender(<PickerSelect {...props} selectedIndex={7} />)

			const output = lastFrame() ?? ""
			expect(output).toContain("↑ 3 more")
			expect(output).not.toContain("↓")
		})
	})

	describe("keyboard", () => {
		it("selects the highlighted item on enter", async () => {
			const onSelect = vi.fn()
			const { press } = renderPicker({ selectedIndex: 1, onSelect })

			await press(KEY.enter)

			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "k1" }))
		})

		it("does nothing on enter when the index points at no item", async () => {
			const onSelect = vi.fn()
			const { press } = renderPicker({ results: items(2), selectedIndex: 5, onSelect })

			await press(KEY.enter)

			expect(onSelect).not.toHaveBeenCalled()
		})

		it("reports escape", async () => {
			const onEscape = vi.fn()
			const { press } = renderPicker({ onEscape })

			await press(KEY.escape)

			expect(onEscape).toHaveBeenCalled()
		})

		it("moves the index down", async () => {
			const onIndexChange = vi.fn()
			const { press } = renderPicker({ selectedIndex: 0, onIndexChange })

			await press(KEY.down)

			expect(onIndexChange).toHaveBeenCalledWith(1)
		})

		it("wraps the index to the top from the last item", async () => {
			const onIndexChange = vi.fn()
			const { press } = renderPicker({ selectedIndex: 2, onIndexChange })

			await press(KEY.down)

			expect(onIndexChange).toHaveBeenCalledWith(0)
		})

		it("moves the index up", async () => {
			const onIndexChange = vi.fn()
			const { press } = renderPicker({ selectedIndex: 2, onIndexChange })

			await press(KEY.up)

			expect(onIndexChange).toHaveBeenCalledWith(1)
		})

		it("wraps the index to the bottom from the first item", async () => {
			const onIndexChange = vi.fn()
			const { press } = renderPicker({ selectedIndex: 0, onIndexChange })

			await press(KEY.up)

			expect(onIndexChange).toHaveBeenCalledWith(2)
		})

		it("ignores an unhandled key", async () => {
			const onSelect = vi.fn()
			const onIndexChange = vi.fn()
			const onEscape = vi.fn()
			const { press } = renderPicker({ onSelect, onIndexChange, onEscape })

			await press("q")

			expect(onSelect).not.toHaveBeenCalled()
			expect(onIndexChange).not.toHaveBeenCalled()
			expect(onEscape).not.toHaveBeenCalled()
		})

		it("takes no input when inactive", async () => {
			const onSelect = vi.fn()
			const onEscape = vi.fn()
			const { press } = renderPicker({ isActive: false, onSelect, onEscape })

			await press(KEY.enter)
			await press(KEY.escape)

			expect(onSelect).not.toHaveBeenCalled()
			expect(onEscape).not.toHaveBeenCalled()
		})
	})
})
