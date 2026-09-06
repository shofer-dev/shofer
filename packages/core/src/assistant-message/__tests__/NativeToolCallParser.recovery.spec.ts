import { STUB_ARGUMENTS_JSON_PARAM } from "@shofer/types"

import { NativeToolCallParser, StubArgumentsJsonError } from "../NativeToolCallParser.js"

/**
 * The parser's SILENT RECOVERY layers — the code that exists because models get
 * the call shape slightly wrong in predictable ways, and refusing every one of
 * those would spend a whole turn on a retry the host could have absorbed.
 *
 * Each layer is deliberately narrow, and each is recorded (`consumeRecoveries`)
 * so its hit rate can be watched and the layer retired if it stops earning its
 * keep. Two of them are NOT silent, and that asymmetry is the design:
 *
 *  - an `arguments_json` payload that is not a JSON OBJECT is refused with an
 *    error naming THAT property, because the outer arguments parsed fine and
 *    blaming them would send the model to fix bytes that were already correct;
 *  - a `path` leaked into `apply_diff`'s `diff` value is refused rather than
 *    guessed at — a wrong guess is a confidently-wrong edit to the wrong file,
 *    and a retry is cheaper than that.
 */

const parse = (name: string, args: unknown) =>
	NativeToolCallParser.parseToolCall({
		id: "call-1",
		name: name as never,
		arguments: typeof args === "string" ? args : JSON.stringify(args),
	})

const nativeArgs = (result: unknown) => (result as { nativeArgs?: Record<string, unknown> } | null)?.nativeArgs

afterEach(() => {
	NativeToolCallParser.consumeLastParseError()
	NativeToolCallParser.consumeRecoveries()
})

describe("the arguments_json stub escape hatch", () => {
	it("unwraps a JSON-encoded argument object and records the recovery", () => {
		const result = parse("read_file", { [STUB_ARGUMENTS_JSON_PARAM]: JSON.stringify({ path: "src/a.ts" }) })

		expect(nativeArgs(result)).toMatchObject({ path: "src/a.ts" })
		expect(NativeToolCallParser.consumeRecoveries()).toEqual([
			expect.objectContaining({ layerId: "stub_arguments_json", tool: "read_file" }),
		])
	})

	it("treats an EMPTY hatch as no arguments at all", () => {
		// `read_output_channel` takes none, so this is a legitimate call.
		expect(nativeArgs(parse("read_output_channel", { [STUB_ARGUMENTS_JSON_PARAM]: "  " }))).toBeDefined()
	})

	it("leaves the arguments alone when the hatch is not the ONLY key", () => {
		const result = parse("read_file", { path: "direct.ts", [STUB_ARGUMENTS_JSON_PARAM]: '{"path":"wrapped.ts"}' })

		// A mixed call is a direct call; unwrapping would silently discard the
		// argument the model actually passed.
		expect(nativeArgs(result)).toMatchObject({ path: "direct.ts" })
	})

	it("leaves the arguments alone when the hatch is not a string", () => {
		const result = parse("read_file", { [STUB_ARGUMENTS_JSON_PARAM]: { path: "a.ts" } })

		expect(result).toBeNull()
	})

	it("REFUSES an unparseable payload with an error naming the property", () => {
		expect(parse("read_file", { [STUB_ARGUMENTS_JSON_PARAM]: "{ not json" })).toBeNull()

		const error = NativeToolCallParser.consumeLastParseError()!
		expect(error).toContain(STUB_ARGUMENTS_JSON_PARAM)
		expect(error).toContain("not valid JSON")
		// The outer arguments were fine, so the message must not blame them.
		expect(error).not.toContain("are not valid JSON:")
	})

	it("REFUSES a payload that decodes to something other than an object", () => {
		for (const [encoded, described] of [
			["[1,2,3]", "an array"],
			["42", "a number"],
			["null", "a null"],
		] as const) {
			expect(parse("read_file", { [STUB_ARGUMENTS_JSON_PARAM]: encoded })).toBeNull()
			expect(NativeToolCallParser.consumeLastParseError()).toContain(described)
		}
	})

	it("unwraps optimistically while the call is still STREAMING", () => {
		const parser = new NativeToolCallParser()
		parser.startStreamingToolCall("call-1", "read_file")

		const partial = parser.processStreamingChunk(
			"call-1",
			JSON.stringify({ [STUB_ARGUMENTS_JSON_PARAM]: '{"path":"src/a.ts"}' }),
		)

		expect((partial as { nativeArgs?: { path?: string } }).nativeArgs?.path).toBe("src/a.ts")
	})

	it("renders a still-truncated payload as 'no arguments yet' rather than failing", () => {
		const parser = new NativeToolCallParser()
		parser.startStreamingToolCall("call-1", "read_file")

		// Half an encoded object: the optimistic parse yields nothing usable.
		const partial = parser.processStreamingChunk("call-1", `{"${STUB_ARGUMENTS_JSON_PARAM}": "{\\"pa`)

		expect(partial).not.toBeNull()
	})
})

describe("argument-name aliases", () => {
	it.each([
		["file_path", "src/a.ts"],
		["filePath", "src/a.ts"],
		["filepath", "src/a.ts"],
		["directory", "src"],
		["directory_path", "src"],
		["dir_path", "src"],
		["target_directory", "src"],
		["targetDirectory", "src"],
	])("maps %s onto the canonical path", (alias, value) => {
		expect(nativeArgs(parse("read_file", { [alias]: value }))).toMatchObject({ path: value })
	})

	it("never clobbers an explicitly-provided path", () => {
		expect(nativeArgs(parse("read_file", { path: "canonical.ts", file_path: "alias.ts" }))).toMatchObject({
			path: "canonical.ts",
		})
	})

	it("maps Anthropic's prompt/description onto message/title for a delegation", () => {
		const args = nativeArgs(parse("new_task", { mode: "code", prompt: "do the thing", description: "A title" }))

		expect(args).toMatchObject({ message: "do the thing", title: "A title" })
	})
})

describe("find_files pattern composition", () => {
	const pattern = (args: Record<string, unknown>) =>
		(nativeArgs(parse("find_files", args)) as { pattern?: string } | undefined)?.pattern

	it("anchors a bare filename pattern RECURSIVELY under a supplied directory", () => {
		// A bare `*.ts` matches the workspace root only, so a cross-assistant
		// caller passing a directory would silently miss every subdirectory.
		expect(pattern({ pattern: "*.ts", path: "src" })).toBe("src/**/*.ts")
	})

	it("leaves the pattern alone when no directory is supplied", () => {
		expect(pattern({ pattern: "**/*.ts" })).toBe("**/*.ts")
		expect(pattern({ pattern: "*.ts", path: "" })).toBe("*.ts")
		expect(pattern({ pattern: "*.ts", path: "." })).toBe("*.ts")
	})

	it("does not double-anchor an already-recursive or already-scoped pattern", () => {
		expect(pattern({ pattern: "**/*.ts", path: "src" })).toBe("src/**/*.ts")
		expect(pattern({ pattern: "src/*.ts", path: "src" })).toBe("src/*.ts")
		expect(pattern({ pattern: "/abs/*.ts", path: "src" })).toBe("/abs/*.ts")
	})

	it("tolerates a trailing separator and a leading ./ on the pattern", () => {
		expect(pattern({ pattern: "./*.ts", path: "src/" })).toBe("src/**/*.ts")
	})
})

describe("what the model is told it forgot", () => {
	it.each([
		["apply_diff", {}, ["path", "diff"]],
		["write_to_file", { path: "a.ts" }, ["content"]],
		["execute_command", {}, ["command"]],
		["grep_search", {}, ["path", "query"]],
		["sed", { path: "a.ts" }, ["pattern", "replacement"]],
		["attempt_completion", {}, ["result"]],
		["switch_mode", {}, ["mode_slug", "reason"]],
		["new_task", {}, ["mode", "message"]],
	])("names the missing fields of %s", (tool, args, expected) => {
		expect(parse(tool, args)).toBeNull()

		const error = NativeToolCallParser.consumeLastParseError()!
		for (const field of expected) {
			expect(error).toContain(field)
		}
	})

	it("still refuses a tool with no declared required fields, without naming any", () => {
		expect(parse("view_image", {})).toBeNull()
		expect(NativeToolCallParser.consumeLastParseError()).toContain("Invalid arguments")
	})
})

describe("apply_diff's leaked-path detection", () => {
	it("REFUSES a diff carrying an XML parameter tag instead of guessing the file", () => {
		const diff = 'a\n<parameter name="path" string="true">src/guessed.ts'

		expect(parse("apply_diff", { diff })).toBeNull()

		expect(NativeToolCallParser.consumeLastParseError()).toMatch(/parameter name="path"/)
		expect(NativeToolCallParser.consumeRecoveries()).toEqual([
			expect.objectContaining({ layerId: "apply_diff_xml_leak", rejected: true }),
		])
	})

	it("REFUSES a diff carrying a `:path` suffix instead of guessing the file", () => {
		expect(
			parse("apply_diff", { diff: "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n:path\nsrc/guessed.ts" }),
		).toBeNull()

		expect(NativeToolCallParser.consumeRecoveries()).toEqual([
			expect.objectContaining({ layerId: "apply_diff_colon_leak", rejected: true }),
		])
	})

	it("accepts the same diff once `path` is a separate key", () => {
		const result = parse("apply_diff", {
			path: "src/real.ts",
			diff: "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE",
		})

		expect(nativeArgs(result)).toMatchObject({ path: "src/real.ts" })
	})
})

describe("read_file's legacy multi-file shape", () => {
	it("converts every line-range spelling into the canonical form", () => {
		const result = parse("read_file", {
			files: [
				{ path: "tuple.ts", line_ranges: [[1, 50]] },
				{ path: "object.ts", line_ranges: [{ start: 10, end: 20 }] },
				{ path: "string.ts", line_ranges: ["100-150"] },
				{ path: "mixed.ts", line_ranges: [[1, 2], "bad", { nope: 1 }] },
				{ path: "none.ts" },
			],
		})

		const args = nativeArgs(result) as { files: Array<{ path: string; lineRanges?: unknown[] }> }
		expect(args.files[0]!.lineRanges).toEqual([{ start: 1, end: 50 }])
		expect(args.files[1]!.lineRanges).toEqual([{ start: 10, end: 20 }])
		expect(args.files[2]!.lineRanges).toEqual([{ start: 100, end: 150 }])
		// The unusable entries are dropped, not forwarded.
		expect(args.files[3]!.lineRanges).toEqual([{ start: 1, end: 2 }])
		expect(args.files[4]!.lineRanges).toBeUndefined()
		expect((result as { usedLegacyFormat?: boolean }).usedLegacyFormat).toBe(true)
	})

	it("accepts a DOUBLE-stringified files array, which some models emit", () => {
		const result = parse("read_file", { files: JSON.stringify([{ path: "a.ts" }]) })

		expect((nativeArgs(result) as { files: unknown[] }).files).toHaveLength(1)
	})

	it("falls through to the single-file shape when the array is unusable", () => {
		expect(nativeArgs(parse("read_file", { files: "{ not json", path: "a.ts" }))).toMatchObject({ path: "a.ts" })
		expect(parse("read_file", { files: [] })).toBeNull()
	})
})

describe("numeric coercion", () => {
	it("accepts a number, coerces a numeric string, and drops anything else", () => {
		expect(nativeArgs(parse("read_file", { path: "a.ts", offset: 5, limit: "20" }))).toMatchObject({
			offset: 5,
			limit: 20,
		})
		expect(nativeArgs(parse("read_file", { path: "a.ts", offset: "not a number" }))).toMatchObject({
			offset: undefined,
		})
		expect(nativeArgs(parse("read_file", { path: "a.ts", offset: Number.NaN }))).toMatchObject({
			offset: undefined,
		})
	})
})

describe("the error class", () => {
	it("names itself, so the caller can tell it from an ordinary parse failure", () => {
		const error = new StubArgumentsJsonError("bad payload")

		expect(error.name).toBe("StubArgumentsJsonError")
		expect(error).toBeInstanceOf(Error)
	})
})
