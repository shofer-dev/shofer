// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/useFollowupCountdown.test.tsx

import { FOLLOWUP_TIMEOUT_SECONDS } from "../../../types/constants.js"
import type { PendingAsk } from "../../types.js"
import { useUIStateStore } from "../../stores/uiStateStore.js"
import { useFollowupCountdown } from "../useFollowupCountdown.js"
import { renderHook } from "./helpers/render-hook.js"

/**
 * The auto-accept countdown on a followup question that came with suggestions.
 *
 * Note what it is NOT: it never answers an APPROVAL. It fires only for
 * `type === "followup"` WITH suggestions and only while the user has not opened
 * the custom-input box — a timer that could decide an approval would be the
 * platform granting authority on the human's behalf.
 */
describe("useFollowupCountdown", () => {
	const followupWithSuggestions: PendingAsk = {
		id: "ask-1",
		type: "followup",
		content: "Which one?",
		suggestions: [{ answer: "first" }, { answer: "second" }],
	}

	beforeEach(() => {
		vi.useFakeTimers()
		useUIStateStore.getState().resetUIState()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("counts down from the configured timeout and auto-submits the FIRST suggestion", () => {
		const onAutoSubmit = vi.fn()
		const hook = renderHook(() => useFollowupCountdown({ pendingAsk: followupWithSuggestions, onAutoSubmit }))

		expect(hook.current.countdownSeconds).toBe(FOLLOWUP_TIMEOUT_SECONDS)

		hook.act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(hook.current.countdownSeconds).toBe(FOLLOWUP_TIMEOUT_SECONDS - 1)

		hook.act(() => {
			vi.advanceTimersByTime(1000 * FOLLOWUP_TIMEOUT_SECONDS)
		})

		expect(onAutoSubmit).toHaveBeenCalledTimes(1)
		expect(onAutoSubmit).toHaveBeenCalledWith("first")
		expect(hook.current.countdownSeconds).toBeNull()

		hook.unmount()
	})

	it("does not start for an approval ask, or for a followup with no suggestions", () => {
		const onAutoSubmit = vi.fn()

		const approval = renderHook(() =>
			useFollowupCountdown({ pendingAsk: { id: "a", type: "tool", content: "run?" }, onAutoSubmit }),
		)
		expect(approval.current.countdownSeconds).toBeNull()
		approval.unmount()

		const bare = renderHook(() =>
			useFollowupCountdown({
				pendingAsk: { id: "b", type: "followup", content: "?", suggestions: [] },
				onAutoSubmit,
			}),
		)
		expect(bare.current.countdownSeconds).toBeNull()
		bare.unmount()

		const none = renderHook(() => useFollowupCountdown({ pendingAsk: null, onAutoSubmit }))
		expect(none.current.countdownSeconds).toBeNull()
		none.unmount()

		vi.advanceTimersByTime(60_000)
		expect(onAutoSubmit).not.toHaveBeenCalled()
	})

	it("does not start while the user is typing a custom answer", () => {
		const onAutoSubmit = vi.fn()
		useUIStateStore.getState().setShowCustomInput(true)

		const hook = renderHook(() => useFollowupCountdown({ pendingAsk: followupWithSuggestions, onAutoSubmit }))
		expect(hook.current.countdownSeconds).toBeNull()

		hook.act(() => {
			vi.advanceTimersByTime(60_000)
		})
		expect(onAutoSubmit).not.toHaveBeenCalled()

		hook.unmount()
	})

	it("clears a stale countdown left in the store when no ask is outstanding", () => {
		useUIStateStore.getState().setCountdownSeconds(7)

		const hook = renderHook(() => useFollowupCountdown({ pendingAsk: null, onAutoSubmit: vi.fn() }))
		expect(hook.current.countdownSeconds).toBeNull()

		hook.unmount()
	})

	it("cancelCountdown stops the timer so nothing is auto-submitted", () => {
		const onAutoSubmit = vi.fn()
		const hook = renderHook(() => useFollowupCountdown({ pendingAsk: followupWithSuggestions, onAutoSubmit }))

		hook.act(() => {
			hook.current.cancelCountdown()
		})
		expect(hook.current.countdownSeconds).toBeNull()

		hook.act(() => {
			vi.advanceTimersByTime(60_000)
		})
		expect(onAutoSubmit).not.toHaveBeenCalled()

		// Cancelling again with no timer armed is harmless.
		hook.act(() => {
			hook.current.cancelCountdown()
		})

		hook.unmount()
	})

	it("auto-submits nothing when the countdown was cleared out from under it", () => {
		const onAutoSubmit = vi.fn()
		const hook = renderHook(() => useFollowupCountdown({ pendingAsk: followupWithSuggestions, onAutoSubmit }))

		// A null countdown is the terminal condition too: the tick fires the
		// auto-submit and disarms, rather than counting down from null.
		hook.act(() => {
			useUIStateStore.setState({ countdownSeconds: null })
			vi.advanceTimersByTime(1000)
		})

		expect(onAutoSubmit).toHaveBeenCalledWith("first")
		hook.unmount()
	})

	it("restarts for a NEW ask and follows the latest onAutoSubmit", () => {
		const first = vi.fn()
		const second = vi.fn()

		const hook = renderHook(
			({ ask, cb }: { ask: PendingAsk; cb: (t: string) => void }) =>
				useFollowupCountdown({ pendingAsk: ask, onAutoSubmit: cb }),
			{ ask: followupWithSuggestions, cb: first },
		)

		hook.rerender({
			ask: { ...followupWithSuggestions, id: "ask-2", suggestions: [{ answer: "other" }] },
			cb: second,
		})
		expect(hook.current.countdownSeconds).toBe(FOLLOWUP_TIMEOUT_SECONDS)

		hook.act(() => {
			vi.advanceTimersByTime(1000 * (FOLLOWUP_TIMEOUT_SECONDS + 1))
		})

		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledWith("other")

		hook.unmount()
	})

	it("stops the interval on unmount", () => {
		const onAutoSubmit = vi.fn()
		const hook = renderHook(() => useFollowupCountdown({ pendingAsk: followupWithSuggestions, onAutoSubmit }))

		hook.unmount()
		vi.advanceTimersByTime(60_000)

		expect(onAutoSubmit).not.toHaveBeenCalled()
	})
})
