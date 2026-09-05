// npx vitest src/utils/__tests__/small-utils.spec.ts
//
// The webview's small pure helpers, plus the two that touch a browser API
// (the blob download and the diagnostic log that mirrors to the host).

import { formatCostBreakdown, getCostBreakdownIfNeeded } from "../costFormatting"
import { formatPathTooltip } from "../formatPathTooltip"
import { triggerBrowserDownload } from "../browserDownload"
import { appendImages } from "../imageUtils"
import { buildDocLink } from "../docLinks"
import { isValidUrl } from "../url"
import { formatPrice } from "../formatPrice"
import { removeLeadingNonAlphanumeric } from "../removeLeadingNonAlphanumeric"
import { findMatchingResourceOrTemplate, findMatchingTemplate } from "../mcp"
import { getLanguageFromPath } from "../getLanguageFromPath"
import { convertToMentionPath, escapeSpaces } from "../path-mentions"
import { webviewLog } from "../webviewLog"

const postMessage = vi.fn()
vi.mock("../vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

beforeEach(() => vi.clearAllMocks())

describe("costFormatting", () => {
	it("formats the own/subtask split to cents", () => {
		expect(formatCostBreakdown(1, 0.5, { own: "Own", subtasks: "Subtasks" })).toBe("Own: $1.00 + Subtasks: $0.50")
	})

	it("offers a breakdown only when subtasks actually cost something", () => {
		const labels = { own: "Own", subtasks: "Subtasks" }
		expect(getCostBreakdownIfNeeded(undefined, labels)).toBeUndefined()
		expect(getCostBreakdownIfNeeded({ ownCost: 1, childrenCost: 0 }, labels)).toBeUndefined()
		expect(getCostBreakdownIfNeeded({ ownCost: 1, childrenCost: 0.25 }, labels)).toBe(
			"Own: $1.00 + Subtasks: $0.25",
		)
	})
})

describe("formatPathTooltip", () => {
	it("returns an empty string for no path", () => {
		expect(formatPathTooltip()).toBe("")
	})

	it("strips the leading separator and appends the LRM mark", () => {
		expect(formatPathTooltip("/src/a.ts")).toBe("src/a.ts\u200E")
	})

	it("appends extra content after a space", () => {
		expect(formatPathTooltip("/src/a.ts", ":42-45")).toBe("src/a.ts\u200E :42-45")
	})
})

describe("removeLeadingNonAlphanumeric", () => {
	it("removes only the punctuation that breaks the leading-ellipsis trick", () => {
		expect(removeLeadingNonAlphanumeric('///:*?"<>|src/a.ts')).toBe("src/a.ts")
	})

	it("preserves non-latin leading characters", () => {
		expect(removeLeadingNonAlphanumeric("файл.ts")).toBe("файл.ts")
		expect(removeLeadingNonAlphanumeric("文件.ts")).toBe("文件.ts")
	})
})

describe("triggerBrowserDownload", () => {
	it("hands the bytes to the browser as a blob anchor and cleans up after a tick", () => {
		vi.useFakeTimers()
		const createObjectURL = vi.fn().mockReturnValue("blob:xyz")
		const revokeObjectURL = vi.fn()
		Object.assign(URL, { createObjectURL, revokeObjectURL })
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

		triggerBrowserDownload("task.json", "{}", "application/json")

		expect(createObjectURL).toHaveBeenCalled()
		expect(click).toHaveBeenCalled()
		expect(document.querySelector("a")).toBeNull()

		expect(revokeObjectURL).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1000)
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:xyz")

		click.mockRestore()
		vi.useRealTimers()
	})
})

describe("webviewLog", () => {
	it("mirrors the message to the host output channel", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		webviewLog("hello")
		expect(postMessage).toHaveBeenCalledWith({ type: "webviewLog", text: "hello" })
		expect(log).toHaveBeenCalledWith("hello")
		log.mockRestore()
	})

	it("swallows a post failure during teardown", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		postMessage.mockImplementationOnce(() => {
			throw new Error("gone")
		})
		expect(() => webviewLog("hello")).not.toThrow()
		log.mockRestore()
	})
})

describe("appendImages", () => {
	it("returns the current list untouched when nothing is added", () => {
		const current = ["a"]
		expect(appendImages(current, undefined, 5)).toBe(current)
		expect(appendImages(current, [], 5)).toBe(current)
	})

	it("appends and clamps to the maximum", () => {
		expect(appendImages(["a"], ["b", "c", "d"], 3)).toEqual(["a", "b", "c"])
	})
})

describe("buildDocLink", () => {
	it("builds a UTM-tagged docs url", () => {
		expect(buildDocLink("features/mcp", "mcp_settings")).toBe(
			"https://shofer.dev/docs/features/mcp?utm_source=extension&utm_medium=ide&utm_campaign=mcp_settings",
		)
	})

	it("tolerates a leading slash and keeps a fragment after the query", () => {
		expect(buildDocLink("/features/mcp#editing", "c")).toBe(
			"https://shofer.dev/docs/features/mcp?utm_source=extension&utm_medium=ide&utm_campaign=c#editing",
		)
	})

	it("encodes the campaign", () => {
		expect(buildDocLink("a", "a b&c")).toContain("utm_campaign=a%20b%26c")
	})
})

describe("isValidUrl", () => {
	it.each([
		["https://example.test/x", true],
		["file:///tmp/a", true],
		["not a url", false],
		["", false],
	])("%s → %s", (input, expected) => {
		expect(isValidUrl(input)).toBe(expected)
	})
})

describe("formatPrice", () => {
	it("renders two-decimal USD", () => {
		expect(formatPrice(1)).toBe("$1.00")
		expect(formatPrice(1234.567)).toBe("$1,234.57")
	})
})

describe("mcp resource matching", () => {
	const templates = [
		{ uriTemplate: "file:///{path}", name: "files" },
		{ uriTemplate: "db://{table}/{id}", name: "rows" },
	] as never

	it("matches a template by its placeholders", () => {
		expect(findMatchingTemplate("file:///a.txt", templates)).toMatchObject({ name: "files" })
		expect(findMatchingTemplate("db://users/7", templates)).toMatchObject({ name: "rows" })
	})

	it("does not let a placeholder span a path separator", () => {
		expect(findMatchingTemplate("db://users/7/extra", templates)).toBeUndefined()
	})

	it("returns nothing when no template is supplied", () => {
		expect(findMatchingTemplate("file:///a")).toBeUndefined()
	})

	it("prefers an exact resource over a template", () => {
		const resources = [{ uri: "file:///a.txt", name: "exact" }] as never
		expect(findMatchingResourceOrTemplate("file:///a.txt", resources, templates)).toMatchObject({
			name: "exact",
		})
	})

	it("falls back to a template, then to nothing", () => {
		expect(findMatchingResourceOrTemplate("file:///b.txt", [], templates)).toMatchObject({ name: "files" })
		expect(findMatchingResourceOrTemplate("nope://x", [], templates)).toBeUndefined()
		expect(findMatchingResourceOrTemplate("nope://x")).toBeUndefined()
	})
})

describe("getLanguageFromPath", () => {
	it.each([
		["a.ts", "typescript"],
		["a.TSX", "tsx"],
		["a.yml", "yaml"],
		["Makefile", undefined],
		["a.unknownext", undefined],
	])("%s → %s", (path, expected) => {
		expect(getLanguageFromPath(path)).toBe(expected)
	})
})

describe("path mentions", () => {
	it("escapes spaces", () => {
		expect(escapeSpaces("a b/c d.ts")).toBe("a\\ b/c\\ d.ts")
	})

	it("relativises a path inside the workspace into a mention", () => {
		expect(convertToMentionPath("/repo/src/a.ts", "/repo")).toBe("@/src/a.ts")
		expect(convertToMentionPath("/repo/src/a.ts", "/repo/")).toBe("@/src/a.ts")
	})

	it("matches the workspace case-insensitively and escapes spaces in the result", () => {
		expect(convertToMentionPath("/Repo/my file.ts", "/repo")).toBe("@/my\\ file.ts")
	})

	it("leaves a path outside the workspace alone", () => {
		expect(convertToMentionPath("/elsewhere/a.ts", "/repo")).toBe("/elsewhere/a.ts")
	})

	it("returns the bare path when there is no workspace", () => {
		expect(convertToMentionPath("/repo/src/a.ts")).toBe("/repo/src/a.ts")
	})

	it("strips a file:// protocol", () => {
		expect(convertToMentionPath("file:///repo/src/a.ts", "/repo")).toBe("@/src/a.ts")
	})

	it("strips a vscode-remote:// authority, leaving the path it addresses", () => {
		expect(convertToMentionPath("vscode-remote://ssh-remote%2Bbox/repo/src/a.ts", "repo")).toBe("@/src/a.ts")
	})

	it("yields an empty path for a vscode-remote url with no path segment", () => {
		expect(convertToMentionPath("vscode-remote://authority", "/repo")).toBe("")
	})

	it("drops the leading slash a windows drive url carries", () => {
		expect(convertToMentionPath("file:///d:/repo/a.ts", "d:/repo")).toBe("@/a.ts")
	})

	it("keeps going when the path is not valid percent-encoding", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		expect(convertToMentionPath("/repo/100%.ts", "/repo")).toBe("@/100%.ts")
		expect(error).toHaveBeenCalled()
		error.mockRestore()
	})

	it("normalises windows separators", () => {
		expect(convertToMentionPath("C:\\repo\\src\\a.ts", "C:\\repo")).toBe("@/src/a.ts")
	})
})
