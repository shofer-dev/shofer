// npx vitest src/components/common/__tests__/MarkdownBlock.blobs.spec.tsx
//
// Two things MarkdownBlock does beyond rendering markdown: it resolves the
// `<shofer-blob …/>` reference the host substitutes for an oversized payload
// (one request per unique digest, replaced inline when the answer lands), and
// it routes a fenced block to the right renderer — mermaid, or a code block
// whose language it derives from the fence.

import { render, screen, act, fireEvent, waitFor } from "@/utils/test-utils"

import MarkdownBlock from "../MarkdownBlock"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("../CodeBlock", () => ({
	default: ({ source, language }: { source: string; language: string }) => (
		<pre data-testid="code-block" data-language={language}>
			{source}
		</pre>
	),
}))

vi.mock("../MermaidBlock", () => ({
	default: ({ code, interactive }: { code: string; interactive?: boolean }) => (
		<div data-testid="mermaid-block" data-interactive={String(interactive !== false)}>
			{code}
		</div>
	),
}))

const SHA = "a".repeat(64)
const OTHER = "b".repeat(64)
const ref = (sha: string, bytes = 4096) => `<shofer-blob sha256="${sha}" bytes="${bytes}"/>`

const answer = (sha: string, payload: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "blobContent", blob: { sha256: sha, ...payload } } }),
		)
	})

const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

beforeEach(() => vi.clearAllMocks())

describe("externalised blob references", () => {
	it("asks the host once per digest and shows a placeholder meanwhile", () => {
		render(<MarkdownBlock markdown={`before ${ref(SHA)} between ${ref(SHA)} after`} />)

		expect(posted("getBlobContent")).toEqual([{ type: "getBlobContent", sha256: SHA }])
		expect(screen.getAllByText(/loading…/).length).toBeGreaterThan(0)
	})

	it("asks for each distinct digest", () => {
		render(<MarkdownBlock markdown={`${ref(SHA)} ${ref(OTHER)}`} />)
		expect(posted("getBlobContent")).toHaveLength(2)
	})

	it("substitutes the content once the host answers", async () => {
		render(<MarkdownBlock markdown={`intro ${ref(SHA)}`} />)
		answer(SHA, { content: "the whole payload" })
		await waitFor(() => expect(screen.getByText(/the whole payload/)).toBeInTheDocument())
	})

	it("shows the host's reason when the blob cannot be served", async () => {
		render(<MarkdownBlock markdown={ref(SHA)} />)
		answer(SHA, { error: "evicted" })
		await waitFor(() => expect(screen.getByText(/evicted/)).toBeInTheDocument())
	})

	it("defaults the reason when the host names none", async () => {
		render(<MarkdownBlock markdown={ref(SHA)} />)
		answer(SHA, {})
		await waitFor(() => expect(screen.getByText(/missing/)).toBeInTheDocument())
	})

	it("ignores an answer for a digest it never asked about, and a malformed one", () => {
		render(<MarkdownBlock markdown={ref(SHA)} />)
		answer(OTHER, { content: "not mine" })
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "blobContent" } }))
			window.dispatchEvent(new MessageEvent("message", { data: { type: "somethingElse" } }))
		})
		expect(screen.queryByText(/not mine/)).not.toBeInTheDocument()
	})

	it("asks for nothing when the markdown carries no reference", () => {
		render(<MarkdownBlock markdown="plain prose" />)
		expect(posted("getBlobContent")).toHaveLength(0)
	})

	it("renders nothing rather than throwing for absent markdown", () => {
		expect(() => render(<MarkdownBlock />)).not.toThrow()
	})
})

describe("fenced blocks", () => {
	it("routes a mermaid fence to the diagram renderer", async () => {
		render(<MarkdownBlock markdown={"```mermaid\ngraph TD; a-->b\n```"} />)
		await waitFor(() => expect(screen.getByTestId("mermaid-block")).toBeInTheDocument())
		expect(screen.getByTestId("mermaid-block")).toHaveAttribute("data-interactive", "true")
	})

	it("honours the non-interactive marker and strips it from the diagram", async () => {
		render(<MarkdownBlock markdown={"```mermaid\n%% shofer:noninteractive\ngraph TD; a-->b\n```"} />)
		await waitFor(() => expect(screen.getByTestId("mermaid-block")).toBeInTheDocument())

		const block = screen.getByTestId("mermaid-block")
		expect(block).toHaveAttribute("data-interactive", "false")
		expect(block.textContent).not.toContain("noninteractive")
	})

	it("derives the code block's language from the fence", async () => {
		render(<MarkdownBlock markdown={"```typescript\nconst a = 1\n```"} />)
		await waitFor(() => expect(screen.getByTestId("code-block")).toBeInTheDocument())
		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "typescript")
	})

	it("takes the extension when the fence names a filename", async () => {
		render(<MarkdownBlock markdown={"```src.app.ts\nconst a = 1\n```"} />)
		await waitFor(() => expect(screen.getByTestId("code-block")).toBeInTheDocument())
		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "ts")
	})

	it("falls back to text for an unlabelled fence", async () => {
		render(<MarkdownBlock markdown={"```\nsome output\n```"} />)
		await waitFor(() => expect(screen.getByTestId("code-block")).toBeInTheDocument())
		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "text")
	})
})

describe("links", () => {
	it("asks the host to open a workspace file, with its line number", async () => {
		render(<MarkdownBlock markdown={"[go](src/app.ts:42)"} />)
		const link = await screen.findByText("go")

		fireEvent.click(link)
		expect(posted("openFile")[0]).toMatchObject({ text: "./src/app.ts", values: { line: 42 } })
	})

	it("keeps an absolute path absolute", async () => {
		render(<MarkdownBlock markdown={"[go](/abs/app.ts)"} />)
		fireEvent.click(await screen.findByText("go"))
		expect(posted("openFile")[0]).toMatchObject({ text: "/abs/app.ts", values: undefined })
	})
})
