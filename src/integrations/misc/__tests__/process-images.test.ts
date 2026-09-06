// npx vitest src/integrations/misc/__tests__/process-images.test.ts

/**
 * `selectImages` turns an open-dialog selection into data URIs for the model.
 * The interesting parts are the cancel path (an empty array, never `undefined`,
 * because callers concatenate the result) and the extension→MIME mapping, whose
 * default branch THROWS rather than guessing a type the model would reject.
 */

const hoisted = vi.hoisted(() => ({
	showOpenDialog: vi.fn(),
	readFile: vi.fn(async () => Buffer.from("bytes")),
}))

vi.mock("vscode", () => ({
	window: { showOpenDialog: hoisted.showOpenDialog },
}))

vi.mock("fs/promises", () => ({
	default: { readFile: hoisted.readFile },
	readFile: hoisted.readFile,
}))

import { selectImages } from "../process-images"

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.readFile.mockResolvedValue(Buffer.from("bytes"))
})

describe("selectImages", () => {
	it("offers a multi-select dialog filtered to the formats the models accept", async () => {
		hoisted.showOpenDialog.mockResolvedValueOnce(undefined)

		await selectImages()

		const options = hoisted.showOpenDialog.mock.calls[0][0]
		expect(options.canSelectMany).toBe(true)
		expect(options.filters.Images).toEqual(["png", "jpg", "jpeg", "webp"])
	})

	it("returns an EMPTY ARRAY when the user cancels, not undefined", async () => {
		hoisted.showOpenDialog.mockResolvedValueOnce(undefined)
		await expect(selectImages()).resolves.toEqual([])
	})

	it("returns an empty array for an empty selection", async () => {
		hoisted.showOpenDialog.mockResolvedValueOnce([])
		await expect(selectImages()).resolves.toEqual([])
	})

	it.each([
		["/tmp/a.png", "image/png"],
		["/tmp/a.PNG", "image/png"],
		["/tmp/a.jpg", "image/jpeg"],
		["/tmp/a.jpeg", "image/jpeg"],
		["/tmp/a.webp", "image/webp"],
	])("encodes %s as a %s data URI", async (fsPath, mime) => {
		hoisted.showOpenDialog.mockResolvedValueOnce([{ fsPath }])

		const [dataUrl] = await selectImages()

		expect(dataUrl).toBe(`data:${mime};base64,${Buffer.from("bytes").toString("base64")}`)
	})

	it("encodes every selected file", async () => {
		hoisted.showOpenDialog.mockResolvedValueOnce([{ fsPath: "/tmp/a.png" }, { fsPath: "/tmp/b.webp" }])

		const urls = await selectImages()

		expect(urls).toHaveLength(2)
		expect(urls[0]).toContain("image/png")
		expect(urls[1]).toContain("image/webp")
	})

	it("REFUSES an unsupported extension rather than mislabelling it", async () => {
		hoisted.showOpenDialog.mockResolvedValueOnce([{ fsPath: "/tmp/a.gif" }])

		await expect(selectImages()).rejects.toThrow(/Unsupported file type: \.gif/)
	})
})
