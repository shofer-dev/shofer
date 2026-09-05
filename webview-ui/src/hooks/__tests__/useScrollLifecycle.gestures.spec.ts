// npx vitest src/hooks/__tests__/useScrollLifecycle.gestures.spec.ts
//
// The escape gestures the sibling spec does not reach — a pointer drag on a
// scrollbar, the keyboard navigation keys, and the hydration RETRY budget. Each
// is a place where "did the reader mean to leave the bottom" is answered from
// DOM state rather than from a phase, so the near-misses (a drag downward, a
// key typed into the composer, a modified key) are what the tests pin.

import { createRef } from "react"
import { act, renderHook } from "@testing-library/react"

import { useScrollLifecycle, type UseScrollLifecycleOptions } from "../useScrollLifecycle"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const scrollToIndex = vi.fn()

const setup = (overrides: Partial<UseScrollLifecycleOptions> = {}) => {
	const virtuosoRef = createRef() as { current: { scrollToIndex: typeof scrollToIndex } | null }
	virtuosoRef.current = { scrollToIndex }

	const container = document.createElement("div")
	container.className = "chat-container"
	document.body.appendChild(container)

	const scroller = document.createElement("div")
	scroller.className = "scrollable"
	container.appendChild(scroller)

	const options: UseScrollLifecycleOptions = {
		virtuosoRef: virtuosoRef as never,
		scrollContainerRef: { current: container } as never,
		taskTs: 1,
		isStreaming: false,
		isHidden: false,
		hasTask: true,
		...overrides,
	}

	const view = renderHook((props: UseScrollLifecycleOptions) => useScrollLifecycle(props), {
		initialProps: options,
	})
	return { ...view, container, scroller, options }
}

/** Take the hook out of the hydration window and into anchored following. */
const anchor = (result: { current: { atBottomStateChangeCallback: (b: boolean) => void } }) => {
	act(() => {
		vi.advanceTimersByTime(2000)
	})
	act(() => result.current.atBottomStateChangeCallback(true))
}

const dragScroll = (scroller: HTMLElement, from: number, to: number) => {
	Object.defineProperty(scroller, "scrollTop", { value: from, writable: true, configurable: true })
	act(() => scroller.dispatchEvent(new Event("pointerdown", { bubbles: true })))
	scroller.scrollTop = to
	act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })))
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers()
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		cb(0)
		return 1
	})
	vi.stubGlobal("cancelAnimationFrame", vi.fn())
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	document.body.innerHTML = ""
})

describe("pointer drags", () => {
	it("disengages when a drag moves the scroller upward", () => {
		const { result, scroller } = setup()
		anchor(result)

		dragScroll(scroller, 500, 200)
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
	})

	it("ignores a drag that moves DOWNWARD", () => {
		const { result, scroller } = setup()
		anchor(result)

		dragScroll(scroller, 200, 500)
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("ignores a scroll with no drag in progress", () => {
		const { result, scroller } = setup()
		anchor(result)

		scroller.scrollTop = 0
		act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })))
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("forgets the drag once the pointer is released", () => {
		const { result, scroller } = setup()
		anchor(result)

		Object.defineProperty(scroller, "scrollTop", { value: 500, writable: true, configurable: true })
		act(() => scroller.dispatchEvent(new Event("pointerdown", { bubbles: true })))
		act(() => window.dispatchEvent(new Event("pointerup")))

		scroller.scrollTop = 100
		act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })))
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("forgets the drag when the pointer interaction is cancelled", () => {
		const { result, scroller } = setup()
		anchor(result)

		act(() => scroller.dispatchEvent(new Event("pointerdown", { bubbles: true })))
		act(() => window.dispatchEvent(new Event("pointercancel")))

		scroller.scrollTop = 0
		act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })))
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("ignores a pointer that went down outside the chat", () => {
		const { result, scroller } = setup()
		anchor(result)

		const outside = document.createElement("div")
		document.body.appendChild(outside)
		act(() => outside.dispatchEvent(new Event("pointerdown", { bubbles: true })))

		scroller.scrollTop = 0
		act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })))
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("ignores a scroll on a DIFFERENT element than the one being dragged", () => {
		const { result, container, scroller } = setup()
		anchor(result)

		Object.defineProperty(scroller, "scrollTop", { value: 500, writable: true, configurable: true })
		act(() => scroller.dispatchEvent(new Event("pointerdown", { bubbles: true })))

		const other = document.createElement("div")
		other.className = "scrollable"
		container.appendChild(other)
		Object.defineProperty(other, "scrollTop", { value: 0, writable: true, configurable: true })
		act(() => other.dispatchEvent(new Event("scroll", { bubbles: true })))

		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})
})

describe("keyboard navigation", () => {
	const press = (key: string, init: KeyboardEventInit = {}) =>
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }))
		})

	it.each(["PageUp", "Home", "ArrowUp"])("disengages on %s", (key) => {
		const { result } = setup()
		anchor(result)

		press(key)
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
	})

	it("ignores a key that is not a scroll-intent key", () => {
		const { result } = setup()
		anchor(result)

		press("PageDown")
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }])("ignores a modified ArrowUp (%o)", (mods) => {
		const { result } = setup()
		anchor(result)

		press("ArrowUp", mods)
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("ignores caret movement inside the composer", () => {
		const { result } = setup()
		anchor(result)

		const textarea = document.createElement("textarea")
		document.body.appendChild(textarea)
		act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })))

		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("does nothing without a task, or while the view is hidden", () => {
		const noTask = setup({ hasTask: false, taskTs: undefined })
		press("PageUp")
		expect(noTask.result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		noTask.unmount()

		const hidden = setup({ isHidden: true })
		anchor(hidden.result)
		press("PageUp")
		expect(hidden.result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})
})

describe("the hydration retry budget", () => {
	it("re-scrolls while the list has not reached the bottom, then settles anyway", () => {
		const { result } = setup()
		scrollToIndex.mockClear()

		// The list never reports at-bottom, so every retry fires and the budget
		// is spent — and the phase still ends anchored rather than browsing.
		act(() => {
			vi.advanceTimersByTime(600 + 160 * 4)
		})

		expect(scrollToIndex.mock.calls.length).toBeGreaterThan(1)
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("stops retrying as soon as the list reports the bottom", () => {
		const { result } = setup()
		act(() => result.current.atBottomStateChangeCallback(true))
		scrollToIndex.mockClear()

		act(() => {
			vi.advanceTimersByTime(600)
		})
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("abandons a pending window when the task changes underneath it", () => {
		const { result, rerender, options } = setup()
		act(() => rerender({ ...options, taskTs: 2 }))

		act(() => {
			vi.advanceTimersByTime(2000)
		})
		expect(result.current.scrollPhaseRef.current).toBeDefined()
	})

	it("cleans its timers up on unmount", () => {
		const clearTimeout = vi.spyOn(window, "clearTimeout")
		const { result, unmount } = setup()
		act(() => result.current.enterUserBrowsingHistory("wheel-up"))

		unmount()
		expect(clearTimeout).toHaveBeenCalled()
		clearTimeout.mockRestore()
	})
})
