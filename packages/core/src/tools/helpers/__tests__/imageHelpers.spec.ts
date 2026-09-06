import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	IMAGE_MIME_TYPES,
	ImageMemoryTracker,
	isSupportedImageFormat,
	processImageFile,
	readImageAsDataUrlWithBuffer,
	SUPPORTED_IMAGE_FORMATS,
	validateImageForProcessing,
} from "../imageHelpers.js"

/**
 * The image helpers are what keep a `read_file` over a directory of assets from
 * blowing the context window or the process's memory. The interesting behaviour
 * is the pair of limits and the fact that they are CUMULATIVE: each accepted
 * image is added to a running total, and the next one is refused against that
 * total rather than against its own size alone.
 */

let dir: string

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-image-helpers-"))
})

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true })
})

async function writeImage(name: string, bytes: number): Promise<string> {
	const file = path.join(dir, name)
	await fs.writeFile(file, Buffer.alloc(bytes, 1))
	return file
}

describe("format support", () => {
	it("accepts every declared format, case-insensitively", () => {
		for (const ext of SUPPORTED_IMAGE_FORMATS) {
			expect(isSupportedImageFormat(ext), ext).toBe(true)
			expect(isSupportedImageFormat(ext.toUpperCase()), ext).toBe(true)
		}
	})

	it("rejects a non-image extension", () => {
		expect(isSupportedImageFormat(".ts")).toBe(false)
	})

	it("declares a mime type for every supported format", () => {
		for (const ext of SUPPORTED_IMAGE_FORMATS) {
			expect(IMAGE_MIME_TYPES[ext], ext).toBeTruthy()
		}
	})
})

describe("readImageAsDataUrlWithBuffer", () => {
	it("builds a data URI from the extension's mime type", async () => {
		const file = await writeImage("a.jpeg", 4)

		const { dataUrl, buffer } = await readImageAsDataUrlWithBuffer(file)

		expect(dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true)
		expect(buffer.length).toBe(4)
	})

	it("falls back to image/png for an extension it does not know", async () => {
		const file = await writeImage("a.unknown", 1)

		expect((await readImageAsDataUrlWithBuffer(file)).dataUrl.startsWith("data:image/png;base64,")).toBe(true)
	})
})

describe("validateImageForProcessing", () => {
	it("refuses every image when the model cannot see them, without touching the file", async () => {
		const result = await validateImageForProcessing(
			path.join(dir, "does-not-exist.png"),
			false,
			DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
			DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
			0,
		)

		expect(result).toMatchObject({ isValid: false, reason: "unsupported_model" })
		expect(result.notice).toContain("does not support images")
	})

	it("accepts an image inside both limits and reports its size", async () => {
		const file = await writeImage("small.png", 1024)

		const result = await validateImageForProcessing(file, true, 5, 20, 0)

		expect(result.isValid).toBe(true)
		expect(result.sizeInMB).toBeCloseTo(1024 / (1024 * 1024))
	})

	it("refuses an image over the PER-FILE limit", async () => {
		const file = await writeImage("big.png", 3 * 1024 * 1024)

		const result = await validateImageForProcessing(file, true, 1, 20, 0)

		expect(result).toMatchObject({ isValid: false, reason: "size_limit" })
		expect(result.sizeInMB).toBeCloseTo(3)
	})

	it("refuses an image that would push the CUMULATIVE total over the limit", async () => {
		const file = await writeImage("medium.png", 2 * 1024 * 1024)

		// On its own it passes; after 19MB of earlier images it does not.
		expect((await validateImageForProcessing(file, true, 5, 20, 0)).isValid).toBe(true)

		const result = await validateImageForProcessing(file, true, 5, 20, 19)
		expect(result).toMatchObject({ isValid: false, reason: "memory_limit" })
		expect(result.notice).toContain("20MB")
	})
})

describe("processImageFile", () => {
	it("reports the size in both KB and MB alongside the data URI", async () => {
		const file = await writeImage("a.png", 2048)

		const result = await processImageFile(file)

		expect(result.sizeInKB).toBe(2)
		expect(result.sizeInMB).toBeCloseTo(2048 / (1024 * 1024))
		expect(result.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
		expect(result.buffer.length).toBe(2048)
		expect(result.notice).toBeTruthy()
	})
})

describe("ImageMemoryTracker", () => {
	it("accumulates and resets", () => {
		const tracker = new ImageMemoryTracker()
		expect(tracker.getTotalMemoryUsed()).toBe(0)

		tracker.addMemoryUsage(1.5)
		tracker.addMemoryUsage(2.5)
		expect(tracker.getTotalMemoryUsed()).toBe(4)

		tracker.reset()
		expect(tracker.getTotalMemoryUsed()).toBe(0)
	})
})
