// npx vitest src/utils/__tests__/highlightDiff.spec.tsx
//
// The two-sided diff highlighter. Every branch here is a FALLBACK: Shiki can
// fail to load, return a shape the extractor does not recognise, or return a
// line count that does not match the text — and in each case the diff must
// still render as plain lines rather than throwing inside a chat row.

import { highlightHunks } from "../highlightDiff"
import { getHighlighter } from "../highlighter"

vi.mock("../highlighter", () => ({ getHighlighter: vi.fn() }))

const mockedGetHighlighter = vi.mocked(getHighlighter)

/** A Shiki-shaped hast with one `.line` span per line of `text`. */
const hastFor = (text: string) => ({
	children: [
		{
			children: [
				{
					children: text.split("\n").map((line) => ({
						type: "element",
						tagName: "span",
						properties: { className: ["line"] },
						children: [{ type: "text", value: line }],
					})),
				},
			],
		},
	],
})

const withHast = (impl: (code: string, options: Record<string, unknown>) => unknown) =>
	mockedGetHighlighter.mockResolvedValue({ codeToHast: vi.fn(impl) } as never)

beforeEach(() => vi.clearAllMocks())

describe("highlightHunks", () => {
	it("returns one node per line on each side", async () => {
		withHast((code) => hastFor(code))
		const { oldLines, newLines } = await highlightHunks("a\nb", "a\nc", "ts", "dark")

		expect(oldLines).toHaveLength(2)
		expect(newLines).toHaveLength(2)
	})

	it("picks the theme from the caller's side", async () => {
		const codeToHast = vi.fn((code: string) => hastFor(code))
		mockedGetHighlighter.mockResolvedValue({ codeToHast } as never)

		await highlightHunks("a", "b", "ts", "light")
		expect(codeToHast.mock.calls[0][1]).toMatchObject({ theme: "github-light" })

		codeToHast.mockClear()
		await highlightHunks("a", "b", "ts", "dark")
		expect(codeToHast.mock.calls[0][1]).toMatchObject({ theme: "github-dark" })
	})

	it("returns plain lines for blank text without asking Shiki", async () => {
		const codeToHast = vi.fn((code: string) => hastFor(code))
		mockedGetHighlighter.mockResolvedValue({ codeToHast } as never)

		const { oldLines } = await highlightHunks("   \n  ", "x", "ts", "dark")
		expect(oldLines).toEqual(["   ", "  "])
	})

	it("falls back to plain lines when the hast has no code element", async () => {
		withHast(() => ({ children: [] }))
		const { oldLines } = await highlightHunks("a\nb", "a\nb", "ts", "dark")

		expect(oldLines).toEqual(["a", "b"])
	})

	it("re-highlights line by line when the extracted count disagrees", async () => {
		// A hast whose line spans do not match the text's line count sends the
		// extractor down its per-line path.
		let call = 0
		withHast((code) => {
			call++
			return call % 2 === 1 ? hastFor("only-one-line") : hastFor(code)
		})

		const { oldLines } = await highlightHunks("a\nb\nc", "x", "ts", "dark")
		expect(oldLines).toHaveLength(3)
	})

	it("keeps a blank line blank on the per-line path", async () => {
		let call = 0
		withHast((code) => {
			call++
			return call === 1 ? hastFor("mismatch") : hastFor(code)
		})

		const { oldLines } = await highlightHunks("a\n\nb", "x", "ts", "dark")
		expect(oldLines[1]).toBe("")
	})

	it("keeps the raw line when the per-line highlight throws", async () => {
		let call = 0
		withHast(() => {
			call++
			if (call === 1) return hastFor("mismatch")
			throw new Error("shiki blew up")
		})

		const { oldLines } = await highlightHunks("a\nb", "x", "ts", "dark")
		expect(oldLines).toEqual(["a", "b"])
	})

	it("keeps the raw line when the per-line hast has no code element", async () => {
		let call = 0
		withHast(() => {
			call++
			if (call === 1) return hastFor("mismatch")
			return { children: [] }
		})

		const { oldLines } = await highlightHunks("a\nb", "x", "ts", "dark")
		expect(oldLines).toEqual(["a", "b"])
	})

	it("falls back to plain lines when Shiki throws outright", async () => {
		withHast(() => {
			throw new Error("boom")
		})

		const { oldLines, newLines } = await highlightHunks("a\nb", "c", "ts", "dark")
		expect(oldLines).toEqual(["a", "b"])
		expect(newLines).toEqual(["c"])
	})

	it("falls back to plain lines when the highlighter cannot be loaded at all", async () => {
		mockedGetHighlighter.mockRejectedValue(new Error("wasm missing"))

		const { oldLines, newLines } = await highlightHunks("a\nb", "c\nd", "ts", "dark")
		expect(oldLines).toEqual(["a", "b"])
		expect(newLines).toEqual(["c", "d"])
	})

	it("applies its transformers to the emitted nodes", async () => {
		const codeToHast = vi.fn((code: string, options: any) => {
			const pre = { properties: {} as Record<string, unknown> }
			const codeNode = { properties: {} as Record<string, unknown> }
			const lineNode = { properties: {} as Record<string, unknown> }
			for (const transformer of options.transformers ?? []) {
				transformer.pre?.(pre)
				transformer.code?.(codeNode)
				transformer.line?.(lineNode, 1)
			}
			expect(pre.properties.style).toContain("padding:0")
			expect(codeNode.properties.class).toBe("hljs language-ts")
			expect(lineNode.properties["data-line"]).toBe(1)
			return hastFor(code)
		})
		mockedGetHighlighter.mockResolvedValue({ codeToHast } as never)

		await highlightHunks("a", "b", "ts", "dark")
		expect(codeToHast).toHaveBeenCalled()
	})
})
