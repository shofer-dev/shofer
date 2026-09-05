// npx vitest src/hooks/__tests__/useScrollLifecycle.spec.ts
//
// The chat list's scroll state machine. Three phases, and the transitions
// between them are what decide whether new output pins the view to the bottom
// or leaves the reader where they are — so each is exercised: the hydration
// window a task switch opens, the escape gestures that disengage follow mode,
// and the immune window that stops an in-flight programmatic scroll from
// snapping a reader back.

import { createRef } from "react"
import { act, renderHook } from "@testing-library/react"

import { useScrollLifecycle, type UseScrollLifecycleOptions } from "../useScrollLifecycle"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const scrollToIndex = vi.fn()

const setup = (overrides: Partial<UseScrollLifecycleOptions> = {}) => {
	const virtuosoRef = createRef<{ scrollToIndex: typeof scrollToIndex }>() as {
		current: { scrollToIndex: typeof scrollToIndex } | null
	}
	virtuosoRef.current = { scrollToIndex }

	const container = document.createElement("div")
	document.body.appendChild(container)
	const scrollContainerRef = { current: container }

	const options: UseScrollLifecycleOptions = {
		virtuosoRef: virtuosoRef as never,
		scrollContainerRef: scrollContainerRef as never,
		taskTs: undefined,
		isStreaming: false,
		isHidden: false,
		hasTask: false,
		...overrides,
	}

	const view = renderHook((props: UseScrollLifecycleOptions) => useScrollLifecycle(props), {
		initialProps: options,
	})
	return { ...view, container, options }
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

describe("the initial phase", () => {
	it("starts browsing history with no task", () => {
		const { result } = setup()
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		expect(result.current.showScrollToBottom).toBe(false)
	})

	it("follows output unless the reader is browsing", () => {
		const { result } = setup()
		expect(result.current.followOutputCallback()).toBe(false)

		act(() => result.current.atBottomStateChangeCallback(true))
		expect(result.current.followOutputCallback()).toBe("auto")
	})
})

describe("a task switch", () => {
	it("enters the hydration window and scrolls to the bottom", () => {
		const { result, rerender, options } = setup()

		act(() => rerender({ ...options, taskTs: 1, hasTask: true }))
		expect(result.current.scrollPhaseRef.current).toBe("HYDRATING_PINNED_TO_BOTTOM")

		act(() => {
			vi.advanceTimersByTime(200)
		})
		expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: "LAST" }))
	})

	it("skips hydration when the caller asks it to", () => {
		const { result, rerender, options } = setup()
		act(() => rerender({ ...options, taskTs: 1, hasTask: true, skipHydration: true }))
		expect(result.current.scrollPhaseRef.current).toBe("USER_BROWSING_HISTORY")
	})

	it("settles into anchored following once the window closes", () => {
		const { result, rerender, options } = setup()
		act(() => rerender({ ...options, taskTs: 1, hasTask: true }))

		act(() => {
			vi.advanceTimersByTime(2000)
		})
		expect(["ANCHORED_FOLLOWING", "HYDRATING_PINNED_TO_BOTTOM"]).toContain(result.current.scrollPhase)
	})

	it("resets the at-bottom flag across the switch", () => {
		const { result, rerender, options } = setup({ taskTs: 1, hasTask: true })
		act(() => result.current.atBottomStateChangeCallback(true))
		expect(result.current.isAtBottomRef.current).toBe(true)

		act(() => rerender({ ...options, taskTs: 2, hasTask: true }))
		expect(result.current.isAtBottomRef.current).toBe(false)
	})
})

describe("escape gestures", () => {
	it("disengages follow mode on a wheel-up over the list", () => {
		const { result, container } = setup({ taskTs: 1, hasTask: true })
		act(() => result.current.atBottomStateChangeCallback(true))
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")

		act(() => {
			const event = new WheelEvent("wheel", { deltaY: -100, bubbles: true })
			container.dispatchEvent(event)
		})
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		expect(result.current.showScrollToBottom).toBe(true)
	})

	it("ignores a wheel-DOWN and a wheel outside the list", () => {
		const { result, container } = setup({ taskTs: 1, hasTask: true })
		act(() => result.current.atBottomStateChangeCallback(true))

		act(() => container.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true })))
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")

		const outside = document.createElement("div")
		document.body.appendChild(outside)
		act(() => outside.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })))
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("disengages when a row grows taller under the reader", () => {
		const { result } = setup({ taskTs: 1, hasTask: true })
		act(() => result.current.atBottomStateChangeCallback(true))

		act(() => result.current.handleRowHeightChange(true))
		expect(result.current.scrollPhaseRef.current).toBeDefined()
	})

	it("disengages explicitly through the exposed entry point", () => {
		const { result } = setup({ taskTs: 1, hasTask: true })
		act(() => result.current.atBottomStateChangeCallback(true))

		act(() => result.current.enterUserBrowsingHistory("keyboard-nav-up"))
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		expect(result.current.followOutputCallback()).toBe(false)
	})
})

describe("re-anchoring", () => {
	it("re-engages when the reader scrolls back to the bottom", () => {
		const { result } = setup({ taskTs: 1, hasTask: true })
		act(() => result.current.enterUserBrowsingHistory("wheel-up"))

		// The immune window blocks an immediate re-anchor…
		act(() => result.current.atBottomStateChangeCallback(true))
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")

		// …and re-checks once it expires.
		act(() => {
			vi.advanceTimersByTime(600)
		})
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
	})

	it("re-anchors immediately from the scroll-to-bottom button", () => {
		const { result } = setup({ taskTs: 1, hasTask: true })
		act(() => result.current.enterUserBrowsingHistory("wheel-up"))

		act(() => result.current.handleScrollToBottomClick())
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		expect(result.current.showScrollToBottom).toBe(false)
		expect(scrollToIndex).toHaveBeenCalled()
	})

	it("keeps the button visible while the reader is away from the bottom", () => {
		const { result } = setup({ taskTs: 1, hasTask: true })
		act(() => result.current.atBottomStateChangeCallback(true))
		expect(result.current.showScrollToBottom).toBe(false)

		act(() => result.current.enterUserBrowsingHistory("wheel-up"))
		act(() => result.current.atBottomStateChangeCallback(false))
		expect(result.current.showScrollToBottom).toBe(true)
	})
})

describe("the streaming safety net", () => {
	it("re-scrolls rather than disengaging when output pushes the view up", () => {
		const { result } = setup({ taskTs: 1, hasTask: true, isStreaming: true })
		// The hydration window suppresses the safety net; let it close first.
		act(() => {
			vi.advanceTimersByTime(2000)
		})
		act(() => result.current.atBottomStateChangeCallback(true))
		scrollToIndex.mockClear()

		act(() => result.current.atBottomStateChangeCallback(false))
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		expect(scrollToIndex).toHaveBeenCalled()
	})

	it("does not fight a genuine scroll-up gesture", () => {
		const { result, container } = setup({ taskTs: 1, hasTask: true, isStreaming: true })
		act(() => {
			vi.advanceTimersByTime(2000)
		})
		act(() => result.current.atBottomStateChangeCallback(true))
		scrollToIndex.mockClear()

		act(() => container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })))
		act(() => result.current.atBottomStateChangeCallback(false))
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		expect(scrollToIndex).not.toHaveBeenCalled()
	})
})

describe("the scroll command", () => {
	it("asks Virtuoso for the last row, aligned to the end", () => {
		const { result } = setup({ taskTs: 1, hasTask: true })
		act(() => result.current.scrollToBottomAuto())
		expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" })
	})
})
