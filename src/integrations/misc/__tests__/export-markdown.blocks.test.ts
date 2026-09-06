// npx vitest src/integrations/misc/__tests__/export-markdown.blocks.test.ts

/**
 * The markdown transcript. Its whole job is to render every content-block kind
 * a provider can emit into something a human reads, which makes the DEFAULT
 * branch the interesting one: a block type nobody taught it about must be
 * labelled rather than silently dropped, or an export quietly loses a turn.
 */

const hoisted = vi.hoisted(() => ({
	showSaveDialog: vi.fn(),
	showTextDocument: vi.fn(),
	writeFile: vi.fn(async () => undefined),
}))

vi.mock("vscode", () => ({
	Uri: { file: (p: string) => ({ fsPath: p }) },
	window: { showSaveDialog: hoisted.showSaveDialog, showTextDocument: hoisted.showTextDocument },
	workspace: { fs: { writeFile: hoisted.writeFile } },
}))

import type { Anthropic } from "@anthropic-ai/sdk"

import {
	buildTaskMarkdown,
	downloadTask,
	formatContentBlockToMarkdown,
	getTaskFileName,
	saveMarkdownFile,
	type ExtendedContentBlock,
} from "../export-markdown"

beforeEach(() => vi.clearAllMocks())

describe("getTaskFileName", () => {
	it("renders a lowercase month, a 12-hour clock and an .md suffix", () => {
		expect(getTaskFileName(new Date(2026, 5, 13, 14, 5, 9).getTime())).toBe("shofer_task_jun-13-2026_2-05-09-pm.md")
	})

	it("renders midnight as 12am", () => {
		expect(getTaskFileName(new Date(2026, 0, 1, 0, 0, 0).getTime())).toContain("_12-00-00-am.md")
	})
})

describe("formatContentBlockToMarkdown", () => {
	it("passes text through unchanged", () => {
		expect(formatContentBlockToMarkdown({ type: "text", text: "hello" })).toBe("hello")
	})

	it("renders an image as a PLACEHOLDER — the bytes have no place in a transcript", () => {
		expect(formatContentBlockToMarkdown({ type: "image", source: {} } as ExtendedContentBlock)).toBe("[Image]")
	})

	it("renders a tool_use with Capitalised parameter names", () => {
		const rendered = formatContentBlockToMarkdown({
			type: "tool_use",
			id: "c1",
			name: "read_file",
			input: { path: "a.ts", start: 1 },
		})

		expect(rendered).toBe("[Tool Use: read_file]\nPath: a.ts\nStart: 1")
	})

	it("JSON-stringifies a NESTED tool_use value rather than printing [object Object]", () => {
		const rendered = formatContentBlockToMarkdown({
			type: "tool_use",
			id: "c1",
			name: "t",
			input: { opts: { deep: true } },
		})

		expect(rendered).toContain('"deep": true')
	})

	it("stringifies a non-object tool_use input", () => {
		expect(formatContentBlockToMarkdown({ type: "tool_use", id: "c1", name: "t", input: "raw" } as never)).toBe(
			"[Tool Use: t]\nraw",
		)
	})

	it("treats a NULL tool_use input as a scalar rather than iterating it", () => {
		expect(formatContentBlockToMarkdown({ type: "tool_use", id: "c1", name: "t", input: null } as never)).toBe(
			"[Tool Use: t]\nnull",
		)
	})

	it("marks a FAILED tool result", () => {
		expect(
			formatContentBlockToMarkdown({ type: "tool_result", tool_use_id: "c1", content: "denied", is_error: true }),
		).toBe("[Tool (Error)]\ndenied")
	})

	it("renders a structured tool result by recursing into its blocks", () => {
		const rendered = formatContentBlockToMarkdown({
			type: "tool_result",
			tool_use_id: "c1",
			content: [
				{ type: "text", text: "line one" },
				{ type: "image", source: {} },
			],
		} as never)

		expect(rendered).toBe("[Tool]\nline one\n[Image]")
	})

	it("renders a tool result with NO content as a bare label", () => {
		expect(formatContentBlockToMarkdown({ type: "tool_result", tool_use_id: "c1" } as never)).toBe("[Tool]")
	})

	it("labels reasoning so it is distinguishable from the reply", () => {
		expect(formatContentBlockToMarkdown({ type: "reasoning", text: "because" })).toBe("[Reasoning]\nbecause")
	})

	it("renders a thoughtSignature as NOTHING — it is not human-readable", () => {
		expect(formatContentBlockToMarkdown({ type: "thoughtSignature" })).toBe("")
	})

	it("LABELS an unknown block type rather than dropping the turn", () => {
		expect(formatContentBlockToMarkdown({ type: "something_new" } as never)).toBe(
			"[Unexpected content type: something_new]",
		)
	})
})

describe("buildTaskMarkdown", () => {
	it("labels each turn by role and separates calls with a rule", () => {
		const markdown = buildTaskMarkdown([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		] as Anthropic.MessageParam[])

		expect(markdown).toBe("**User:**\n\nhello\n\n---\n\n**Assistant:**\n\nhi\n\n")
	})

	it("renders an empty conversation as an empty document", () => {
		expect(buildTaskMarkdown([])).toBe("")
	})
})

describe("saveMarkdownFile / downloadTask", () => {
	it("returns undefined and writes NOTHING when the user cancels", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce(undefined)

		await expect(saveMarkdownFile("# hi", { fsPath: "/d.md" } as never)).resolves.toBeUndefined()
		expect(hoisted.writeFile).not.toHaveBeenCalled()
	})

	it("writes the document and opens it as a PREVIEW", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/out.md" })

		await expect(saveMarkdownFile("# hi", { fsPath: "/d.md" } as never)).resolves.toEqual({ fsPath: "/out.md" })

		expect(hoisted.writeFile).toHaveBeenCalledWith({ fsPath: "/out.md" }, Buffer.from("# hi"))
		expect(hoisted.showTextDocument).toHaveBeenCalledWith({ fsPath: "/out.md" }, { preview: true })
	})

	it("downloadTask renders the conversation before saving it", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/out.md" })

		await downloadTask(
			0,
			[{ role: "user", content: "hello" }] as Anthropic.MessageParam[],
			{
				fsPath: "/d.md",
			} as never,
		)

		const [, bytes] = hoisted.writeFile.mock.calls[0] as unknown as [unknown, Buffer]
		expect(bytes.toString()).toContain("**User:**")
	})
})
