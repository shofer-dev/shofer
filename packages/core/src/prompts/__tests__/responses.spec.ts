import * as path from "path"

import { formatResponse } from "../responses.js"

/**
 * `formatResponse` builds the strings the MODEL reads back from a tool call, so
 * its shapes are a wire format in everything but name: the refusals are JSON
 * with a `status` discriminant, and the file listing is what a model uses to
 * decide where to look next.
 *
 * The listing's SORT is the part worth pinning — siblings are alphabetical, but
 * a directory is placed immediately before the entries beneath it, so a
 * TRUNCATED list still shows the directories worth exploring rather than an
 * arbitrary alphabetical prefix.
 */

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>

describe("formatResponse — refusals and errors", () => {
	it("marks a denial, with and without the user's words", () => {
		expect(parse(formatResponse.toolDenied())).toEqual({
			status: "denied",
			message: "The user denied this operation.",
		})
		expect(parse(formatResponse.toolDeniedWithFeedback("not that file"))).toEqual({
			status: "denied",
			feedback: "not that file",
		})
		expect(parse(formatResponse.toolApprovedWithFeedback("go on"))).toEqual({
			status: "approved",
			feedback: "go on",
		})
	})

	it("marks a tool failure and carries the error text", () => {
		expect(parse(formatResponse.toolError("boom"))).toEqual({
			status: "error",
			message: "The tool execution failed",
			error: "boom",
		})
	})

	it("tells the model an ignore rule blocked the path, and what to do instead", () => {
		const result = parse(formatResponse.shoferIgnoreError("secret.env"))

		expect(result).toMatchObject({ status: "error", type: "access_denied", path: "secret.env" })
		expect(String(result.suggestion)).toContain("continue without this file")
	})

	it("distinguishes an unknown MCP server, an unknown tool and a malformed argument", () => {
		expect(parse(formatResponse.unknownMcpServerError("srv", ["a", "b"]))).toMatchObject({
			type: "unknown_server",
			server: "srv",
			available_servers: ["a", "b"],
		})
		expect(parse(formatResponse.unknownMcpToolError("srv", "t", []))).toMatchObject({
			type: "unknown_tool",
			tool: "t",
			available_tools: [],
		})
		expect(parse(formatResponse.invalidMcpToolArgumentError("srv", "t"))).toMatchObject({
			type: "invalid_argument",
			server: "srv",
			tool: "t",
		})
	})

	it("nudges a tool-free reply toward attempt_completion or a question", () => {
		const nudge = formatResponse.noToolsUsed()

		expect(nudge).toContain("You did not use a tool")
		expect(nudge).toContain("attempt_completion")
		expect(nudge).toContain("ask_followup_question")
	})

	it("names the parameter a call was missing", () => {
		expect(formatResponse.missingToolParameterError("path")).toContain("required parameter 'path'")
	})

	it("marks repeated mistakes as guidance rather than as an error", () => {
		expect(parse(formatResponse.tooManyMistakes("slow down"))).toEqual({
			status: "guidance",
			feedback: "slow down",
		})
	})
})

describe("formatResponse — tool results with images", () => {
	it("returns a bare string when there are no images", () => {
		expect(formatResponse.toolResult("just text")).toBe("just text")
		expect(formatResponse.toolResult("just text", [])).toBe("just text")
	})

	it("puts the images AFTER the text, which reads better to the model", () => {
		const blocks = formatResponse.toolResult("look", ["data:image/png;base64,AAAA"])

		expect(Array.isArray(blocks)).toBe(true)
		expect((blocks as Array<{ type: string }>)[0]).toEqual({ type: "text", text: "look" })
		expect((blocks as Array<{ type: string }>)[1]!.type).toBe("image")
	})

	it("builds image blocks on their own, and tolerates no images at all", () => {
		expect(formatResponse.imageBlocks()).toEqual([])
		expect(formatResponse.imageBlocks(["data:image/jpeg;base64,BBBB"])[0]).toMatchObject({
			type: "image",
			source: { type: "base64", media_type: "image/jpeg", data: "BBBB" },
		})
	})
})

describe("formatResponse — file listing", () => {
	const ROOT = path.resolve("/ws")
	const abs = (p: string) => path.join(ROOT, p)

	it("lists a directory immediately before its own children", () => {
		const listing = formatResponse.formatFilesList(
			ROOT,
			[abs("src/b.ts"), abs("README.md"), abs("src/"), abs("src/a.ts")],
			false,
			undefined,
			false,
		)

		// Siblings sort alphabetically; a directory precedes the entries beneath
		// it, which is what keeps a TRUNCATED list showing directories worth
		// exploring rather than an arbitrary alphabetical prefix.
		expect(listing.split("\n")).toEqual(["README.md", "src/", "src/a.ts", "src/b.ts"])
	})

	it("says so plainly when nothing was found", () => {
		expect(formatResponse.formatFilesList(ROOT, [], false, undefined, false)).toBe("No files found.")
	})

	it("appends the truncation hint when the walk hit its limit", () => {
		const listing = formatResponse.formatFilesList(ROOT, [abs("a.ts")], true, undefined, false)

		expect(listing).toContain("File list truncated")
		expect(listing).toContain("list_files on specific subdirectories")
	})

	it("hides an ignored file, or marks it with a lock when the user asked to see them", () => {
		const controller = { validateAccess: (p: string) => !p.endsWith("secret.env") } as never

		expect(formatResponse.formatFilesList(ROOT, [abs("a.ts"), abs("secret.env")], false, controller, false)).toBe(
			"a.ts",
		)

		const shown = formatResponse.formatFilesList(ROOT, [abs("a.ts"), abs("secret.env")], false, controller, true)
		expect(shown).toContain("secret.env")
		expect(shown.split("\n").find((l) => l.includes("secret.env"))).not.toBe("secret.env")
	})

	it("marks a write-protected file with the shield, and only when it is not ignored", () => {
		const ignore = { validateAccess: (p: string) => !p.endsWith("secret.env") } as never
		const protect = { isWriteProtected: (p: string) => p.endsWith("AGENTS.md") } as never

		const listing = formatResponse.formatFilesList(
			ROOT,
			[abs("AGENTS.md"), abs("a.ts"), abs("secret.env")],
			false,
			ignore,
			true,
			protect,
		)

		expect(listing).toContain("🛡️ AGENTS.md")
		expect(listing).toContain("a.ts")
		expect(listing).not.toContain("🛡️ secret.env")
	})
})

describe("formatResponse — createPrettyPatch", () => {
	it("returns the changed hunk without the diff header", () => {
		const patch = formatResponse.createPrettyPatch("a.ts", "one\ntwo\n", "one\nTWO\n")

		expect(patch).toContain("-two")
		expect(patch).toContain("+TWO")
		expect(patch).not.toContain("===")
	})

	it("returns nothing for identical content", () => {
		expect(formatResponse.createPrettyPatch("a.ts", "same\n", "same\n")).toBe("")
	})

	it("treats an absent side as empty rather than throwing", () => {
		expect(() => formatResponse.createPrettyPatch("a.ts", undefined, "new\n")).not.toThrow()
		expect(formatResponse.createPrettyPatch("a.ts", undefined, "new\n")).toContain("+new")
	})
})
