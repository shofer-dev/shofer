// npx vitest src/components/settings/__tests__/CustomToolsSettings.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { CustomToolsSettings } from "../CustomToolsSettings"

const postMessage = vi.fn()
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e)} />
			{children}
		</label>
	),
}))

const onChange = vi.fn()

const answer = (payload: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "customToolsResult", ...payload } }))
	})

beforeEach(() => vi.clearAllMocks())

describe("CustomToolsSettings", () => {
	it("shows only the toggle while the experiment is off", () => {
		render(<CustomToolsSettings enabled={false} onChange={onChange} />)
		expect(screen.getByText("settings:experimental.CUSTOM_TOOLS.name")).toBeInTheDocument()
		expect(screen.queryByText("settings:experimental.CUSTOM_TOOLS.toolsHeader")).not.toBeInTheDocument()
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("stages the toggle rather than applying it", () => {
		render(<CustomToolsSettings enabled={false} onChange={onChange} />)
		fireEvent.click(screen.getByRole("checkbox"))
		expect(onChange).toHaveBeenCalledWith(true)
	})

	it("asks the host for the tool list as soon as it is enabled", () => {
		render(<CustomToolsSettings enabled onChange={onChange} />)
		expect(postMessage).toHaveBeenCalledWith({ type: "refreshCustomTools" })
		expect(screen.getByText("settings:experimental.CUSTOM_TOOLS.noTools")).toBeInTheDocument()
	})

	it("drops the list when the experiment is switched back off", () => {
		const { rerender } = render(<CustomToolsSettings enabled onChange={onChange} />)
		answer({ tools: [{ name: "lint", description: "runs the linter" }] })
		expect(screen.getByText("lint")).toBeInTheDocument()

		rerender(<CustomToolsSettings enabled={false} onChange={onChange} />)
		expect(screen.queryByText("lint")).not.toBeInTheDocument()
	})

	it("renders a tool with its source and its parameters", () => {
		render(<CustomToolsSettings enabled onChange={onChange} />)
		answer({
			tools: [
				{
					name: "lint",
					description: "runs the linter",
					source: ".shofer/tools/lint.ts",
					parameters: {
						properties: {
							path: { type: "string", description: "what to lint" },
							fix: {},
						},
						required: ["path"],
					},
				},
			],
		})

		expect(screen.getByText("lint")).toBeInTheDocument()
		expect(screen.getByText(".shofer/tools/lint.ts")).toBeInTheDocument()
		expect(screen.getByText("runs the linter")).toBeInTheDocument()
		expect(screen.getByText("path")).toBeInTheDocument()
		expect(screen.getByText("(string)")).toBeInTheDocument()
		expect(screen.getByText("required")).toBeInTheDocument()
		expect(screen.getByText("— what to lint")).toBeInTheDocument()
		// A parameter with no declared type falls back to `any`.
		expect(screen.getByText("(any)")).toBeInTheDocument()
	})

	it("renders a tool with no parameters and no source", () => {
		render(<CustomToolsSettings enabled onChange={onChange} />)
		answer({ tools: [{ name: "ping", description: "pings" }] })
		expect(screen.getByText("ping")).toBeInTheDocument()
		expect(screen.queryByText("settings:experimental.CUSTOM_TOOLS.toolParameters:")).not.toBeInTheDocument()
	})

	it("refreshes on demand, showing the in-flight state until the host answers", () => {
		render(<CustomToolsSettings enabled onChange={onChange} />)
		postMessage.mockClear()

		fireEvent.click(screen.getByText("settings:experimental.CUSTOM_TOOLS.refreshButton"))
		expect(postMessage).toHaveBeenCalledWith({ type: "refreshCustomTools" })
		expect(screen.getByText("settings:experimental.CUSTOM_TOOLS.refreshing")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.CUSTOM_TOOLS.refreshing").closest("button")).toBeDisabled()

		answer({ tools: [] })
		expect(screen.getByText("settings:experimental.CUSTOM_TOOLS.refreshButton")).toBeInTheDocument()
	})

	it("surfaces a discovery failure the host reports", () => {
		render(<CustomToolsSettings enabled onChange={onChange} />)
		answer({ tools: [], error: "provider not activated" })
		expect(screen.getByText(/provider not activated/)).toBeInTheDocument()
	})

	it("clears a previous failure on the next refresh", () => {
		render(<CustomToolsSettings enabled onChange={onChange} />)
		answer({ tools: [], error: "boom" })
		fireEvent.click(screen.getByText("settings:experimental.CUSTOM_TOOLS.refreshButton"))
		expect(screen.queryByText(/boom/)).not.toBeInTheDocument()
	})
})
