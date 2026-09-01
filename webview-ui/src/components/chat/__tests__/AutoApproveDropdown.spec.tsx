import { render, screen, fireEvent } from "@/utils/test-utils"

import { AutoApproveDropdown } from "../AutoApproveDropdown"

const mockSetDynamicToolGroupApproval = vi.fn()
const mockSetAutoApprovalEnabled = vi.fn()

let mockState: Record<string, unknown>

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockState,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/components/ui/hooks/useShoferPortal", () => ({
	useShoferPortal: () => undefined,
}))

// The dropdown's rows live inside a Radix popover. Rendering the primitives as plain
// containers keeps every row in the DOM so the test can assert which categories the
// current mode admits without driving the popover open.
vi.mock("@/components/ui", () => ({
	Popover: ({ children }: any) => <div>{children}</div>,
	PopoverTrigger: ({ children }: any) => <div>{children}</div>,
	PopoverContent: ({ children }: any) => <div>{children}</div>,
	StandardTooltip: ({ children }: any) => <>{children}</>,
	ToggleSwitch: ({ checked, onChange, "aria-label": ariaLabel }: any) => (
		<button role="switch" aria-checked={checked} aria-label={ariaLabel} onClick={onChange} />
	),
	Button: ({ children, onClick, disabled, ...props }: any) => (
		<button onClick={onClick} disabled={disabled} {...props}>
			{children}
		</button>
	),
}))

const baseState = (overrides: Record<string, unknown> = {}) => ({
	autoApprovalEnabled: true,
	setAutoApprovalEnabled: mockSetAutoApprovalEnabled,
	setAlwaysAllowReadOnly: vi.fn(),
	setAlwaysAllowWrite: vi.fn(),
	setAlwaysAllowExecute: vi.fn(),
	setAlwaysAllowMcp: vi.fn(),
	setAlwaysAllowUncategorized: vi.fn(),
	setAlwaysAllowModeSwitch: vi.fn(),
	setAlwaysAllowSubtasks: vi.fn(),
	setAlwaysAllowFollowupQuestions: vi.fn(),
	setDynamicToolGroupApproval: mockSetDynamicToolGroupApproval,
	alwaysAllowReadOnly: false,
	alwaysAllowWrite: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowUncategorized: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowFollowupQuestions: false,
	alwaysAllowGroups: {},
	dynamicToolGroups: ["browser", "salesforce"],
	mode: "code",
	customModes: [
		{ slug: "code", tools: ["read", "write", "browser"] },
		{ slug: "ask", tools: ["read"] },
	],
	...overrides,
})

describe("AutoApproveDropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockState = baseState()
	})

	it("shows a dynamic category the current mode lists", () => {
		render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-group-browser")).toBeInTheDocument()
	})

	it("hides a dynamic category the current mode does not list", () => {
		render(<AutoApproveDropdown />)

		// `salesforce` is registered but no mode names it — declaring a category
		// narrows visibility, and the dropdown must not offer a toggle the mode
		// could never exercise.
		expect(screen.queryByTestId("auto-approve-group-salesforce")).not.toBeInTheDocument()
	})

	it("hides every dynamic category in a mode that lists none", () => {
		mockState = baseState({ mode: "ask" })
		render(<AutoApproveDropdown />)

		expect(screen.queryByTestId("auto-approve-group-browser")).not.toBeInTheDocument()
		expect(screen.getByTestId("auto-approve-alwaysAllowReadOnly")).toBeInTheDocument()
	})

	it("shows every category when the mode is unknown", () => {
		mockState = baseState({ mode: "not-a-mode" })
		render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-group-browser")).toBeInTheDocument()
		expect(screen.getByTestId("auto-approve-group-salesforce")).toBeInTheDocument()
	})

	it("reads a dynamic row's state from alwaysAllowGroups, absent meaning ask", () => {
		mockState = baseState({ alwaysAllowGroups: { browser: true }, mode: "not-a-mode" })
		render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-group-browser")).toHaveAttribute("variant", "primary")
		expect(screen.getByTestId("auto-approve-group-salesforce")).toHaveAttribute("variant", "secondary")
	})

	it("writes a dynamic category through the generic per-entry setter", () => {
		render(<AutoApproveDropdown />)

		fireEvent.click(screen.getByTestId("auto-approve-group-browser"))

		expect(mockSetDynamicToolGroupApproval).toHaveBeenCalledWith("browser", true)
	})

	it("turns a dynamic category off again", () => {
		mockState = baseState({ alwaysAllowGroups: { browser: true } })
		render(<AutoApproveDropdown />)

		fireEvent.click(screen.getByTestId("auto-approve-group-browser"))

		expect(mockSetDynamicToolGroupApproval).toHaveBeenCalledWith("browser", false)
	})

	it("disables a dynamic row while the master gate is off, exactly like a builtin", () => {
		mockState = baseState({ autoApprovalEnabled: false })
		render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-group-browser")).toBeDisabled()
		expect(screen.getByTestId("auto-approve-alwaysAllowReadOnly")).toBeDisabled()

		fireEvent.click(screen.getByTestId("auto-approve-group-browser"))
		expect(mockSetDynamicToolGroupApproval).not.toHaveBeenCalled()
	})

	it("Select All turns on every mode-accessible category, dynamic ones included", () => {
		render(<AutoApproveDropdown />)

		fireEvent.click(screen.getByLabelText("chat:autoApprove.selectAll"))

		expect(mockSetDynamicToolGroupApproval).toHaveBeenCalledWith("browser", true)
		// `salesforce` is filtered out by the mode, so Select All must not reach it.
		expect(mockSetDynamicToolGroupApproval).not.toHaveBeenCalledWith("salesforce", true)
	})

	it("offers no browser builtin toggle any more", () => {
		render(<AutoApproveDropdown />)

		expect(screen.queryByTestId("auto-approve-alwaysAllowBrowser")).not.toBeInTheDocument()
	})
})
