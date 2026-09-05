// npx vitest src/components/mcp/__tests__/McpServerConfigEditor.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { McpServer } from "@shofer/types"

import McpServerConfigEditor from "../McpServerConfigEditor"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const server = (config: unknown, over: Partial<McpServer> = {}): McpServer =>
	({
		name: "files",
		status: "connected",
		config: typeof config === "string" ? config : JSON.stringify(config),
		...over,
	}) as McpServer

// Testing-library collapses whitespace in a placeholder, so the multi-line
// placeholders are matched on their attribute value directly.
const field = (placeholder: string) => {
	const el = document.querySelector(`[placeholder^="${placeholder.split("\n")[0]}"]`)
	if (!el) throw new Error(`no field with placeholder starting "${placeholder.split("\n")[0]}"`)
	return el as HTMLInputElement | HTMLTextAreaElement
}
const hasField = (placeholder: string) => !!document.querySelector(`[placeholder^="${placeholder}"]`)
const save = () => fireEvent.click(screen.getByText("mcp:configEditor.save"))

beforeEach(() => vi.clearAllMocks())

describe("McpServerConfigEditor", () => {
	it("infers stdio for a command-based config and shows its fields", () => {
		render(<McpServerConfigEditor server={server({ command: "node", args: ["a.js", "--flag"] })} />)

		expect(screen.getByRole("combobox")).toHaveValue("stdio")
		expect(field("node")).toHaveValue("node")
		expect(field("path/to/server.js\n--flag")).toHaveValue("a.js\n--flag")
	})

	it("infers streamable-http for a url-based config", () => {
		render(<McpServerConfigEditor server={server({ url: "http://x:3000" })} />)
		expect(screen.getByRole("combobox")).toHaveValue("streamable-http")
		expect(field("http://localhost:3000")).toHaveValue("http://x:3000")
	})

	it("honours an explicit transport type over the inference", () => {
		render(<McpServerConfigEditor server={server({ type: "sse", url: "http://x" })} />)
		expect(screen.getByRole("combobox")).toHaveValue("sse")
	})

	it("falls back to an empty stdio form for an unparseable config", () => {
		render(<McpServerConfigEditor server={server("{not json")} />)
		expect(screen.getByRole("combobox")).toHaveValue("stdio")
		expect(field("node")).toHaveValue("")
	})

	it("keeps Save and Reset disabled until something is edited", () => {
		render(<McpServerConfigEditor server={server({ command: "node" })} />)
		expect(screen.getByText("mcp:configEditor.save").closest("button")).toBeDisabled()

		fireEvent.change(field("node"), { target: { value: "bun" } })
		expect(screen.getByText("mcp:configEditor.save").closest("button")).toBeEnabled()
	})

	it("reverts an edit from Reset", () => {
		render(<McpServerConfigEditor server={server({ command: "node" })} />)
		fireEvent.change(field("node"), { target: { value: "bun" } })
		fireEvent.click(screen.getByText("mcp:configEditor.reset"))
		expect(field("node")).toHaveValue("node")
	})

	it("saves a stdio patch, dropping the url-side fields", () => {
		render(<McpServerConfigEditor server={server({ command: "node" }, { source: "project" })} />)

		fireEvent.change(field("node"), { target: { value: "bun" } })
		fireEvent.change(field("path/to/server.js\n--flag"), { target: { value: " a.js \n\n --flag " } })
		fireEvent.change(field("${workspaceFolder}"), { target: { value: "/repo" } })
		fireEvent.change(field("API_KEY=value\nDEBUG=true"), {
			target: { value: "API_KEY=abc\nBARE\n=novalue\nWITH=EQUALS=INSIDE" },
		})
		fireEvent.change(field("./build/server.js"), { target: { value: "./dist/x.js" } })
		save()

		expect(postMessage).toHaveBeenCalledWith({
			type: "updateMcpServerConfig",
			serverName: "files",
			source: "project",
			serverConfig: {
				type: "stdio",
				command: "bun",
				args: ["a.js", "--flag"],
				cwd: "/repo",
				env: { API_KEY: "abc", BARE: "", WITH: "EQUALS=INSIDE" },
				url: undefined,
				headers: undefined,
				watchPaths: ["./dist/x.js"],
			},
		})
	})

	it("saves a url patch, dropping the stdio-side fields", () => {
		render(<McpServerConfigEditor server={server({ url: "http://x" })} />)

		fireEvent.change(field("http://localhost:3000"), { target: { value: "http://y/mcp" } })
		fireEvent.change(field("Authorization=Bearer token"), { target: { value: "Authorization=Bearer t" } })
		save()

		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				serverConfig: expect.objectContaining({
					type: "streamable-http",
					url: "http://y/mcp",
					headers: { Authorization: "Bearer t" },
					command: undefined,
					args: undefined,
					cwd: undefined,
					env: undefined,
				}),
			}),
		)
	})

	it("omits empty collections rather than sending empty ones", () => {
		render(<McpServerConfigEditor server={server({ command: "node", args: ["a"], env: { K: "v" } })} />)

		fireEvent.change(field("path/to/server.js\n--flag"), { target: { value: "   " } })
		fireEvent.change(field("API_KEY=value\nDEBUG=true"), { target: { value: "" } })
		save()

		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				serverConfig: expect.objectContaining({ args: undefined, env: undefined, watchPaths: undefined }),
			}),
		)
	})

	it("switches transport and shows the other form", () => {
		render(<McpServerConfigEditor server={server({ command: "node" })} />)

		fireEvent.change(screen.getByRole("combobox"), { target: { value: "sse" } })
		expect(hasField("node")).toBe(false)
		expect(hasField("http://localhost:3000")).toBe(true)
	})

	it("adopts the config the host re-pushes after a save", () => {
		const { rerender } = render(<McpServerConfigEditor server={server({ command: "node" })} />)
		fireEvent.change(field("node"), { target: { value: "bun" } })

		rerender(<McpServerConfigEditor server={server({ command: "deno" })} />)
		expect(field("node")).toHaveValue("deno")
		expect(screen.getByText("mcp:configEditor.save").closest("button")).toBeDisabled()
	})

	it("treats a non-object env as no entries", () => {
		render(<McpServerConfigEditor server={server({ command: "node", env: "nonsense", args: "nonsense" })} />)
		expect(field("API_KEY=value\nDEBUG=true")).toHaveValue("")
		expect(field("path/to/server.js\n--flag")).toHaveValue("")
	})
})
