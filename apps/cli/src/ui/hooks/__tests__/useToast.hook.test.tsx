// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/useToast.hook.test.tsx

import { useToast, useToastStore } from "../useToast.js"
import { renderHook } from "./helpers/render-hook.js"

/**
 * The `useToast` HOOK (its store is covered by `useToast.test.ts`). What the hook
 * adds on top of the store is auto-expiry: exactly one timer per toast id, armed
 * for the toast's REMAINING duration rather than its full one — so a toast that
 * was queued while another was showing does not get a fresh three seconds — and
 * cleared on unmount so a dismissed CLI leaves no pending timer.
 */
describe("useToast", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		useToastStore.setState({ toasts: [] })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("exposes the queue and no current toast while it is empty", () => {
		const hook = renderHook(() => useToast())

		expect(hook.current.currentToast).toBeNull()
		expect(hook.current.toasts).toEqual([])

		hook.unmount()
	})

	it("shows the head of the queue and auto-dismisses it after its duration", () => {
		const hook = renderHook(() => useToast())

		hook.act(() => {
			hook.current.showInfo("hello")
		})
		expect(hook.current.currentToast?.message).toBe("hello")
		expect(hook.current.currentToast?.type).toBe("info")

		hook.act(() => {
			vi.advanceTimersByTime(2999)
		})
		expect(hook.current.currentToast).not.toBeNull()

		hook.act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(hook.current.currentToast).toBeNull()

		hook.unmount()
	})

	it("arms the timer for the REMAINING duration of a toast that was created earlier", () => {
		// A toast created 2.5s ago with a 3s duration has 500ms left, not 3000.
		useToastStore.setState({
			toasts: [
				{
					id: "t1",
					message: "stale",
					type: "info",
					duration: 3000,
					createdAt: Date.now() - 2500,
				},
			],
		})

		const hook = renderHook(() => useToast())
		expect(hook.current.currentToast?.id).toBe("t1")

		hook.act(() => {
			vi.advanceTimersByTime(500)
		})
		expect(hook.current.currentToast).toBeNull()

		hook.unmount()
	})

	it("dismisses immediately when the toast is already past its duration", () => {
		useToastStore.setState({
			toasts: [{ id: "t1", message: "old", type: "info", duration: 100, createdAt: Date.now() - 10_000 }],
		})

		const hook = renderHook(() => useToast())
		hook.act(() => {
			vi.advanceTimersByTime(0)
		})

		expect(hook.current.currentToast).toBeNull()
		hook.unmount()
	})

	it("each convenience method stamps its own type", () => {
		const hook = renderHook(() => useToast())

		for (const [show, type] of [
			[() => hook.current.showSuccess("s"), "success"],
			[() => hook.current.showWarning("w"), "warning"],
			[() => hook.current.showError("e"), "error"],
			[() => hook.current.showToast("t", "info"), "info"],
		] as const) {
			hook.act(show)
			expect(hook.current.currentToast?.type).toBe(type)
		}

		hook.unmount()
	})

	it("honours a custom duration passed to a convenience method", () => {
		const hook = renderHook(() => useToast())

		hook.act(() => {
			hook.current.showError("boom", 10_000)
		})

		hook.act(() => {
			vi.advanceTimersByTime(5000)
		})
		expect(hook.current.currentToast?.message).toBe("boom")

		hook.act(() => {
			vi.advanceTimersByTime(5000)
		})
		expect(hook.current.currentToast).toBeNull()

		hook.unmount()
	})

	it("removeToast and clearToasts are re-exported and work through the hook", () => {
		const hook = renderHook(() => useToast())

		let id = ""
		hook.act(() => {
			id = hook.current.showInfo("one")
		})
		hook.act(() => {
			hook.current.removeToast(id)
		})
		expect(hook.current.currentToast).toBeNull()

		hook.act(() => {
			hook.current.showInfo("two")
		})
		hook.act(() => {
			hook.current.clearToasts()
		})
		expect(hook.current.toasts).toEqual([])

		hook.unmount()
	})

	it("clears its pending timer on unmount, so nothing fires afterwards", () => {
		const hook = renderHook(() => useToast())
		hook.act(() => {
			hook.current.showInfo("hello")
		})

		hook.unmount()

		// The store still holds the toast: the timer that would have removed it was
		// cleared with the component, rather than firing against a dead tree.
		vi.advanceTimersByTime(10_000)
		expect(useToastStore.getState().toasts).toHaveLength(1)
	})
})
