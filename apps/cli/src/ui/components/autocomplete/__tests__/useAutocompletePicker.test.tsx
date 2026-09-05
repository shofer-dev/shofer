import { Text } from "ink"
import { render } from "ink-testing-library"

import type {
	AutocompleteItem,
	AutocompletePickerActions,
	AutocompletePickerState,
	AutocompleteTrigger,
} from "../types.js"
import { useAutocompletePicker } from "../useAutocompletePicker.js"

interface Item extends AutocompleteItem {
	key: string
	label: string
}

const item = (key: string): Item => ({ key, label: key })

const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A trigger fires on `@` anywhere in the line. `debounceMs: 0` keeps the tests
 * off the 150ms default; one test below covers that default explicitly.
 */
function makeTrigger(over: Partial<AutocompleteTrigger<Item>> = {}): AutocompleteTrigger<Item> {
	return {
		id: "at",
		triggerChar: "@",
		position: "anywhere",
		debounceMs: 0,
		detectTrigger: (lineText) => {
			const index = lineText.lastIndexOf("@")
			if (index === -1) return null
			return { query: lineText.slice(index + 1), triggerIndex: index }
		},
		search: () => [item("a"), item("b")],
		renderItem: (it) => <Text>{it.label}</Text>,
		getReplacementText: (it, lineText, triggerIndex) => `${lineText.slice(0, triggerIndex)}@${it.key} `,
		...over,
	}
}

type Api = [AutocompletePickerState<Item>, AutocompletePickerActions<Item>]

/**
 * `AutocompletePickerActions` declares `lineText` as required on
 * `handleInputChange`/`handleSelect`, but the hook implements both with the
 * argument optional and derives the last line itself. These aliases reach that
 * documented-but-untypeable path without loosening the assertions.
 */
type LooseActions = {
	handleInputChange: (value: string) => { consumedValue?: string }
	handleSelect: (item: Item, fullValue: string) => string
}

/**
 * Renders the hook inside a real Ink tree and hands the latest state/actions
 * back out. `latest()` is re-read after every flush because the hook returns a
 * fresh tuple on each render.
 */
function renderPicker(triggers: AutocompleteTrigger<Item>[]) {
	let api: Api | null = null

	function Probe({ triggers: current }: { triggers: AutocompleteTrigger<Item>[] }) {
		const hook = useAutocompletePicker(current)
		api = hook
		return <Text>{hook[0].isOpen ? "open" : "closed"}</Text>
	}

	const result = render(<Probe triggers={triggers} />)
	return {
		...result,
		latest: () => api as Api,
		state: () => (api as Api)[0],
		actions: () => (api as Api)[1],
		/** The same actions, typed for the optional-`lineText` overload. */
		looseActions: () => (api as Api)[1] as unknown as LooseActions,
		rerenderWith(next: AutocompleteTrigger<Item>[]) {
			result.rerender(<Probe triggers={next} />)
		},
	}
}

describe("useAutocompletePicker", () => {
	describe("initial state", () => {
		it("starts closed and empty", () => {
			const picker = renderPicker([makeTrigger()])
			const state = picker.state()

			expect(state).toEqual({
				activeTrigger: null,
				results: [],
				selectedIndex: 0,
				isOpen: false,
				isLoading: false,
				triggerInfo: null,
			})
		})
	})

	describe("handleInputChange", () => {
		it("opens the picker and reports the search results", async () => {
			const picker = renderPicker([makeTrigger()])

			picker.actions().handleInputChange("@fo", "@fo")
			await flush(30)

			const state = picker.state()
			expect(state.isOpen).toBe(true)
			expect(state.isLoading).toBe(false)
			expect(state.results.map((r) => r.key)).toEqual(["a", "b"])
			expect(state.triggerInfo).toEqual({ query: "fo", triggerIndex: 0 })
			expect(state.activeTrigger?.id).toBe("at")
		})

		it("derives the last line when none is supplied", async () => {
			const detectTrigger = vi.fn((lineText: string) =>
				lineText.startsWith("@") ? { query: lineText.slice(1), triggerIndex: 0 } : null,
			)
			const picker = renderPicker([makeTrigger({ detectTrigger })])

			picker.looseActions().handleInputChange("first line\n@second")
			await flush(30)

			expect(detectTrigger).toHaveBeenCalledWith("@second")
			expect(picker.state().isOpen).toBe(true)
		})

		it("treats a trailing newline as an empty last line", async () => {
			const detectTrigger = vi.fn(() => null)
			const picker = renderPicker([makeTrigger({ detectTrigger })])

			picker.looseActions().handleInputChange("text\n")
			await flush(30)

			expect(detectTrigger).toHaveBeenCalledWith("")
		})

		it("returns an empty result and stays closed when nothing triggers", async () => {
			const picker = renderPicker([makeTrigger()])

			const result = picker.actions().handleInputChange("plain", "plain")
			await flush(30)

			expect(result).toEqual({})
			expect(picker.state().isOpen).toBe(false)
		})

		it("closes an open picker when the trigger stops matching", async () => {
			const picker = renderPicker([makeTrigger()])

			picker.actions().handleInputChange("@x", "@x")
			await flush(30)
			expect(picker.state().isOpen).toBe(true)

			picker.actions().handleInputChange("plain", "plain")
			await flush(30)

			const state = picker.state()
			expect(state.isOpen).toBe(false)
			expect(state.results).toEqual([])
			expect(state.activeTrigger).toBeNull()
			expect(state.triggerInfo).toBeNull()
		})

		it("picks the first matching trigger and ignores later ones", async () => {
			const second = vi.fn(() => ({ query: "", triggerIndex: 0 }))
			const picker = renderPicker([
				makeTrigger({ id: "first" }),
				makeTrigger({ id: "second", detectTrigger: second }),
			])

			picker.actions().handleInputChange("@x", "@x")
			await flush(30)

			expect(picker.state().activeTrigger?.id).toBe("first")
			expect(second).not.toHaveBeenCalled()
		})

		it("strips the trigger character when the trigger consumes it", async () => {
			const picker = renderPicker([makeTrigger({ consumeTrigger: true })])

			const result = picker.actions().handleInputChange("ab@", "ab@")
			await flush(30)

			expect(result.consumedValue).toBe("ab")
		})

		it("strips the trigger character from the last line only", async () => {
			const picker = renderPicker([makeTrigger({ consumeTrigger: true })])

			const result = picker.actions().handleInputChange("keep@me\nab@", "ab@")

			expect(result.consumedValue).toBe("keep@me\nab")
		})

		it("skips the search when the query and trigger are unchanged", async () => {
			const search = vi.fn(() => [item("a")])
			const picker = renderPicker([makeTrigger({ search })])

			picker.actions().handleInputChange("@q", "@q")
			await flush(30)
			expect(search).toHaveBeenCalledTimes(1)

			picker.actions().handleInputChange("@q", "@q")
			await flush(30)

			expect(search).toHaveBeenCalledTimes(1)
		})

		it("still reports the consumed value on a repeated identical query", async () => {
			const picker = renderPicker([makeTrigger({ consumeTrigger: true })])

			picker.actions().handleInputChange("@", "@")
			await flush(30)

			const result = picker.actions().handleInputChange("@", "@")
			expect(result.consumedValue).toBe("")
		})

		it("debounces by the trigger's own delay", async () => {
			const search = vi.fn(() => [item("a")])
			const picker = renderPicker([makeTrigger({ debounceMs: 80, search })])

			picker.actions().handleInputChange("@q", "@q")
			await flush(20)
			expect(search).not.toHaveBeenCalled()

			await flush(100)
			expect(search).toHaveBeenCalledTimes(1)
		})

		it("uses the 150ms default when the trigger states no delay", async () => {
			const search = vi.fn(() => [item("a")])
			const trigger = makeTrigger({ search })
			delete (trigger as { debounceMs?: number }).debounceMs
			const picker = renderPicker([trigger])

			picker.actions().handleInputChange("@q", "@q")
			await flush(90)
			expect(search).not.toHaveBeenCalled()

			await flush(120)
			expect(search).toHaveBeenCalledTimes(1)
		})

		it("cancels a pending search when the query changes again", async () => {
			const search = vi.fn(() => [item("a")])
			const picker = renderPicker([makeTrigger({ debounceMs: 60, search })])

			picker.actions().handleInputChange("@a", "@a")
			await flush(10)
			picker.actions().handleInputChange("@ab", "@ab")
			await flush(120)

			expect(search).toHaveBeenCalledTimes(1)
			expect(search).toHaveBeenCalledWith("ab")
		})

		it("awaits a promise-returning search", async () => {
			const search = vi.fn(async () => [item("z")])
			const picker = renderPicker([makeTrigger({ search })])

			picker.actions().handleInputChange("@q", "@q")
			await flush(40)

			expect(picker.state().results.map((r) => r.key)).toEqual(["z"])
		})

		it("closes the picker when the search rejects", async () => {
			const search = vi.fn(async () => {
				throw new Error("boom")
			})
			const picker = renderPicker([makeTrigger({ search })])

			picker.actions().handleInputChange("@q", "@q")
			await flush(40)

			const state = picker.state()
			expect(state.isOpen).toBe(false)
			expect(state.isLoading).toBe(false)
			expect(state.results).toEqual([])
		})
	})

	describe("async triggers", () => {
		it("seeds the picker from cached refreshResults without a loading flash", async () => {
			const picker = renderPicker([
				makeTrigger({
					refreshResults: () => [item("cached")],
					search: () => [],
				}),
			])

			picker.actions().handleInputChange("@q", "@q")
			await flush(5)

			const state = picker.state()
			expect(state.isLoading).toBe(false)
			expect(state.results.map((r) => r.key)).toEqual(["cached"])
			expect(state.selectedIndex).toBe(0)
		})

		it("shows the loading state when refreshResults is asynchronous", async () => {
			// A promise carries no results to seed with, so the picker opens
			// empty and loading. The debounce is long enough that the search has
			// not yet cleared the flag when it is read.
			const picker = renderPicker([
				makeTrigger({
					debounceMs: 200,
					refreshResults: async () => [item("later")],
					search: () => [],
				}),
			])

			picker.actions().handleInputChange("@q", "@q")
			await flush(20)

			const state = picker.state()
			expect(state.isOpen).toBe(true)
			expect(state.isLoading).toBe(true)
			expect(state.results).toEqual([])
		})

		it("tolerates refreshResults throwing while seeding", async () => {
			const picker = renderPicker([
				makeTrigger({
					refreshResults: () => {
						throw new Error("cache miss")
					},
					search: () => [item("from-search")],
				}),
			])

			picker.actions().handleInputChange("@q", "@q")
			await flush(30)

			expect(picker.state().results.map((r) => r.key)).toEqual(["from-search"])
		})

		it("keeps the previous results when an async search returns nothing", async () => {
			const picker = renderPicker([
				makeTrigger({
					refreshResults: (query) => (query === "a" ? [item("cached")] : []),
					search: () => [],
				}),
			])

			picker.actions().handleInputChange("@a", "@a")
			await flush(30)
			expect(picker.state().results.map((r) => r.key)).toEqual(["cached"])

			picker.actions().handleInputChange("@ab", "@ab")
			await flush(30)

			// search() returned [] for an async trigger, so the earlier results stand.
			expect(picker.state().results.map((r) => r.key)).toEqual(["cached"])
		})

		it("does not apply a search that resolved after the trigger changed", async () => {
			let release: (value: Item[]) => void = () => {}
			const slow = makeTrigger({
				id: "slow",
				detectTrigger: (line) => (line.startsWith("@") ? { query: line.slice(1), triggerIndex: 0 } : null),
				search: () => new Promise<Item[]>((resolve) => (release = resolve)),
			})
			const fast = makeTrigger({
				id: "fast",
				detectTrigger: (line) => (line.startsWith("/") ? { query: line.slice(1), triggerIndex: 0 } : null),
				search: () => [item("fast-result")],
			})

			const picker = renderPicker([slow, fast])

			picker.actions().handleInputChange("@q", "@q")
			await flush(20)

			picker.actions().handleInputChange("/q", "/q")
			await flush(20)
			expect(picker.state().activeTrigger?.id).toBe("fast")

			release([item("stale")])
			await flush(30)

			expect(picker.state().results.map((r) => r.key)).toEqual(["fast-result"])
		})
	})

	describe("handleSelect", () => {
		it("returns the value untouched when no trigger is active", () => {
			const picker = renderPicker([makeTrigger()])

			expect(picker.actions().handleSelect(item("a"), "untouched", "untouched")).toBe("untouched")
		})

		it("substitutes the selection into the last line and closes the picker", async () => {
			const picker = renderPicker([makeTrigger()])

			picker.actions().handleInputChange("hi @a", "hi @a")
			await flush(30)

			const next = picker.actions().handleSelect(item("alpha"), "hi @a", "hi @a")
			await flush(20)

			expect(next).toBe("hi @alpha ")
			expect(picker.state().isOpen).toBe(false)
			expect(picker.state().activeTrigger).toBeNull()
		})

		it("substitutes only the last line of a multi-line value", async () => {
			const picker = renderPicker([makeTrigger()])

			picker.actions().handleInputChange("keep\n@a", "@a")
			await flush(30)

			expect(picker.looseActions().handleSelect(item("alpha"), "keep\n@a")).toBe("keep\n@alpha ")
		})

		it("lets the same query search again after a selection", async () => {
			const search = vi.fn(() => [item("a")])
			const picker = renderPicker([makeTrigger({ search })])

			picker.actions().handleInputChange("@q", "@q")
			await flush(30)
			picker.actions().handleSelect(item("a"), "@q", "@q")
			await flush(20)

			picker.actions().handleInputChange("@q", "@q")
			await flush(30)

			expect(search).toHaveBeenCalledTimes(2)
		})
	})

	describe("handleClose", () => {
		it("resets the picker", async () => {
			const picker = renderPicker([makeTrigger()])

			picker.actions().handleInputChange("@a", "@a")
			await flush(30)
			expect(picker.state().isOpen).toBe(true)

			picker.actions().handleClose()
			await flush(20)

			expect(picker.state()).toEqual({
				activeTrigger: null,
				results: [],
				selectedIndex: 0,
				isOpen: false,
				isLoading: false,
				triggerInfo: null,
			})
		})

		it("cancels a search that had not fired yet", async () => {
			const search = vi.fn(() => [item("a")])
			const picker = renderPicker([makeTrigger({ debounceMs: 60, search })])

			picker.actions().handleInputChange("@a", "@a")
			await flush(10)
			picker.actions().handleClose()
			await flush(120)

			expect(search).not.toHaveBeenCalled()
		})
	})

	describe("selection navigation", () => {
		it("sets the index directly", async () => {
			const picker = renderPicker([makeTrigger()])

			picker.actions().handleIndexChange(1)
			await flush(20)

			expect(picker.state().selectedIndex).toBe(1)
		})

		it("does nothing on navigate with no results", async () => {
			const picker = renderPicker([makeTrigger()])

			picker.actions().navigateDown()
			await flush(20)
			expect(picker.state().selectedIndex).toBe(0)

			picker.actions().navigateUp()
			await flush(20)
			expect(picker.state().selectedIndex).toBe(0)
		})

		it("moves down and wraps to the top", async () => {
			const picker = renderPicker([makeTrigger()])
			picker.actions().handleInputChange("@a", "@a")
			await flush(30)

			picker.actions().navigateDown()
			await flush(20)
			expect(picker.state().selectedIndex).toBe(1)

			picker.actions().navigateDown()
			await flush(20)
			expect(picker.state().selectedIndex).toBe(0)
		})

		it("moves up and wraps to the bottom", async () => {
			const picker = renderPicker([makeTrigger()])
			picker.actions().handleInputChange("@a", "@a")
			await flush(30)

			picker.actions().navigateUp()
			await flush(20)
			expect(picker.state().selectedIndex).toBe(1)

			picker.actions().navigateUp()
			await flush(20)
			expect(picker.state().selectedIndex).toBe(0)
		})
	})

	describe("forceRefresh", () => {
		it("does nothing when the picker is closed", async () => {
			const refreshResults = vi.fn(() => [item("x")])
			const picker = renderPicker([makeTrigger({ refreshResults })])

			picker.actions().forceRefresh()
			await flush(20)

			expect(refreshResults).not.toHaveBeenCalled()
		})

		it("does nothing when the active trigger is no longer in the array", async () => {
			const picker = renderPicker([makeTrigger()])
			picker.actions().handleInputChange("@a", "@a")
			await flush(30)

			picker.rerenderWith([makeTrigger({ id: "different" })])
			await flush(20)

			picker.actions().forceRefresh()
			await flush(20)

			expect(picker.state().results.map((r) => r.key)).toEqual(["a", "b"])
		})

		it("applies fresh synchronous results", async () => {
			let pool: Item[] = []
			const trigger = makeTrigger({ refreshResults: () => pool, search: () => [] })
			const picker = renderPicker([trigger])

			picker.actions().handleInputChange("@a", "@a")
			await flush(30)
			expect(picker.state().results).toEqual([])

			pool = [item("late-1"), item("late-2")]
			picker.actions().forceRefresh()
			await flush(20)

			expect(picker.state().results.map((r) => r.key)).toEqual(["late-1", "late-2"])
			expect(picker.state().isLoading).toBe(false)
		})

		it("only clears the loading flag when the results are unchanged", async () => {
			const picker = renderPicker([makeTrigger({ refreshResults: () => [item("same")], search: () => [] })])

			picker.actions().handleInputChange("@a", "@a")
			await flush(30)
			picker.actions().handleIndexChange(0)
			await flush(20)

			picker.actions().forceRefresh()
			await flush(20)

			expect(picker.state().results.map((r) => r.key)).toEqual(["same"])
			expect(picker.state().isLoading).toBe(false)
		})

		it("resets an out-of-bounds selection when the results shrink", async () => {
			let pool = [item("a"), item("b"), item("c")]
			const picker = renderPicker([makeTrigger({ refreshResults: () => pool, search: () => [] })])

			picker.actions().handleInputChange("@a", "@a")
			await flush(30)
			picker.actions().handleIndexChange(2)
			await flush(20)
			expect(picker.state().selectedIndex).toBe(2)

			pool = [item("a")]
			picker.actions().forceRefresh()
			await flush(20)

			expect(picker.state().selectedIndex).toBe(0)
		})

		it("keeps an in-bounds selection when the results change", async () => {
			let pool = [item("a"), item("b"), item("c")]
			const picker = renderPicker([makeTrigger({ refreshResults: () => pool, search: () => [] })])

			picker.actions().handleInputChange("@a", "@a")
			await flush(30)
			picker.actions().handleIndexChange(1)
			await flush(20)

			pool = [item("x"), item("y"), item("z")]
			picker.actions().forceRefresh()
			await flush(20)

			expect(picker.state().selectedIndex).toBe(1)
		})

		it("applies results that arrive as a promise", async () => {
			let pool: Item[] = []
			const picker = renderPicker([makeTrigger({ refreshResults: async () => pool, search: () => [] })])

			picker.actions().handleInputChange("@a", "@a")
			await flush(30)

			pool = [item("async-late")]
			picker.actions().forceRefresh()
			await flush(30)

			expect(picker.state().results.map((r) => r.key)).toEqual(["async-late"])
		})

		it("only clears the loading flag when promised results are unchanged", async () => {
			const picker = renderPicker([makeTrigger({ refreshResults: async () => [item("same")], search: () => [] })])

			picker.actions().handleInputChange("@a", "@a")
			await flush(40)

			// The first refresh installs the results; the second resolves to the
			// same keys, which is the no-op branch.
			picker.actions().forceRefresh()
			await flush(40)
			expect(picker.state().results.map((r) => r.key)).toEqual(["same"])

			picker.actions().forceRefresh()
			await flush(40)

			expect(picker.state().results.map((r) => r.key)).toEqual(["same"])
			expect(picker.state().isLoading).toBe(false)
		})

		it("falls back to search when the trigger has no refreshResults", async () => {
			const search = vi.fn(() => [item("from-search")])
			const picker = renderPicker([makeTrigger({ search })])

			picker.actions().handleInputChange("@a", "@a")
			await flush(30)
			search.mockClear()

			picker.actions().forceRefresh()
			await flush(20)

			expect(search).toHaveBeenCalledTimes(1)
		})

		it("swallows a refresh that throws", async () => {
			const picker = renderPicker([
				makeTrigger({
					refreshResults: (query) => {
						if (query === "throw") throw new Error("nope")
						return [item("ok")]
					},
					search: () => [],
				}),
			])

			picker.actions().handleInputChange("@throw", "@throw")
			await flush(30)

			expect(() => picker.actions().forceRefresh()).not.toThrow()
		})

		it("drops a promised refresh once the trigger has changed", async () => {
			let release: (value: Item[]) => void = () => {}
			const slow = makeTrigger({
				id: "slow",
				detectTrigger: (line) => (line.startsWith("@") ? { query: line.slice(1), triggerIndex: 0 } : null),
				refreshResults: () => new Promise<Item[]>((resolve) => (release = resolve)),
				search: () => [],
			})
			const fast = makeTrigger({
				id: "fast",
				detectTrigger: (line) => (line.startsWith("/") ? { query: line.slice(1), triggerIndex: 0 } : null),
				search: () => [item("fast-result")],
			})
			const picker = renderPicker([slow, fast])

			picker.actions().handleInputChange("@a", "@a")
			await flush(30)
			picker.actions().forceRefresh()

			picker.actions().handleInputChange("/a", "/a")
			await flush(30)

			release([item("stale")])
			await flush(30)

			expect(picker.state().results.map((r) => r.key)).toEqual(["fast-result"])
		})
	})

	describe("cleanup", () => {
		it("cancels pending debounce timers on unmount", async () => {
			const search = vi.fn(() => [item("a")])
			const picker = renderPicker([makeTrigger({ debounceMs: 60, search })])

			picker.actions().handleInputChange("@a", "@a")
			await flush(10)
			picker.unmount()
			await flush(120)

			expect(search).not.toHaveBeenCalled()
		})
	})
})
