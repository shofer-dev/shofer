import { describe, it, expect, vi } from "vitest"

import { QuestionQueue } from "../question-queue"
import type { QuestionResult } from "@shofer/types"

const fakeResult = (answer: string): QuestionResult => ({
	answer,
	tokensUsed: { prompt: 1, completion: 1, total: 2 },
	contextUsage: { currentTokens: 0, maxTokens: 1, fillFraction: 0, isNearlyFull: false },
	costSnapshot: { sessionInputTokens: 1, sessionOutputTokens: 1, sessionEstimatedCostUSD: 0 },
	contextFiles: [],
	durationMs: 1,
})

describe("QuestionQueue", () => {
	it("holds entries until a processor is set", async () => {
		const q = new QuestionQueue(2)
		const p1 = q.enqueue("hi")
		expect(q.pendingCount).toBe(1)
		q.cancelAll()
		await expect(p1).rejects.toThrow(/cancelled/)
	})

	it("rejects when queue is full", async () => {
		// maxSize counts only PENDING entries; the active one doesn't count.
		const q = new QuestionQueue(1)
		q.setProcessor(
			(_q, _f, signal) =>
				new Promise<QuestionResult>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")))
				}),
		)
		void q.enqueue("active").catch(() => {}) // becomes the active entry
		void q.enqueue("pending").catch(() => {}) // fills the 1 pending slot
		await expect(q.enqueue("overflow")).rejects.toThrow(/queue is full/)
		q.cancelAll()
	})

	it("processes entries serially in FIFO order", async () => {
		const order: string[] = []
		const q = new QuestionQueue()
		q.setProcessor(async (question) => {
			order.push(question)
			return fakeResult(question)
		})
		const r1 = q.enqueue("a")
		const r2 = q.enqueue("b")
		const r3 = q.enqueue("c")
		const results = await Promise.all([r1, r2, r3])
		expect(order).toEqual(["a", "b", "c"])
		expect(results.map((r) => r.answer)).toEqual(["a", "b", "c"])
	})

	it("propagates processor errors to the matching enqueue() promise", async () => {
		const q = new QuestionQueue()
		q.setProcessor(async () => {
			throw new Error("boom")
		})
		await expect(q.enqueue("x")).rejects.toThrow("boom")
	})

	it("cancels all pending entries via cancelAll()", async () => {
		const q = new QuestionQueue()
		// The active entry is cancelled via AbortSignal; pending entries are
		// rejected synchronously by cancelAll().
		q.setProcessor(
			(_q, _f, signal) =>
				new Promise<QuestionResult>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted by signal")))
				}),
		)
		const p1 = q.enqueue("a")
		const p2 = q.enqueue("b")
		// Yield once so the active entry actually starts.
		await Promise.resolve()
		q.cancelAll()
		await expect(p1).rejects.toThrow(/aborted by signal/)
		await expect(p2).rejects.toThrow(/cancelled/)
	})

	it("aborts the active LLM call via the AbortSignal on per-entry timeout", async () => {
		vi.useFakeTimers()
		const q = new QuestionQueue()
		const aborted = vi.fn()
		q.setProcessor(
			(_q, _f, signal) =>
				new Promise<QuestionResult>((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						aborted()
						const err = new Error("aborted")
						err.name = "AbortError"
						reject(err)
					})
				}),
		)
		const p = q.enqueue("slow", undefined, 50)
		await vi.advanceTimersByTimeAsync(0) // allow microtasks → processor starts
		vi.advanceTimersByTime(60)
		await expect(p).rejects.toThrow(/aborted/)
		expect(aborted).toHaveBeenCalled()
		vi.useRealTimers()
	})

	it("times out entries waiting in the queue (head-of-line blocked)", async () => {
		vi.useFakeTimers()
		const q = new QuestionQueue()
		// Block the queue with a never-resolving first entry.
		q.setProcessor(() => new Promise(() => {}))
		void q.enqueue("blocker", undefined, 10_000)
		const p = q.enqueue("waiter", undefined, 50)
		vi.advanceTimersByTime(60)
		await expect(p).rejects.toThrow(/queue/)
		vi.useRealTimers()
		q.cancelAll()
	})
})
