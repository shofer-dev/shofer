import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { BlobStore, BLOB_REF_REGEX, extractBlobRefs, formatBlobRef } from "../BlobStore"

let tmpDir: string

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-blobstore-"))
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("BlobStore", () => {
	it("writes and reads a blob by sha256", async () => {
		const store = new BlobStore(tmpDir)
		const ref = await store.write("hello world")
		expect(ref.bytes).toBe(11)
		expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/)
		const back = await store.read(ref.sha256)
		expect(back).toBe("hello world")
	})

	it("is idempotent for identical content (no rewrite)", async () => {
		const store = new BlobStore(tmpDir)
		const a = await store.write("payload")
		const b = await store.write("payload")
		expect(a.sha256).toBe(b.sha256)
	})

	it("read returns undefined for a missing blob", async () => {
		const store = new BlobStore(tmpDir)
		expect(await store.read("a".repeat(64))).toBeUndefined()
	})

	it("externalizeIfOverCap leaves small content inline", async () => {
		const store = new BlobStore(tmpDir)
		const out = await store.externalizeIfOverCap("short", 1024)
		expect(out).toBe("short")
	})

	it("externalizeIfOverCap externalises content above the cap", async () => {
		const store = new BlobStore(tmpDir)
		const big = "x".repeat(5000)
		const out = await store.externalizeIfOverCap(big, 2048)
		expect(out).toMatch(BLOB_REF_REGEX)
		const refs = extractBlobRefs(out)
		expect(refs).toHaveLength(1)
		expect(refs[0].bytes).toBe(5000)
		expect(await store.read(refs[0].sha256)).toBe(big)
	})

	it("externalizeIfOverCap does not re-wrap an existing single ref", async () => {
		const store = new BlobStore(tmpDir)
		const ref = formatBlobRef({ sha256: "a".repeat(64), bytes: 5000 })
		const out = await store.externalizeIfOverCap(ref, 1)
		expect(out).toBe(ref)
	})

	it("resolveRefs replaces tokens with content", async () => {
		const store = new BlobStore(tmpDir)
		const big = "y".repeat(3000)
		const ref = await store.write(big)
		const wrapped = `before ${formatBlobRef(ref)} after`
		const resolved = await store.resolveRefs(wrapped)
		expect(resolved).toBe(`before ${big} after`)
	})

	it("resolveRefs replaces missing refs with a visible banner", async () => {
		const store = new BlobStore(tmpDir)
		const ref = formatBlobRef({ sha256: "b".repeat(64), bytes: 42 })
		const out = await store.resolveRefs(ref)
		expect(out).toContain("missing")
		expect(out).toContain("42 bytes")
	})

	it("deleteAll removes the blobs directory", async () => {
		const store = new BlobStore(tmpDir)
		await store.write("data")
		await store.deleteAll()
		await expect(fs.access(store.dir)).rejects.toBeTruthy()
	})
})
