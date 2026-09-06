import { setTimeout as sleep } from "node:timers/promises"

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

/**
 * Yield real event-loop turns. `node:timers/promises` keeps working under a fake
 * clock, so a suite that installs one elsewhere cannot freeze these waits.
 */
const tick = (ms = 30) => sleep(ms)

/**
 * Poll until `done()` holds, bounded by wall-clock rather than by a fixed sleep.
 *
 * A keystroke reaches this component through Ink's stdin subscription and comes
 * back out through a `useEffect`, so every assertion below is about an effect
 * that lands on a LATER turn. Under the gate — six suites at once, all
 * coverage-instrumented — a fixed `tick(40)` is a bet on scheduler latency, and
 * losing it reads as "the picker never opened".
 */
async function waitFor(done: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!done()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
		}
		await tick(10)
	}
}

/**
 * Every tree this file mounts, so `afterEach` can tear them down. A component
 * left mounted keeps Ink's stdin subscription and any debounce it armed, which
 * costs the rest of the file scheduler time it is measured against.
 */
const mountedInputs: Array<() => void> = []

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
	mountedInputs.push(result.unmount)
	await waitFor(() => (result.lastFrame() ?? "").length > 0, "the first frame to render")
	// Ink subscribes to stdin from an EFFECT, and the testing library's stdin is
	// a bare EventEmitter whose `write` just emits — so a write that lands before
	// that subscription is DROPPED, and no wait afterwards can recover it. The
	// listener count is the observable happens-before; a sleep here was a bet.
	// Ink listens on "readable" (verified against the version we run), not "data",
	// even though the stub emits both. An INACTIVE input registers no `useInput`
	// at all, so there is nothing to wait for there.
	if (options.isActive !== false) {
		await waitFor(() => result.stdin.listenerCount("readable") > 0, "Ink to subscribe to stdin")
	}
	return {
		...result,
		ref,
		async type(text: string) {
			for (const char of text) {
				result.stdin.write(char)
				await tick(15)
			}
			// Give the keystrokes a chance to cross the stdin stub and be
			// rendered before the caller reasons about them. BEST EFFORT on
			// purpose: an inactive input echoes nothing, a consuming trigger
			// swallows its character, and a completion rewrites the line — so
			// this is a fast path out of the common case, never the guarantee.
			// The guarantee is the caller's own `pickerOpened()` / `waitFor`.
			const typed = text.trim()
			if (typed) {
				await waitFor(() => (result.lastFrame() ?? "").includes(typed), "the typed text", 300).catch(() => {})
			}
		},
		async press(sequence: string) {
			result.stdin.write(sequence)
			await tick()
		},
		/** Wait until the picker this input owns is open. */
		pickerOpened: () => waitFor(() => ref.current?.pickerState.isOpen === true, "the picker to open"),
		/** Wait until a trigger has matched, whether or not it produced results. */
		triggerMatched: () => waitFor(() => ref.current?.pickerState.activeTrigger != null, "a trigger to match"),
		/**
		 * Types `text` and waits for `done`, RETYPING from a cleared line if the
		 * keystrokes did not take.
		 *
		 * Belt and braces over the subscription wait above: a dropped keystroke
		 * is unrecoverable by waiting, so the only honest remedy is to send it
		 * again. Clearing between attempts is what keeps it deterministic — a
		 * retry that appended would search a different query ("@@").
		 */
		async typeUntil(text: string, done: () => boolean, what = `typing ${JSON.stringify(text)}`) {
			for (let attempt = 0; attempt < 10; attempt++) {
				if (done()) return
				for (const char of text) {
					result.stdin.write(char)
					await tick(15)
				}
				await waitFor(done, what, 500).catch(() => {})
				if (done()) return
				for (let i = 0; i < text.length; i++) {
					result.stdin.write(KEY.backspace)
					await tick(10)
				}
				await tick(20)
			}
			await waitFor(done, what)
		},
	}
}

describe("AutocompleteInput", () => {
	beforeEach(() => {
		historyEntries.length = 0
	})

	afterEach(() => {
		while (mountedInputs.length > 0) {
			mountedInputs.pop()?.()
		}
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
			const { typeUntil } = await renderInput({ onPickerStateChange })

			// Wait for the RESULTS, not just for `isOpen`: the hook publishes an
			// open-but-empty state first (the seed) and fills it in when the
			// search resolves, so `isOpen` alone lets the assertion read the
			// intermediate publication.
			await typeUntil(
				"@",
				() =>
					((onPickerStateChange.mock.lastCall?.[0] as AutocompletePickerState<Item>)?.results.length ?? 0) >
					0,
				"the picker results to be published",
			)

			const last = onPickerStateChange.mock.lastCall?.[0] as AutocompletePickerState<Item>
			expect(last.isOpen).toBe(true)
			expect(last.results.map((r) => r.key)).toEqual(["alpha", "beta"])
		})

		it("exposes the picker state on the ref", async () => {
			const { typeUntil, ref } = await renderInput()

			await typeUntil("@", () => ref.current?.pickerState.isOpen === true, "the picker to open")

			expect(ref.current?.pickerState.isOpen).toBe(true)
		})

		it("inserts the highlighted item on enter instead of submitting", async () => {
			const onSubmit = vi.fn()
			const onSelect = vi.fn()
			const { typeUntil, press, lastFrame, ref } = await renderInput({ onSubmit, onSelect })

			await typeUntil("@", () => ref.current?.pickerState.isOpen === true, "the picker to open")
			await press(KEY.enter)
			await waitFor(() => onSelect.mock.calls.length > 0, "the completion to be selected")

			expect(onSubmit).not.toHaveBeenCalled()
			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "alpha" }))
			await waitFor(() => (lastFrame() ?? "").includes("@alpha"), "the completion to be inserted")
		})

		it("inserts the highlighted item on tab", async () => {
			const onSelect = vi.fn()
			const { typeUntil, press, ref } = await renderInput({ onSelect })

			await typeUntil("@", () => ref.current?.pickerState.isOpen === true, "the picker to open")
			await press(KEY.tab)
			await waitFor(() => onSelect.mock.calls.length > 0, "the completion to be selected")

			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "alpha" }))
		})

		it("does nothing on enter when the picker holds no results", async () => {
			const onSelect = vi.fn()
			const { typeUntil, press, ref } = await renderInput({
				onSelect,
				triggers: [atTrigger({ search: () => [] })],
			})

			await typeUntil("@", () => ref.current?.pickerState.activeTrigger != null, "a trigger to match")
			await press(KEY.enter)

			expect(onSelect).not.toHaveBeenCalled()
		})

		it("closes the picker on escape and keeps the text", async () => {
			const { typeUntil, press, lastFrame, ref } = await renderInput()

			await typeUntil("hi @", () => ref.current?.pickerState.isOpen === true, "the picker to open")
			expect(ref.current?.pickerState.isOpen).toBe(true)

			await press(KEY.escape)
			await waitFor(() => ref.current?.pickerState.isOpen === false, "the picker to close")

			expect(ref.current?.pickerState.isOpen).toBe(false)
			expect(lastFrame()).toContain("hi @")
		})

		it("selects through the ref handle", async () => {
			const onSelect = vi.fn()
			const { typeUntil, lastFrame, ref } = await renderInput({ onSelect })

			await typeUntil("@", () => ref.current?.pickerState.isOpen === true, "the picker to open")
			ref.current?.handleItemSelect({ key: "beta", label: "beta" })
			// The replacement text lands in a LATER commit than the `onSelect`
			// callback, so wait on the frame — the later of the two effects.
			await waitFor(() => (lastFrame() ?? "").includes("@beta"), "the completion to be inserted")

			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "beta" }))
			expect(lastFrame()).toContain("@beta")
		})

		it("moves the selection through the ref handle", async () => {
			const { typeUntil, ref } = await renderInput()

			await typeUntil("@", () => ref.current?.pickerState.isOpen === true, "the picker to open")
			ref.current?.handleIndexChange(1)
			await waitFor(() => ref.current?.pickerState.selectedIndex === 1, "the highlight to move")

			expect(ref.current?.pickerState.selectedIndex).toBe(1)
		})

		it("closes the picker through the ref handle", async () => {
			const { typeUntil, ref } = await renderInput()

			await typeUntil("@", () => ref.current?.pickerState.isOpen === true, "the picker to open")
			ref.current?.closePicker()
			await waitFor(() => ref.current?.pickerState.isOpen === false, "the picker to close")

			expect(ref.current?.pickerState.isOpen).toBe(false)
		})

		it("refreshes the search through the ref handle", async () => {
			let pool: Item[] = []
			const { typeUntil, ref } = await renderInput({
				triggers: [atTrigger({ refreshResults: () => pool, search: () => [] })],
			})

			await typeUntil("@", () => ref.current?.pickerState.activeTrigger != null, "a trigger to match")
			expect(ref.current?.pickerState.results).toEqual([])

			pool = [{ key: "late", label: "late" }]
			ref.current?.refreshSearch()
			await waitFor(() => (ref.current?.pickerState.results.length ?? 0) > 0, "the refreshed results to arrive")

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
			const { type, typeUntil, ref } = await renderInput({ onPickerStateChange })

			await typeUntil("@", () => ref.current?.pickerState.isOpen === true, "the picker to open")

			// Typing a character that leaves the same results must not re-notify.
			await type("a")
			await tick(60)

			// Asserted as the INVARIANT rather than as a call-count ceiling: no
			// two consecutive publications may be equal. A ceiling ("at most two
			// more") is a claim about how many times React happened to commit
			// inside a 60ms window, which load changes and the component does
			// not promise.
			const published = onPickerStateChange.mock.calls.map(([state]) => JSON.stringify(state))
			const consecutiveDuplicates = published.filter((state, i) => i > 0 && state === published[i - 1])
			expect(consecutiveDuplicates).toEqual([])
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
			await waitFor(() => onSubmit.mock.calls.length > 0, "the submission to be reported")

			await press(KEY.up)
			await waitFor(() => (lastFrame() ?? "").includes("first message"), "the entry to be recalled")

			expect(lastFrame()).toContain("first message")
		})

		it("returns to the draft on down past the newest entry", async () => {
			const { type, press, lastFrame } = await renderInput()

			await type("remembered")
			await press(KEY.enter)
			await tick(60)

			await type("draft")
			await press(KEY.up)
			await waitFor(() => (lastFrame() ?? "").includes("remembered"), "the entry to be recalled")

			await press(KEY.down)
			await waitFor(() => (lastFrame() ?? "").includes("draft"), "the draft to come back")

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
			await waitFor(() => (lastFrame() ?? "").includes("newer"), "the newest entry to be recalled")

			// A second step replaces the recalled value while still browsing.
			await press(KEY.up)
			await waitFor(() => (lastFrame() ?? "").includes("older"), "the older entry to be recalled")

			expect(lastFrame()).toContain("older")
		})

		it("leaves history browsing when the user types", async () => {
			const { type, press, lastFrame } = await renderInput()

			await type("stored")
			await press(KEY.enter)
			await tick(60)

			await press(KEY.up)
			await waitFor(() => (lastFrame() ?? "").includes("stored"), "the entry to be recalled")
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
