// npx vitest src/workers/__tests__/worker-entrypoints.test.ts

/**
 * The two workerpool entry points. Both exist so a CPU-bound step (tokenizing a
 * conversation, serializing a whole task tree) never runs on the extension host
 * thread, and both share one contract that the in-process callers depend on:
 * a failure comes back as `{ success: false, error }` rather than as a thrown
 * exception, because a rejected `pool.exec` is indistinguishable from the worker
 * having died and makes the caller tear its pool down.
 */

type Registered = Record<string, (...args: never[]) => Promise<unknown>>

const hoisted = vi.hoisted(() => ({
	registered: {} as Registered,
	tiktoken: vi.fn(async () => 12),
	writeFile: vi.fn(async () => undefined),
}))

vi.mock("workerpool", () => {
	const worker = (fns: Registered) => Object.assign(hoisted.registered, fns)
	return { default: { worker }, worker }
})

vi.mock("fs/promises", () => ({ default: { writeFile: hoisted.writeFile }, writeFile: hoisted.writeFile }))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	tiktoken: hoisted.tiktoken,
}))

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.tiktoken.mockResolvedValue(12)
	hoisted.writeFile.mockResolvedValue(undefined)
})

describe("the countTokens worker", () => {
	async function load() {
		vi.resetModules()
		hoisted.registered = {}
		await import("../countTokens")
		return hoisted.registered.countTokens as (c: unknown[]) => Promise<Record<string, unknown>>
	}

	it("registers itself under the name the pool calls", async () => {
		await load()
		expect(hoisted.registered.countTokens).toBeTypeOf("function")
	})

	it("returns the count on success", async () => {
		const countTokens = await load()
		await expect(countTokens([{ type: "text", text: "hi" }])).resolves.toEqual({ success: true, count: 12 })
	})

	it("returns a FAILURE RESULT rather than throwing", async () => {
		hoisted.tiktoken.mockRejectedValueOnce(new Error("tokenizer wasm missing"))
		const countTokens = await load()

		await expect(countTokens([])).resolves.toEqual({ success: false, error: "tokenizer wasm missing" })
	})

	it("labels a non-Error rejection rather than stringifying an object", async () => {
		hoisted.tiktoken.mockRejectedValueOnce("boom")
		const countTokens = await load()

		await expect(countTokens([])).resolves.toEqual({ success: false, error: "Unknown error" })
	})
})

describe("the exportJson worker", () => {
	async function load() {
		vi.resetModules()
		hoisted.registered = {}
		await import("../exportJson")
		return hoisted.registered.stringifyAndWrite as (v: unknown, p: string) => Promise<Record<string, unknown>>
	}

	it("registers itself under the name the pool calls", async () => {
		await load()
		expect(hoisted.registered.stringifyAndWrite).toBeTypeOf("function")
	})

	it("pretty-prints, writes, and returns only a BYTE COUNT — never the string", async () => {
		const stringifyAndWrite = await load()

		const result = await stringifyAndWrite({ a: 1 }, "/tmp/out.json")

		const expected = JSON.stringify({ a: 1 }, null, 2)
		expect(hoisted.writeFile).toHaveBeenCalledWith("/tmp/out.json", expected, "utf8")
		expect(result).toEqual({ success: true, bytes: Buffer.byteLength(expected) })
	})

	it("returns a failure result when the write fails", async () => {
		hoisted.writeFile.mockRejectedValueOnce(new Error("ENOSPC"))
		const stringifyAndWrite = await load()

		await expect(stringifyAndWrite({ a: 1 }, "/tmp/out.json")).resolves.toEqual({
			success: false,
			error: "ENOSPC",
		})
	})

	it("returns a failure result for a value JSON cannot represent", async () => {
		const stringifyAndWrite = await load()
		const circular: Record<string, unknown> = {}
		circular.self = circular

		await expect(stringifyAndWrite(circular, "/tmp/out.json")).resolves.toMatchObject({ success: false })
		expect(hoisted.writeFile).not.toHaveBeenCalled()
	})

	it("labels a non-Error throw", async () => {
		hoisted.writeFile.mockImplementationOnce(() => {
			throw "boom"
		})
		const stringifyAndWrite = await load()

		await expect(stringifyAndWrite({ a: 1 }, "/tmp/out.json")).resolves.toEqual({
			success: false,
			error: "Unknown error",
		})
	})
})
