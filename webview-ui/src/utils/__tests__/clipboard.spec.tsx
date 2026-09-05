// npx vitest src/utils/__tests__/clipboard.spec.tsx
//
// The copy helper and the feedback hook around it. The feedback flag is a timed
// state, so the timer is faked; the cleanup path matters because the hook is
// used inside rows that unmount while the flag is still up.

import { act, renderHook, waitFor } from "@testing-library/react"

import { copyToClipboard, useCopyToClipboard } from "../clipboard"

const writeText = vi.fn()

beforeEach(() => {
	vi.clearAllMocks()
	writeText.mockResolvedValue(undefined)
	Object.assign(navigator, { clipboard: { writeText } })
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe("copyToClipboard", () => {
	it("writes the text and reports success", async () => {
		const onSuccess = vi.fn()
		await expect(copyToClipboard("hello", { onSuccess })).resolves.toBe(true)

		expect(writeText).toHaveBeenCalledWith("hello")
		expect(onSuccess).toHaveBeenCalled()
	})

	it("reports failure with a real Error, never the raw rejection", async () => {
		writeText.mockRejectedValue("denied")
		const onError = vi.fn()

		await expect(copyToClipboard("hello", { onError })).resolves.toBe(false)
		expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
	})

	it("passes a thrown Error through unchanged", async () => {
		const boom = new Error("no permission")
		writeText.mockRejectedValue(boom)
		const onError = vi.fn()

		await copyToClipboard("hello", { onError })
		expect(onError).toHaveBeenCalledWith(boom)
	})

	it("needs no callbacks at all", async () => {
		await expect(copyToClipboard("hello")).resolves.toBe(true)
		writeText.mockRejectedValue(new Error("x"))
		await expect(copyToClipboard("hello")).resolves.toBe(false)
	})
})

describe("useCopyToClipboard", () => {
	it("raises the feedback flag and drops it after the window", async () => {
		vi.useFakeTimers()
		const { result } = renderHook(() => useCopyToClipboard(1000))

		await act(async () => {
			await result.current.copyWithFeedback("hi")
		})
		expect(result.current.showCopyFeedback).toBe(true)

		act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(result.current.showCopyFeedback).toBe(false)
		vi.useRealTimers()
	})

	it("stops the click from reaching the row underneath", async () => {
		const { result } = renderHook(() => useCopyToClipboard())
		const stopPropagation = vi.fn()

		await act(async () => {
			await result.current.copyWithFeedback("hi", { stopPropagation } as never)
		})
		expect(stopPropagation).toHaveBeenCalled()
	})

	it("restarts the window on a second copy rather than stacking timers", async () => {
		vi.useFakeTimers()
		const { result } = renderHook(() => useCopyToClipboard(1000))

		await act(async () => {
			await result.current.copyWithFeedback("one")
		})
		act(() => {
			vi.advanceTimersByTime(600)
		})
		await act(async () => {
			await result.current.copyWithFeedback("two")
		})
		act(() => {
			vi.advanceTimersByTime(600)
		})
		// The first window would have expired by now; the second one has not.
		expect(result.current.showCopyFeedback).toBe(true)
		vi.useRealTimers()
	})

	it("leaves the flag down when the copy fails", async () => {
		writeText.mockRejectedValue(new Error("x"))
		const { result } = renderHook(() => useCopyToClipboard())

		await act(async () => {
			await expect(result.current.copyWithFeedback("hi")).resolves.toBe(false)
		})
		await waitFor(() => expect(result.current.showCopyFeedback).toBe(false))
	})

	it("clears its pending timer on unmount", async () => {
		vi.useFakeTimers()
		const clearTimeout = vi.spyOn(globalThis, "clearTimeout")
		const { result, unmount } = renderHook(() => useCopyToClipboard())

		await act(async () => {
			await result.current.copyWithFeedback("hi")
		})
		unmount()
		expect(clearTimeout).toHaveBeenCalled()
		vi.useRealTimers()
	})
})
