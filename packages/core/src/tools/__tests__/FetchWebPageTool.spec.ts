import { FetchWebPageTool } from "../FetchWebPageTool.js"
import { makeToolCallbacks, toolResults } from "./helpers/fakeEditTask.js"

/**
 * `fetch_web_page` downloads pages and reduces them to text.
 *
 * No network is touched: the global `fetch` is replaced per test, which is
 * also the honest seam — the tool calls `fetch` directly rather than through an
 * injectable client, so a stub here is the whole boundary.
 */

function buildTask() {
	return {
		taskId: "task-1",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn(async (tool: string, param: string) => `Missing ${param} for ${tool}`),
	} as any
}

/** A `fetch` stub answering one canned response per URL. */
function stubFetch(byUrl: Record<string, { body: string; contentType?: string; status?: number }>) {
	const fetchMock = vi.fn(async (url: string) => {
		const canned = byUrl[url]
		if (!canned) throw new Error(`network unreachable: ${url}`)
		const status = canned.status ?? 200
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: status === 200 ? "OK" : "Not Found",
			headers: { get: () => canned.contentType ?? "text/html" },
			text: async () => canned.body,
		}
	})
	vi.stubGlobal("fetch", fetchMock)
	return fetchMock
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("FetchWebPageTool", () => {
	it("extracts the title and body text from HTML, dropping script and style", async () => {
		stubFetch({
			"https://example.com": {
				body: [
					"<html><head><title>The &amp; Title</title><style>body{}</style></head>",
					"<body><script>doThings()</script>",
					"<p>A paragraph long enough to survive the twenty-character filter.</p>",
					"</body></html>",
				].join(""),
			},
		})
		const cbs = makeToolCallbacks()

		await new FetchWebPageTool().execute({ urls: ["https://example.com"] }, buildTask(), cbs)

		const out = toolResults(cbs)
		expect(out).toContain("## https://example.com")
		expect(out).toContain("# The & Title")
		expect(out).toContain("A paragraph long enough")
		expect(out).not.toContain("doThings")
		expect(out).not.toContain("body{}")
	})

	it("passes text/plain through untouched", async () => {
		stubFetch({
			"https://example.com/robots.txt": { body: "User-agent: *\nDisallow:", contentType: "text/plain" },
		})
		const cbs = makeToolCallbacks()

		await new FetchWebPageTool().execute({ urls: ["https://example.com/robots.txt"] }, buildTask(), cbs)

		expect(toolResults(cbs)).toContain("User-agent: *")
	})

	it("pretty-prints JSON, and falls back to the raw body when it does not parse", async () => {
		stubFetch({
			"https://api.example.com/ok": { body: '{"a":1}', contentType: "application/json" },
			"https://api.example.com/bad": { body: "{not json", contentType: "application/json" },
		})
		const cbs = makeToolCallbacks()

		await new FetchWebPageTool().execute(
			{ urls: ["https://api.example.com/ok", "https://api.example.com/bad"] },
			buildTask(),
			cbs,
		)

		const out = toolResults(cbs)
		expect(out).toContain('"a": 1')
		expect(out).toContain("{not json")
	})

	it("keeps only the lines around a query match, with their neighbours", async () => {
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i} filler text that is long enough`)
		lines[6] = "the needle we are looking for lives on this line"
		stubFetch({
			"https://example.com": {
				body: `<html><body>${lines.map((l) => `<p>${l}</p>`).join("\n\n")}</body></html>`,
			},
		})
		const cbs = makeToolCallbacks()

		await new FetchWebPageTool().execute({ urls: ["https://example.com"], query: "needle" }, buildTask(), cbs)

		expect(toolResults(cbs)).toContain("needle")
	})

	it("says so when the query matches nothing on the page", async () => {
		stubFetch({
			"https://example.com": {
				body: "<html><body><p>An unrelated paragraph of sufficient length.</p></body></html>",
			},
		})
		const cbs = makeToolCallbacks()

		await new FetchWebPageTool().execute({ urls: ["https://example.com"], query: "absent" }, buildTask(), cbs)

		expect(toolResults(cbs)).toContain('No content matching query: "absent"')
	})

	it("reports a per-URL failure as its own section without losing the others", async () => {
		stubFetch({
			"https://good.example": { body: "<html><body><p>Content that is long enough here.</p></body></html>" },
			"https://missing.example": { body: "nope", status: 404 },
		})
		const cbs = makeToolCallbacks()

		await new FetchWebPageTool().execute(
			{ urls: ["https://good.example", "https://missing.example", "not-a-url"] },
			buildTask(),
			cbs,
		)

		const out = toolResults(cbs)
		expect(out).toContain("Content that is long enough here.")
		expect(out).toContain("## https://missing.example\n\nError: HTTP 404")
		expect(out).toContain("## not-a-url\n\nError: Invalid URL: not-a-url")
	})

	it("refuses a non-HTTP scheme", async () => {
		stubFetch({})
		const cbs = makeToolCallbacks()

		await new FetchWebPageTool().execute({ urls: ["file:///etc/passwd"] }, buildTask(), cbs)

		expect(toolResults(cbs)).toContain("Error: Invalid URL: file:///etc/passwd")
	})

	it("fetches nothing when the user rejects", async () => {
		const fetchMock = stubFetch({})
		const cbs = makeToolCallbacks(false)

		await new FetchWebPageTool().execute({ urls: ["https://example.com"] }, buildTask(), cbs)

		expect(fetchMock).not.toHaveBeenCalled()
		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	it.each([[[]], [undefined]])("reports missing urls (%s) as a usage mistake", async (urls) => {
		const task = buildTask()
		const cbs = makeToolCallbacks()

		await new FetchWebPageTool().execute({ urls: urls as string[] }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(toolResults(cbs)).toContain("Missing urls for fetch_web_page")
	})
})
