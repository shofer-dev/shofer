import { render, screen, fireEvent } from "@/utils/test-utils"

import { AutoApproveSettings } from "../AutoApproveSettings"
import { dynamicToggleTestId } from "../AutoApproveToggle"

let mockState: Record<string, unknown>

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockState,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockState,
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey }: any) => <span>{i18nKey}</span>,
	useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const baseState = (overrides: Record<string, unknown> = {}) => ({
	alwaysAllowReadOnly: false,
	alwaysAllowWrite: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowUncategorized: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowFollowupQuestions: false,
	alwaysAllowGroups: {},
	customModes: [{ slug: "code", tools: ["read", "write", "browser"] }],
	...overrides,
})

describe("AutoApproveSettings — custom categories", () => {
	const setCachedStateField = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		mockState = baseState()
	})

	const renderSettings = (props: Record<string, unknown> = {}) =>
		render(
			<AutoApproveSettings
				autoApprovalEnabled={true}
				alwaysAllowGroups={(mockState.alwaysAllowGroups as Record<string, boolean>) ?? {}}
				dynamicToolGroups={["browser", "salesforce"]}
				setCachedStateField={setCachedStateField as any}
				{...props}
			/>,
		)

	it("renders one row per registered dynamic category, after the builtins", () => {
		renderSettings()

		expect(screen.getByTestId("auto-approve-dynamic-section")).toBeInTheDocument()
		expect(screen.getByTestId(dynamicToggleTestId("browser"))).toBeInTheDocument()
		expect(screen.getByTestId(dynamicToggleTestId("salesforce"))).toBeInTheDocument()
	})

	it("renders no block at all when nothing has registered a category", () => {
		renderSettings({ dynamicToolGroups: [] })

		expect(screen.queryByTestId("auto-approve-dynamic-section")).not.toBeInTheDocument()
	})

	it("stages the edited map into cachedState rather than posting on change", () => {
		mockState = baseState({ alwaysAllowGroups: { browser: true } })
		renderSettings()

		fireEvent.click(screen.getByTestId(dynamicToggleTestId("salesforce")))

		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowGroups", {
			browser: true,
			salesforce: true,
		})
	})

	it("hints that a category no mode lists exposes no tools", () => {
		renderSettings()

		// `code` lists `browser`, so only `salesforce` is unreachable.
		expect(screen.getByTestId("auto-approve-dynamic-hint-salesforce")).toBeInTheDocument()
		expect(screen.queryByTestId("auto-approve-dynamic-hint-browser")).not.toBeInTheDocument()
	})

	it("hints for every category once no mode lists any of them", () => {
		mockState = baseState({ customModes: [{ slug: "code", tools: ["read"] }] })
		renderSettings()

		expect(screen.getByTestId("auto-approve-dynamic-hint-browser")).toBeInTheDocument()
		expect(screen.getByTestId("auto-approve-dynamic-hint-salesforce")).toBeInTheDocument()
	})

	it("offers no browser builtin toggle any more", () => {
		renderSettings()

		expect(screen.queryByTestId("always-allow-browser-toggle")).not.toBeInTheDocument()
	})
})
