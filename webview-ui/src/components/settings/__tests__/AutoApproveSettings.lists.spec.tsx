// npx vitest src/components/settings/__tests__/AutoApproveSettings.lists.spec.tsx
//
// The four allow/deny lists on the Auto-Approve pane. Every one of them is a
// SAVE-GATED field: adding or removing an entry stages it through
// `setCachedStateField` and never posts to the host, per `webview-ui/AGENTS.md`.

import { render, screen, fireEvent } from "@/utils/test-utils"

import { AutoApproveSettings } from "../AutoApproveSettings"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ customModes: [] }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onInput, onKeyDown, placeholder, "data-testid": testId }: any) => (
		<input
			data-testid={testId}
			placeholder={placeholder}
			value={value ?? ""}
			onChange={(e) => onInput?.(e)}
			onKeyDown={(e) => onKeyDown?.(e)}
		/>
	),
	VSCodeCheckbox: ({ children, checked, onChange, "data-testid": testId }: any) => (
		<label>
			<input data-testid={testId} type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e)} />
			{children}
		</label>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

const setCachedStateField = vi.fn()

const renderPane = (props: Record<string, unknown> = {}) =>
	render(
		<AutoApproveSettings
			autoApprovalEnabled
			alwaysAllowExecute
			alwaysAllowReadOnly
			alwaysAllowWrite
			setCachedStateField={setCachedStateField}
			{...(props as object)}
		/>,
	)

/** Each list is an input + Add button + one chip per entry. */
const list = (
	inputTestId: string,
	addTestId: string,
	field: string,
	existing: string[],
	existingProp: Record<string, unknown>,
) => ({ inputTestId, addTestId, field, existing, existingProp })

const lists = [
	list("command-input", "add-command-button", "allowedCommands", ["npm test"], {
		allowedCommands: ["npm test"],
	}),
	list("denied-command-input", "add-denied-command-button", "deniedCommands", ["rm -rf"], {
		deniedCommands: ["rm -rf"],
	}),
	list("read-path-input", "add-read-path-button", "allowedReadPaths", ["/etc"], {
		allowedReadPaths: ["/etc"],
	}),
	list("write-path-input", "add-write-path-button", "allowedWritePaths", ["/tmp"], {
		allowedWritePaths: ["/tmp"],
	}),
]

beforeEach(() => vi.clearAllMocks())

describe.each(lists)("the $field list", ({ inputTestId, addTestId, field, existing, existingProp }) => {
	it("stages a new entry and clears the input", () => {
		renderPane()
		fireEvent.change(screen.getByTestId(inputTestId), { target: { value: "  a value  " } })
		fireEvent.click(screen.getByTestId(addTestId))

		expect(setCachedStateField).toHaveBeenCalledTimes(1)
		expect(setCachedStateField.mock.calls[0][0]).toBe(field)
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("refuses an empty entry", () => {
		renderPane()
		fireEvent.click(screen.getByTestId(addTestId))
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("refuses a duplicate", () => {
		renderPane(existingProp)
		fireEvent.change(screen.getByTestId(inputTestId), { target: { value: existing[0] } })
		fireEvent.click(screen.getByTestId(addTestId))
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("appends to the entries already staged", () => {
		renderPane(existingProp)
		fireEvent.change(screen.getByTestId(inputTestId), { target: { value: "another" } })
		fireEvent.click(screen.getByTestId(addTestId))
		expect(setCachedStateField.mock.calls[0][1]).toEqual([...existing, "another"])
	})
})

describe("removing an entry", () => {
	it("stages the shortened list for each kind", () => {
		renderPane({
			allowedCommands: ["a", "b"],
			deniedCommands: ["c"],
			allowedReadPaths: ["d"],
			allowedWritePaths: ["e"],
		})

		fireEvent.click(screen.getByTestId("remove-command-1"))
		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["a"])

		fireEvent.click(screen.getByTestId("remove-denied-command-0"))
		expect(setCachedStateField).toHaveBeenCalledWith("deniedCommands", [])

		fireEvent.click(screen.getByTestId("remove-read-path-0"))
		expect(setCachedStateField).toHaveBeenCalledWith("allowedReadPaths", [])

		fireEvent.click(screen.getByTestId("remove-write-path-0"))
		expect(setCachedStateField).toHaveBeenCalledWith("allowedWritePaths", [])

		expect(postMessage).not.toHaveBeenCalled()
	})
})

describe("adding from the keyboard", () => {
	it("commits an allowed command on Enter", () => {
		renderPane()
		const input = screen.getByTestId("command-input")
		fireEvent.change(input, { target: { value: "pnpm build" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["pnpm build"])
	})

	it("ignores any other key", () => {
		renderPane()
		const input = screen.getByTestId("command-input")
		fireEvent.change(input, { target: { value: "pnpm build" } })
		fireEvent.keyDown(input, { key: "a" })
		expect(setCachedStateField).not.toHaveBeenCalled()
	})
})

describe("the scope checkboxes", () => {
	it("stage the out-of-workspace and protected-file scopes", () => {
		renderPane()

		fireEvent.click(screen.getByTestId("always-allow-readonly-outside-workspace-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowReadOnlyOutsideWorkspace", true)

		fireEvent.click(screen.getByTestId("always-allow-write-outside-workspace-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowWriteOutsideWorkspace", true)

		fireEvent.click(screen.getByTestId("always-allow-write-protected-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowWriteProtected", true)

		expect(postMessage).not.toHaveBeenCalled()
	})

	it("hides the read/write scopes when their parent toggle is off", () => {
		render(
			<AutoApproveSettings autoApprovalEnabled setCachedStateField={setCachedStateField} {...({} as object)} />,
		)
		expect(screen.queryByTestId("always-allow-readonly-outside-workspace-checkbox")).not.toBeInTheDocument()
		expect(screen.queryByTestId("always-allow-write-outside-workspace-checkbox")).not.toBeInTheDocument()
	})
})

describe("dynamic tool categories", () => {
	it("are not announced when there are none", () => {
		renderPane()
		expect(screen.queryByTestId("auto-approve-dynamic-section")).not.toBeInTheDocument()
	})

	it("are listed, and one no mode exposes is hinted rather than refused", () => {
		renderPane({ dynamicToolGroups: ["salesforce"], alwaysAllowGroups: {} })
		expect(screen.getByTestId("auto-approve-dynamic-section")).toBeInTheDocument()
		expect(screen.getByTestId("auto-approve-dynamic-hint-salesforce")).toBeInTheDocument()
	})
})

describe("the follow-up auto-approval timeout", () => {
	it("appears only once follow-up questions are auto-approved", () => {
		const { rerender } = renderPane()
		expect(screen.queryByTestId("followup-timeout-slider")).not.toBeInTheDocument()

		rerender(
			<AutoApproveSettings
				autoApprovalEnabled
				alwaysAllowFollowupQuestions
				setCachedStateField={setCachedStateField}
				{...({} as object)}
			/>,
		)
		expect(screen.getByTestId("followup-timeout-slider")).toBeInTheDocument()
	})
})

describe("the list headings", () => {
	it("name all four lists", () => {
		renderPane()
		for (const heading of [
			"allowed-commands-heading",
			"denied-commands-heading",
			"allowed-read-paths-heading",
			"allowed-write-paths-heading",
		]) {
			expect(screen.getByTestId(heading)).toBeInTheDocument()
		}
	})

	it("shows every staged entry as a chip", () => {
		renderPane({ allowedCommands: ["npm test", "pnpm build"] })
		expect(screen.getByTestId("remove-command-0")).toHaveTextContent("npm test")
		expect(screen.getByTestId("remove-command-1")).toHaveTextContent("pnpm build")
	})
})
