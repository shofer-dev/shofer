import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest"
import { retryWithBackoff } from "../retry"

describe("retryWithBackoff", () => {
	let unhandledRejectionListener: ((reason: unknown) => void) | undefined

	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// Suppress unhandled-rejection noise caused by mockRejectedValue
	// returning Promise.reject synchronously under fake timers.
	beforeAll(() => {
		unhandledRejectionListener = () => {}
		process.on("unhandledRejection", unhandledRejectionListener)
	})

	afterAll(() => {
		if (unhandledRejectionListener) {
			process.off("unhandledRejection", unhandledRejectionListener)
		}
	})

	it("should return the result on first success", async () => {
		const fn = vi.fn().mockResolvedValue(42)

		const result = await retryWithBackoff(fn, {
			maxAttempts: 3,
			initialDelayMs: 100,
			maxBackoffMs: 1000,
		})

		expect(result).toBe(42)
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("should retry on failure and succeed on subsequent attempt", async () => {
		const fn = vi.fn().mockRejectedValueOnce(new Error("fail 1")).mockResolvedValueOnce("success")

		const promise = retryWithBackoff(fn, {
			maxAttempts: 3,
			initialDelayMs: 100,
			maxBackoffMs: 1000,
		})

		// Advance past the first backoff delay
		await vi.advanceTimersByTimeAsync(100)
		const result = await promise

		expect(result).toBe("success")
		expect(fn).toHaveBeenCalledTimes(2)
	})

	it("should exhaust retries and throw the last error", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("persistent failure"))

		const promise = retryWithBackoff(fn, {
			maxAttempts: 3,
			initialDelayMs: 100,
			maxBackoffMs: 1000,
		})

		// Advance through all three backoff delays: 100 + 200 + 400
		await vi.advanceTimersByTimeAsync(100)
		await vi.advanceTimersByTimeAsync(200)
		await vi.advanceTimersByTimeAsync(400)

		await expect(promise).rejects.toThrow("persistent failure")
		expect(fn).toHaveBeenCalledTimes(3)
	})

	it("should cap delay at maxBackoffMs", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("fail 1"))
			.mockRejectedValueOnce(new Error("fail 2"))
			.mockResolvedValueOnce("success")

		const promise = retryWithBackoff(fn, {
			maxAttempts: 5,
			initialDelayMs: 100,
			maxBackoffMs: 150, // cap at 150 ms even though 2nd attempt would be 200 ms
		})

		// First retry: 100 ms (exact)
		await vi.advanceTimersByTimeAsync(100)
		// Second retry: 150 ms (capped from 200 to 150)
		await vi.advanceTimersByTimeAsync(150)
		const result = await promise

		expect(result).toBe("success")
		expect(fn).toHaveBeenCalledTimes(3)
	})

	it("should call onRetry callback before each retry", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("boom"))
		const onRetry = vi.fn()

		const promise = retryWithBackoff(fn, {
			maxAttempts: 2,
			initialDelayMs: 100,
			maxBackoffMs: 1000,
			onRetry,
		})

		await vi.advanceTimersByTimeAsync(100)
		await expect(promise).rejects.toThrow()
		await vi.advanceTimersByTimeAsync(200)

		// onRetry called for attempt 1 (after first failure)
		expect(onRetry).toHaveBeenCalledTimes(1)
		expect(onRetry).toHaveBeenCalledWith(1, expect.objectContaining({ message: "boom" }), 100)
	})

	it("should abort immediately when signal fires", async () => {
		const controller = new AbortController()
		const fn = vi.fn().mockRejectedValue(new Error("will not recover"))

		const promise = retryWithBackoff(fn, {
			maxAttempts: 3,
			initialDelayMs: 100,
			maxBackoffMs: 1000,
			signal: controller.signal,
		})

		// Abort in the middle of first backoff
		await vi.advanceTimersByTimeAsync(50)
		controller.abort()

		await expect(promise).rejects.toThrow()
		// Only one attempt made before abort
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("should propagate AbortError from signal", async () => {
		const controller = new AbortController()
		const fn = vi.fn().mockImplementation(() => {
			controller.abort()
			return Promise.reject(new DOMException("aborted", "AbortError"))
		})

		const promise = retryWithBackoff(fn, {
			maxAttempts: 3,
			initialDelayMs: 100,
			maxBackoffMs: 1000,
			signal: controller.signal,
		})

		await expect(promise).rejects.toThrow("aborted")
	})
})
