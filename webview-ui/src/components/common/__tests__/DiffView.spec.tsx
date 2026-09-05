// npx vitest src/components/common/__tests__/DiffView.spec.tsx

import { render, screen, waitFor } from "@/utils/test-utils"

import DiffView from "../DiffView"

// Shiki is heavy and asynchronous; the highlighting seam is stubbed so the
// assertions are about the diff's STRUCTURE (line numbers, +/- gutters, hunk
// gaps) rather than about token colours.
const highlightHunks = vi.fn(async (oldText: string, newText: string, _lang: string, _theme: string) => ({
	oldLines: oldText.split("\n").map((l) => `OLD:${l}`),
	newLines: newText.split("\n").map((l) => `NEW:${l}`),
}))
vi.mock("@src/utils/highlightDiff", () => ({
	highlightHunks: (...a: Parameters<typeof highlightHunks>) => highlightHunks(...a),
}))

const diff = [
	"--- a/src/app.ts",
	"+++ b/src/app.ts",
	"@@ -1,3 +1,3 @@",
	" const a = 1",
	"-const b = 2",
	"+const b = 3",
	" const c = 4",
	"",
].join("\n")

const rows = (container: HTMLElement) => Array.from(container.querySelectorAll("tbody tr"))

beforeEach(() => {
	vi.clearAllMocks()
	document.body.className = ""
})

describe("DiffView", () => {
	it("renders nothing for an empty source", () => {
		const { container } = render(<DiffView source="" />)
		expect(rows(container)).toHaveLength(0)
	})

	it("renders nothing for a source that is not a patch", () => {
		const { container } = render(<DiffView source="just some text" />)
		expect(rows(container)).toHaveLength(0)
	})

	it("numbers context, deletion and addition lines on the right sides", async () => {
		const { container } = render(<DiffView source={diff} filePath="src/app.ts" />)

		await waitFor(() => expect(highlightHunks).toHaveBeenCalled())
		const cells = rows(container).map((tr) => Array.from(tr.children).map((td) => td.textContent))

		expect(cells).toEqual([
			["1", "1", "", "", "NEW:const a = 1"],
			["2", "", "", "-", "OLD:const b = 2"],
			["", "2", "", "+", "NEW:const b = 3"],
			["3", "3", "", "", "NEW:const c = 4"],
		])
	})

	it("inserts a gap row between distant hunks, counting the hidden lines", async () => {
		const twoHunks = [
			"--- a/f.ts",
			"+++ b/f.ts",
			"@@ -1,1 +1,1 @@",
			"-one",
			"+ONE",
			"@@ -20,1 +20,1 @@",
			"-twenty",
			"+TWENTY",
			"",
		].join("\n")

		render(<DiffView source={twoHunks} />)
		await waitFor(() => expect(highlightHunks).toHaveBeenCalledTimes(2))
		expect(screen.getByText("18 hidden lines")).toBeInTheDocument()
	})

	it("picks the patch matching the requested file when several are present", async () => {
		const twoFiles = [
			"--- a/other.ts",
			"+++ b/other.ts",
			"@@ -1,1 +1,1 @@",
			"-wrong",
			"+WRONG",
			"--- a/src/app.ts",
			"+++ b/src/app.ts",
			"@@ -1,1 +1,1 @@",
			"-right",
			"+RIGHT",
			"",
		].join("\n")

		render(<DiffView source={twoFiles} filePath="src/app.ts" />)
		await waitFor(() => expect(screen.getByText("NEW:RIGHT")).toBeInTheDocument())
		expect(screen.queryByText("NEW:WRONG")).not.toBeInTheDocument()
	})

	it("falls back to the first patch when the requested file is absent", async () => {
		render(<DiffView source={diff} filePath="nowhere.ts" />)
		await waitFor(() => expect(screen.getByText("NEW:const b = 3")).toBeInTheDocument())
	})

	it("leaves a very large diff unhighlighted", () => {
		const body = Array.from({ length: 1200 }, (_, i) => ` line ${i}`).join("\n")
		const big = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,1200 +1,1200 @@", body, ""].join("\n")

		render(<DiffView source={big} />)
		expect(highlightHunks).not.toHaveBeenCalled()
		expect(screen.getByText("line 0")).toBeInTheDocument()
	})

	it("keeps the plain content when highlighting throws", async () => {
		highlightHunks.mockRejectedValueOnce(new Error("shiki exploded"))
		render(<DiffView source={diff} filePath="src/app.ts" />)
		await waitFor(() => expect(screen.getByText("const b = 3")).toBeInTheDocument())
	})

	it("asks for the light theme when the host is on a light colour theme", async () => {
		document.body.className = "vscode-light"
		render(<DiffView source={diff} filePath="src/app.ts" />)
		await waitFor(() => expect(highlightHunks).toHaveBeenCalled())
		expect(highlightHunks.mock.calls[0][3]).toBe("light")
	})

	it("asks for the dark theme otherwise, deriving the language from the path", async () => {
		document.body.className = "vscode-dark"
		render(<DiffView source={diff} filePath="src/app.ts" />)
		await waitFor(() => expect(highlightHunks).toHaveBeenCalled())
		expect(highlightHunks.mock.calls[0][2]).toBe("typescript")
		expect(highlightHunks.mock.calls[0][3]).toBe("dark")
	})

	it("falls back to plain text when the path carries no known extension", async () => {
		render(<DiffView source={diff} />)
		await waitFor(() => expect(highlightHunks).toHaveBeenCalled())
		expect(highlightHunks.mock.calls[0][2]).toBe("txt")
	})
})
