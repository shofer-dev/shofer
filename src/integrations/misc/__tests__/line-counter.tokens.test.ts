// npx vitest src/integrations/misc/__tests__/line-counter.tokens.test.ts

/**
 * `countFileLinesAndTokens` is the read-file budget gate: it streams a file,
 * tokenizes it in chunks, and STOPS as soon as the budget is exceeded so a
 * multi-megabyte file never has to be fully tokenized just to refuse it. The
 * `complete` flag is what tells the caller which of those two things happened —
 * conflating "scanned it all" with "gave up early" is what turns a truncated
 * read into a silently wrong answer.
 *
 * The tokenizer is stubbed with a deterministic length function so the early-exit
 * arithmetic is testable; the real one is `tiktoken`.
 */

const hoisted = vi.hoisted(() => ({
	countTokens: vi.fn(async (blocks: Array<{ text: string }>) => blocks[0].text.length),
}))

vi.mock("../../../utils/countTokens", () => ({ countTokens: hoisted.countTokens }))

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { countFileLines, countFileLinesAndTokens } from "../line-counter"

const made: string[] = []

function tempFile(contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shofer-line-counter-"))
	made.push(dir)
	const file = path.join(dir, "file.txt")
	fs.writeFileSync(file, contents)
	return file
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.countTokens.mockImplementation(async (blocks: Array<{ text: string }>) => blocks[0].text.length)
})

afterEach(() => {
	while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true })
})

describe("countFileLines", () => {
	it("counts the lines of a file", async () => {
		await expect(countFileLines(tempFile("a\nb\nc\n"))).resolves.toBe(3)
	})

	it("counts a file with no trailing newline", async () => {
		await expect(countFileLines(tempFile("a\nb"))).resolves.toBe(2)
	})

	it("counts an empty file as zero", async () => {
		await expect(countFileLines(tempFile(""))).resolves.toBe(0)
	})

	it("REFUSES a path that does not exist, naming it", async () => {
		await expect(countFileLines("/definitely/not/here.txt")).rejects.toThrow(/File not found/)
	})
})

describe("countFileLinesAndTokens", () => {
	it("scans the whole file when no budget is given, and reports it COMPLETE", async () => {
		const file = tempFile("aaa\nbbb\n")

		const result = await countFileLinesAndTokens(file)

		expect(result).toEqual({ lineCount: 2, tokenEstimate: "aaa\nbbb".length, complete: true })
	})

	it("REFUSES a path that does not exist", async () => {
		await expect(countFileLinesAndTokens("/definitely/not/here.txt")).rejects.toThrow(/File not found/)
	})

	it("reports a file within budget as complete", async () => {
		const file = tempFile("short\n")

		await expect(countFileLinesAndTokens(file, { budgetTokens: 1000 })).resolves.toMatchObject({ complete: true })
	})

	it("STOPS EARLY once the budget is exceeded, and says the scan was incomplete", async () => {
		const file = tempFile(Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join("\n"))

		const result = await countFileLinesAndTokens(file, { budgetTokens: 10, chunkLines: 8 })

		expect(result.complete).toBe(false)
		expect(result.lineCount).toBeLessThan(2_000)
	})

	it("honours a custom chunk size", async () => {
		const file = tempFile(Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"))

		await countFileLinesAndTokens(file, { chunkLines: 5 })

		// The buffer is drained on a paused stream, so the exact chunk count depends
		// on how much readline had already queued — what matters is that a smaller
		// chunk size produces MORE tokenizer calls than one flush at the end.
		expect(hoisted.countTokens.mock.calls.length).toBeGreaterThan(1)
	})

	it("falls back to a CONSERVATIVE char/2 estimate when the tokenizer fails", async () => {
		hoisted.countTokens.mockRejectedValue(new Error("wasm missing"))
		const file = tempFile("abcd\n")

		const result = await countFileLinesAndTokens(file)

		expect(result.tokenEstimate).toBe(Math.ceil("abcd".length / 2))
		expect(result.complete).toBe(true)
	})

	it("reports an empty file as zero lines and zero tokens", async () => {
		await expect(countFileLinesAndTokens(tempFile(""))).resolves.toEqual({
			lineCount: 0,
			tokenEstimate: 0,
			complete: true,
		})
	})
})
