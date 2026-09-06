// npx vitest src/utils/__tests__/countTokens.test.ts

/**
 * `countTokens` and `stringifyJsonToFile` are the same shape twice: a lazily
 * created single-worker pool with an in-process fallback. The invariant both
 * exist to hold is that a worker failure must degrade rather than propagate —
 * the caller is a hot path (an env-details digest, a task export) that has no
 * useful way to handle "the worker pool died".
 */

import type { Anthropic } from "@anthropic-ai/sdk"

const hoisted = vi.hoisted(() => ({
	exec: vi.fn(),
	poolFactory: vi.fn(),
	tiktoken: vi.fn(async () => 42),
	writeFile: vi.fn(async () => undefined),
	errors: [] as string[],
}))

vi.mock("workerpool", () => {
	const pool = (...args: unknown[]) => {
		hoisted.poolFactory(...args)
		return { exec: hoisted.exec }
	}
	return { default: { pool }, pool }
})

vi.mock("fs/promises", () => ({
	default: { writeFile: hoisted.writeFile },
	writeFile: hoisted.writeFile,
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	tiktoken: hoisted.tiktoken,
	utilLog: { error: (m: string) => hoisted.errors.push(m), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const content = [{ type: "text", text: "hello" }] as Anthropic.Messages.ContentBlockParam[]

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.errors = []
	hoisted.tiktoken.mockResolvedValue(42)
})

describe("countTokens", () => {
	it("uses the in-process tokenizer when the caller opts out of the worker", async () => {
		const { countTokens } = await import("../countTokens")

		await expect(countTokens(content, { useWorker: false })).resolves.toBe(42)
		expect(hoisted.poolFactory).not.toHaveBeenCalled()
	})

	it("creates the pool ONCE and reuses it across calls", async () => {
		vi.resetModules()
		hoisted.exec.mockResolvedValue({ success: true, count: 7 })
		const { countTokens } = await import("../countTokens")

		await expect(countTokens(content)).resolves.toBe(7)
		await expect(countTokens(content)).resolves.toBe(7)

		expect(hoisted.poolFactory).toHaveBeenCalledTimes(1)
		expect(hoisted.poolFactory.mock.calls[0][1]).toMatchObject({ maxWorkers: 1, maxQueueSize: 10 })
	})

	it("falls back to the in-process tokenizer when the worker REPORTS failure", async () => {
		vi.resetModules()
		hoisted.exec.mockResolvedValue({ success: false, error: "tokenizer blew up" })
		const { countTokens } = await import("../countTokens")

		await expect(countTokens(content)).resolves.toBe(42)
		expect(hoisted.errors.join(" ")).toContain("tokenizer blew up")
	})

	it("a worker failure DISABLES the pool, so the next call goes straight in-process", async () => {
		vi.resetModules()
		hoisted.exec.mockRejectedValue(new Error("worker terminated"))
		const { countTokens } = await import("../countTokens")

		await expect(countTokens(content)).resolves.toBe(42)
		await expect(countTokens(content)).resolves.toBe(42)

		expect(hoisted.exec).toHaveBeenCalledTimes(1)
		expect(hoisted.poolFactory).toHaveBeenCalledTimes(1)
	})

	it("a reply that does not match the result schema is a failure, not a silent NaN", async () => {
		vi.resetModules()
		hoisted.exec.mockResolvedValue({ nonsense: true })
		const { countTokens } = await import("../countTokens")

		await expect(countTokens(content)).resolves.toBe(42)
		expect(hoisted.errors).not.toHaveLength(0)
	})
})

describe("stringifyJsonToFile", () => {
	it("writes in-process when the caller opts out, returning the byte count", async () => {
		vi.resetModules()
		const { stringifyJsonToFile } = await import("../exportJsonWorker")

		const bytes = await stringifyJsonToFile({ a: 1 }, "/tmp/out.json", { useWorker: false })

		expect(bytes).toBe(Buffer.byteLength(JSON.stringify({ a: 1 }, null, 2)))
		expect(hoisted.writeFile).toHaveBeenCalledWith("/tmp/out.json", JSON.stringify({ a: 1 }, null, 2), "utf8")
	})

	it("returns the worker's byte count without ever touching the main thread's fs", async () => {
		vi.resetModules()
		hoisted.exec.mockResolvedValue({ success: true, bytes: 512 })
		const { stringifyJsonToFile } = await import("../exportJsonWorker")

		await expect(stringifyJsonToFile({ a: 1 }, "/tmp/out.json")).resolves.toBe(512)
		expect(hoisted.writeFile).not.toHaveBeenCalled()
	})

	it("falls back to an in-process write when the worker reports failure", async () => {
		vi.resetModules()
		hoisted.exec.mockResolvedValue({ success: false, error: "ENOSPC" })
		const { stringifyJsonToFile } = await import("../exportJsonWorker")

		await expect(stringifyJsonToFile({ a: 1 }, "/tmp/out.json")).resolves.toBeGreaterThan(0)
		expect(hoisted.writeFile).toHaveBeenCalled()
		expect(hoisted.errors.join(" ")).toContain("ENOSPC")
	})

	it("a worker rejection disables the pool for subsequent calls", async () => {
		vi.resetModules()
		hoisted.exec.mockRejectedValue(new Error("worker gone"))
		const { stringifyJsonToFile } = await import("../exportJsonWorker")

		await stringifyJsonToFile({ a: 1 }, "/tmp/a.json")
		await stringifyJsonToFile({ a: 2 }, "/tmp/b.json")

		expect(hoisted.exec).toHaveBeenCalledTimes(1)
		expect(hoisted.writeFile).toHaveBeenCalledTimes(2)
	})
})
