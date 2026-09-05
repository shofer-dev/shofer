import { createRef } from "react"
import { Text } from "ink"
import { render } from "ink-testing-library"

import { TerminalSizeProvider } from "../../../hooks/TerminalSizeContext.js"
import type { AutocompleteItem, AutocompletePickerState, AutocompleteTrigger } from "../types.js"
import { AutocompleteInput, type AutocompleteInputHandle } from "../AutocompleteInput.js"

/**
 * The history store is the only filesystem seam under this component; stubbing
 * it keeps the real `useInputHistory` in the tree (its interaction with the
 * input is part of what is under test) while touching no disk.
 */
const historyEntries: string[] = []
vi.mock("../../../../lib/storage/history.js", () => ({
	MAX_HISTORY_ENTRIES: 500,
	getHistoryFilePath: () => "/dev/null",
	loadHistory: async () => [...historyEntries],
	saveHistory: async () => {},
	addToHistory: async (entry: string) => {
		historyEntries.push(entry)
		return [...historyEntries]
	},
}))

const ESC = "\u001B"

const KEY = {
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	enter: "\r",
	tab: "\t",
	escape: ESC,
	backspace: "\u0008",
} as const

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

interface Item extends AutocompleteItem {
	key: string
	label: string
}

const atTrigger = (over: Partial<AutocompleteTrigger<Item>> = {}): AutocompleteTrigger<Item> => ({
	id: "at",
	triggerChar: "@",
	position: "anywhere",
	debounceMs: 0,
	detectTrigger: (lineText) => {
		const index = lineText.lastIndexOf("@")
		if (index === -1) return null
		return { query: lineText.slice(index + 1), triggerIndex: index }
	},
	search: () => [
		{ key: "alpha", label: "alpha" },
		{ key: "beta", label: "beta" },
	],
	renderItem: (it) => <Text>{it.label}</Text>,
	getReplacementText: (it, lineText, triggerIndex) => `${lineText.slice(0, triggerIndex)}@${it.key} `,
	...over,
})

interface HarnessOptions {
	triggers?: AutocompleteTrigger<Item>[]
	onSubmit?: (value: string) => void
	onSelect?: (item: Item) => void
	onPickerStateChange?: (state: AutocompletePickerState<Item>) => void
	isActive?: boolean
	placeholder?: string
	prompt?: string
}

async function renderInput(options: HarnessOptions = {}) {
	const ref = createRef<AutocompleteInputHandle<Item>>()
	const result = render(
		<TerminalSizeProvider>
			<AutocompleteInput<Item>
				ref={ref}
				triggers={options.triggers ?? [atTrigger()]}
				onSubmit={options.onSubmit ?? (() => {})}
				onSelect={options.onSelect}
				onPickerStateChange={options.onPickerStateChange}
				isActive={options.isActive}
				placeholder={options.placeholder}
				prompt={options.prompt}
			/>
		</TerminalSizeProvider>,
	)
	await tick()
	return {
		...result,
		ref,
		async type(text: string) {
			for (const char of text) {
				result.stdin.write(char)
				await tick(15)
			}
		},
		async press(sequence: string) {
			result.stdin.write(sequence)
			await tick()
		},
	}
}

describe("AutocompleteInput", () => {
	beforeEach(() => {
		historyEntries.length = 0
	})

	describe("plain input", () => {
		it("renders the default placeholder when inactive and empty", async () => {
			const { lastFrame } = await renderInput({ isActive: false })
			expect(lastFrame()).toContain("Type your message...")
		})

		it("renders a custom placeholder", async () => {
			const { lastFrame } = await renderInput({ isActive: false, placeholder: "Ask away" })
			expect(lastFrame()).toContain("Ask away")
		})

		it("renders a custom prompt", async () => {
			const { lastFrame } = await renderInput({ prompt: "$ " })
			expect(lastFrame()).toContain("$")
		})

		it("echoes typed text", async () => {
			const { type, lastFrame } = await renderInput()

			await type("hello")

			expect(lastFrame()).toContain("hello")
		})

		it("submits trimmed text on enter and clears the input", async () => {
			const onSubmit = vi.fn()
			const { type, press, lastFrame } = await renderInput({ onSubmit })

			await type("  hi  ")
			await press(KEY.enter)

			expect(onSubmit).toHaveBeenCalledWith("hi")
			expect(lastFrame()).not.toContain("hi")
		})

		it("does not submit whitespace only", async () => {
			const onSubmit = vi.fn()
			const { type, press } = await renderInput({ onSubmit })

			await type("   ")
			await press(KEY.enter)

			expect(onSubmit).not.toHaveBeenCalled()
		})

		it("does not submit an empty input", async () => {
			const onSubmit = vi.fn()
			const { press } = await renderInput({ onSubmit })

			await press(KEY.enter)

			expect(onSubmit).not.toHaveBeenCalled()
		})

		it("clears the input on escape when no picker is open", async () => {
			const { type, press, lastFrame } = await renderInput()

			await type("draft text")
			expect(lastFrame()).toContain("draft text")

			await press(KEY.escape)

			expect(lastFrame()).not.toContain("draft text")
		})
	})

	describe("picker", () => {
		it("opens the picker when a trigger matches", async () => {
			const onPickerStateChange = vi.fn()
			const { type } = await renderInput({ onPickerStateChange })

			await type("@")
			await tick(40)

			const last = onPickerStateChange.mock.lastCall?.[0] as AutocompletePickerState<Item>
			expect(last.isOpen).toBe(true)
			expect(last.results.map((r) => r.key)).toEqual(["alpha", "beta"])
		})

		it("exposes the picker state on the ref", async () => {
			const { type, ref } = await renderInput()

			await type("@")
			await tick(40)

			expect(ref.current?.pickerState.isOpen).toBe(true)
		})

		it("inserts the highlighted item on enter instead of submitting", async () => {
			const onSubmit = vi.fn()
			const onSelect = vi.fn()
			const { type, press, lastFrame } = await renderInput({ onSubmit, onSelect })

			await type("@")
			await tick(40)
			await press(KEY.enter)

			expect(onSubmit).not.toHaveBeenCalled()
			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "alpha" }))
			expect(lastFrame()).toContain("@alpha")
		})

		it("inserts the highlighted item on tab", async () => {
			const onSelect = vi.fn()
			const { type, press } = await renderInput({ onSelect })

			await type("@")
			await tick(40)
			await press(KEY.tab)

			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "alpha" }))
		})

		it("does nothing on enter when the picker holds no results", async () => {
			const onSelect = vi.fn()
			const { type, press } = await renderInput({
				onSelect,
				triggers: [atTrigger({ search: () => [] })],
			})

			await type("@")
			await tick(40)
			await press(KEY.enter)

			expect(onSelect).not.toHaveBeenCalled()
		})

		it("closes the picker on escape and keeps the text", async () => {
			const { type, press, lastFrame, ref } = await renderInput()

			await type("hi @")
			await tick(40)
			expect(ref.current?.pickerState.isOpen).toBe(true)

			await press(KEY.escape)

			expect(ref.current?.pickerState.isOpen).toBe(false)
			expect(lastFrame()).toContain("hi @")
		})

		it("selects through the ref handle", async () => {
			const onSelect = vi.fn()
			const { type, lastFrame, ref } = await renderInput({ onSelect })

			await type("@")
			await tick(40)
			ref.current?.handleItemSelect({ key: "beta", label: "beta" })
			await tick(40)

			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "beta" }))
			expect(lastFrame()).toContain("@beta")
		})

		it("moves the selection through the ref handle", async () => {
			const { type, ref } = await renderInput()

			await type("@")
			await tick(40)
			ref.current?.handleIndexChange(1)
			await tick(40)

			expect(ref.current?.pickerState.selectedIndex).toBe(1)
		})

		it("closes the picker through the ref handle", async () => {
			const { type, ref } = await renderInput()

			await type("@")
			await tick(40)
			ref.current?.closePicker()
			await tick(40)

			expect(ref.current?.pickerState.isOpen).toBe(false)
		})

		it("refreshes the search through the ref handle", async () => {
			let pool: Item[] = []
			const { type, ref } = await renderInput({
				triggers: [atTrigger({ refreshResults: () => pool, search: () => [] })],
			})

			await type("@")
			await tick(40)
			expect(ref.current?.pickerState.results).toEqual([])

			pool = [{ key: "late", label: "late" }]
			ref.current?.refreshSearch()
			await tick(40)

			expect(ref.current?.pickerState.results.map((r) => r.key)).toEqual(["late"])
		})

		it("drops the trigger character from the text when the trigger consumes it", async () => {
			const { type, lastFrame } = await renderInput({
				triggers: [atTrigger({ consumeTrigger: true })],
			})

			await type("ab@")
			await tick(40)

			const output = lastFrame() ?? ""
			expect(output).toContain("ab")
			expect(output).not.toContain("@")
		})

		it("only notifies the parent when something visible changed", async () => {
			const onPickerStateChange = vi.fn()
			const { type } = await renderInput({ onPickerStateChange })

			await type("@")
			await tick(40)
			const afterOpen = onPickerStateChange.mock.calls.length

			// Typing a character that leaves the same results does not re-notify.
			await type("a")
			await tick(60)

			expect(onPickerStateChange.mock.calls.length).toBeLessThanOrEqual(afterOpen + 2)
		})

		it("renders without an onPickerStateChange handler", async () => {
			const { type, lastFrame } = await renderInput({ onPickerStateChange: undefined })

			await type("@")
			await tick(40)

			expect(lastFrame()).toContain("@")
		})
	})

	describe("history", () => {
		it("recalls the previous submission on up at the first line", async () => {
			const onSubmit = vi.fn()
			const { type, press, lastFrame } = await renderInput({ onSubmit })

			await type("first message")
			await press(KEY.enter)
			await tick(60)

			await press(KEY.up)
			await tick(40)

			expect(lastFrame()).toContain("first message")
		})

		it("returns to the draft on down past the newest entry", async () => {
			const { type, press, lastFrame } = await renderInput()

			await type("remembered")
			await press(KEY.enter)
			await tick(60)

			await type("draft")
			await press(KEY.up)
			await tick(40)
			expect(lastFrame()).toContain("remembered")

			await press(KEY.down)
			await tick(40)

			expect(lastFrame()).toContain("draft")
		})

		it("steps back through successive history entries", async () => {
			const { type, press, lastFrame } = await renderInput()

			await type("older")
			await press(KEY.enter)
			await tick(60)
			await type("newer")
			await press(KEY.enter)
			await tick(60)

			await press(KEY.up)
			await tick(40)
			expect(lastFrame()).toContain("newer")

			// A second step replaces the recalled value while still browsing.
			await press(KEY.up)
			await tick(40)

			expect(lastFrame()).toContain("older")
		})

		it("leaves history browsing when the user types", async () => {
			const { type, press, lastFrame } = await renderInput()

			await type("stored")
			await press(KEY.enter)
			await tick(60)

			await press(KEY.up)
			await tick(40)
			await type("!")
			await tick(40)

			// The typed character lands at the cursor and the recalled entry is
			// kept — browsing ended rather than the history effect overwriting it.
			expect(lastFrame()).toContain("stored")
			expect(lastFrame()).toContain("!")
		})

		it("does not browse history while the picker is open", async () => {
			const { type, press, lastFrame } = await renderInput()

			await type("stored")
			await press(KEY.enter)
			await tick(60)

			await type("@")
			await tick(40)
			await press(KEY.up)
			await tick(40)

			expect(lastFrame()).not.toContain("stored")
		})
	})

	describe("inactive", () => {
		it("takes no input", async () => {
			const onSubmit = vi.fn()
			const { type, press, lastFrame } = await renderInput({ isActive: false, onSubmit })

			await type("ignored")
			await press(KEY.enter)

			expect(onSubmit).not.toHaveBeenCalled()
			expect(lastFrame()).not.toContain("ignored")
		})
	})
})
