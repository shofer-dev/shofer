import fsp from "fs/promises"
import os from "os"
import path from "path"

const pdfParse = vi.fn()
vi.mock("pdf-parse/lib/pdf-parse", () => ({ default: (...a: unknown[]) => pdfParse(...a) }))

const extractRawText = vi.fn()
vi.mock("mammoth", () => ({ default: { extractRawText: (...a: unknown[]) => extractRawText(...a) } }))

const extractTextFromXLSX = vi.fn()
vi.mock("../extract-text-from-xlsx.js", () => ({
	extractTextFromXLSX: (...a: unknown[]) => extractTextFromXLSX(...a),
}))

const isBinaryFile = vi.fn()
vi.mock("isbinaryfile", () => ({ isBinaryFile: (...a: unknown[]) => isBinaryFile(...a) }))

import { extractTextFromFile, extractTextFromFileWithMetadata, getSupportedBinaryFormats } from "../extract-text.js"

/**
 * Reading a file the agent asked for — the DOCUMENT formats, and the metadata
 * that tells the model what it did NOT get.
 *
 * The refusals matter more than the extraction here. A `read_file` on a format
 * with no extractor must FAIL rather than return the raw bytes: handing a model
 * a megabyte of binary noise wastes the context window and, worse, reads as
 * content — it will try to reason about it. So an unknown binary throws, naming
 * the extension, and only the four formats with a real extractor are decoded.
 *
 * Truncation is reported rather than hidden. `wasTruncated` and `linesShown`
 * are how the tool tells the model there is more file past what it can see; a
 * silent cut is the same failure as a silently truncated command output — the
 * model concludes from an incomplete file.
 */

let dir: string
const file = (name: string) => path.join(dir, name)

async function write(name: string, content = "x") {
	const p = file(name)
	await fsp.writeFile(p, content)
	return p
}

beforeEach(async () => {
	vi.clearAllMocks()
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), "extract-text-"))
	isBinaryFile.mockResolvedValue(false)
})

afterEach(async () => {
	await fsp.rm(dir, { recursive: true, force: true })
})

describe("the formats with an extractor", () => {
	it("advertises exactly the four it can decode", () => {
		expect(getSupportedBinaryFormats().sort()).toEqual([".docx", ".ipynb", ".pdf", ".xlsx"])
	})

	it("decodes a PDF and numbers its lines", async () => {
		pdfParse.mockResolvedValue({ text: "first\nsecond" })
		const p = await write("report.pdf")

		expect(await extractTextFromFile(p)).toBe("1 | first\n2 | second\n")
	})

	it("decodes a DOCX", async () => {
		extractRawText.mockResolvedValue({ value: "the memo" })
		const p = await write("memo.docx")

		expect(await extractTextFromFile(p)).toBe("1 | the memo\n")
	})

	it("delegates a XLSX to its own extractor", async () => {
		extractTextFromXLSX.mockResolvedValue("1 | cell\n")
		const p = await write("book.xlsx")

		expect(await extractTextFromFile(p)).toBe("1 | cell\n")
		expect(extractTextFromXLSX).toHaveBeenCalledWith(p)
	})

	it("flattens a notebook's markdown and code cells, and skips the rest", async () => {
		// Outputs are the bulk of a notebook and are usually noise; the SOURCE is
		// what the model was asked to read.
		const notebook = {
			cells: [
				{ cell_type: "markdown", source: ["# Title"] },
				{ cell_type: "code", source: ["import os", "print(1)"] },
				{ cell_type: "code" },
				{ cell_type: "raw", source: ["ignored"] },
			],
		}
		const p = await write("nb.ipynb", JSON.stringify(notebook))

		const content = await extractTextFromFile(p)

		expect(content).toContain("# Title")
		expect(content).toContain("import os")
		expect(content).not.toContain("ignored")
	})

	it("reports a decoded document as untruncated", async () => {
		// A decoded document is never sliced — the extractor already produced the
		// whole thing, so there is no window to report.
		pdfParse.mockResolvedValue({ text: "a\nb\nc" })
		const p = await write("report.pdf")

		const result = await extractTextFromFileWithMetadata(p)

		expect(result.wasTruncated).toBe(false)
		expect(result.returnedLines).toBe(result.totalLines)
		expect(result.linesShown).toBeUndefined()
	})

	it("matches the extension case-insensitively", async () => {
		pdfParse.mockResolvedValue({ text: "upper" })
		const p = await write("REPORT.PDF")

		expect(await extractTextFromFile(p)).toContain("upper")
	})
})

describe("plain text", () => {
	it("returns the whole file, numbered, when it fits", async () => {
		// The trailing newline is counted as a line of its own — the numbering
		// follows the file's bytes rather than its visible rows, so an editor
		// showing "2 lines" and this showing 3 are both right about the same file.
		const p = await write("a.ts", "one\ntwo\n")

		expect(await extractTextFromFileWithMetadata(p)).toMatchObject({
			content: "1 | one\n2 | two\n3 | ",
			totalLines: 3,
			returnedLines: 3,
			wasTruncated: false,
			linesShown: [1, 3],
		})
	})

	it("TELLS the model when it truncated, and how much it saw", async () => {
		// A silent cut makes the model conclude from an incomplete file.
		const p = await write("big.ts", Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"))

		const result = await extractTextFromFileWithMetadata(p, 10)

		expect(result.wasTruncated).toBe(true)
		expect(result.totalLines).toBe(50)
		expect(result.returnedLines).toBeLessThanOrEqual(10)
	})

	it("reports an empty file as one empty line rather than as nothing", async () => {
		// "" and "the file exists and is empty" are different answers, and the
		// numbered form is what tells the model which one it got.
		const p = await write("empty.ts", "")

		expect(await extractTextFromFileWithMetadata(p)).toMatchObject({
			content: "1 | ",
			totalLines: 1,
			wasTruncated: false,
		})
	})
})

describe("what it refuses", () => {
	it("names a file that is not there", async () => {
		await expect(extractTextFromFile(file("nope.ts"))).rejects.toThrow(/File not found/)
	})

	it("refuses a binary format it cannot decode, naming the extension", async () => {
		// Returning the bytes would fill the context with noise the model then
		// tries to reason about.
		isBinaryFile.mockResolvedValue(true)
		const p = await write("photo.jpg")

		await expect(extractTextFromFile(p)).rejects.toThrow("Cannot read text for file type: .jpg")
	})

	it("treats an unreadable binary probe as text rather than refusing", async () => {
		isBinaryFile.mockRejectedValue(new Error("cannot probe"))
		const p = await write("odd.log", "still readable")

		expect(await extractTextFromFile(p)).toContain("still readable")
	})
})
