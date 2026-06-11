/**
 * jsonlLog.tail.spec.ts — Unit tests for readJsonLinesTail (T1.B).
 */

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import { appendJsonLine, readJsonLinesTail, writeJsonLines, serializeJsonLines } from "../jsonlLog"

let tmpDir: string
let jsonlPath: string

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-jsonl-tail-"))
	jsonlPath = path.join(tmpDir, "test.jsonl")
})

afterEach(async () => {
	try {
		await fs.rm(tmpDir, { recursive: true, force: true })
	} catch {
		// cleanup is best-effort
	}
})

describe("readJsonLinesTail", () => {
	it("returns [records, false] for an empty file", async () => {
		await fs.writeFile(jsonlPath, "", "utf8")
		const result = await readJsonLinesTail<string>(jsonlPath, 10)
		expect(result).toEqual([[], false])
	})

	it("returns null for a missing file", async () => {
		const result = await readJsonLinesTail<string>(jsonlPath, 10)
		expect(result).toBeNull()
	})

	it("reads all records and sets hasMore=false when fewer than maxLines", async () => {
		const records = [{ a: 1 }, { a: 2 }, { a: 3 }]
		await writeJsonLines(jsonlPath, serializeJsonLines(records))
		const [result, hasMore] = (await readJsonLinesTail<{ a: number }>(jsonlPath, 10))!
		expect(result).toEqual(records)
		expect(hasMore).toBe(false)
	})

	it("reads only the last maxLines and sets hasMore=true when file exceeds maxLines", async () => {
		const records = Array.from({ length: 10 }, (_, i) => ({ idx: i }))
		await writeJsonLines(jsonlPath, serializeJsonLines(records))

		// Read last 3
		const [result, hasMore] = (await readJsonLinesTail<{ idx: number }>(jsonlPath, 3))!
		expect(result).toHaveLength(3)
		expect(result.map((r) => r.idx)).toEqual([7, 8, 9])
		expect(hasMore).toBe(true)
	})

	it("returns exact count when maxLines equals file size", async () => {
		const records = [{ x: 1 }, { x: 2 }, { x: 3 }]
		await writeJsonLines(jsonlPath, serializeJsonLines(records))
		const [result, hasMore] = (await readJsonLinesTail<{ x: number }>(jsonlPath, 3))!
		expect(result).toEqual(records)
		expect(hasMore).toBe(false)
	})

	it("falls back to full read when maxLines is 0", async () => {
		const records = [{ k: "a" }, { k: "b" }, { k: "c" }]
		await writeJsonLines(jsonlPath, serializeJsonLines(records))
		const [result, hasMore] = (await readJsonLinesTail<{ k: string }>(jsonlPath, 0))!
		expect(result).toEqual(records)
		expect(hasMore).toBe(false)
	})

	it("tolerates a truncated final line from crash mid-append", async () => {
		// Write 3 valid records, then a truncated line without a newline
		await writeJsonLines(
			jsonlPath,
			serializeJsonLines([{ v: 1 }, { v: 2 }, { v: 3 }]) + '{"v": 4', // truncated
		)
		const [result, hasMore] = (await readJsonLinesTail<{ v: number }>(jsonlPath, 10))!
		expect(result).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }])
		expect(hasMore).toBe(false)
	})

	it("empty lines are skipped", async () => {
		// Write records with blank lines interleaved
		const records = serializeJsonLines([{ n: 1 }, { n: 2 }, { n: 3 }])
		const withBlanks = records.replace(/\n/g, "\n\n").replace(/\n+$/, "\n")
		await fs.writeFile(jsonlPath, withBlanks, "utf8")
		const [result, hasMore] = (await readJsonLinesTail<{ n: number }>(jsonlPath, 10))!
		expect(result).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
		expect(hasMore).toBe(false)
	})

	it("tail works correctly with appends (dedupeByKey not applied at this layer)", async () => {
		// Append 10 records one at a time, verifying the tail read
		for (let i = 0; i < 10; i++) {
			await appendJsonLine(jsonlPath, { seq: i })
		}
		const [result, hasMore] = (await readJsonLinesTail<{ seq: number }>(jsonlPath, 4))!
		expect(result.map((r) => r.seq)).toEqual([6, 7, 8, 9])
		expect(hasMore).toBe(true)
	})
})
