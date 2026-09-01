import { render, screen, fireEvent } from "@/utils/test-utils"

import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"

import { toolGroups } from "@shofer/types"

import {
	AutoApproveToggle,
	AutoApproveDynamicToggles,
	autoApproveSettingsConfig,
	dynamicToggleTestId,
} from "../AutoApproveToggle"

vi.mock("@/i18n/TranslationContext", () => {
	const actual = vi.importActual("@/i18n/TranslationContext")
	return {
		...actual,
		useAppTranslation: () => ({
			t: (key: string) => key,
		}),
	}
})

describe("AutoApproveToggle", () => {
	const mockOnToggle = vi.fn()
	const initialProps = {
		alwaysAllowReadOnly: true,
		alwaysAllowWrite: false,
		alwaysAllowMcp: false,
		alwaysAllowUncategorized: false,
		alwaysAllowModeSwitch: true,
		alwaysAllowSubtasks: false,
		alwaysAllowExecute: true,
		alwaysAllowFollowupQuestions: false,
		onToggle: mockOnToggle,
	}

	beforeEach(() => {
		mockOnToggle.mockClear()
	})

	test("renders all toggle buttons with correct initial ARIA attributes", () => {
		render(
			<TranslationProvider>
				<AutoApproveToggle {...initialProps} />
			</TranslationProvider>,
		)

		Object.values(autoApproveSettingsConfig).forEach((config) => {
			const button = screen.getByTestId(config.testId)
			expect(button).toBeInTheDocument()
			expect(button).toHaveAttribute("aria-label", config.labelKey)
			expect(button).toHaveAttribute("aria-pressed", String(initialProps[config.key]))
		})
	})

	test("calls onToggle with the correct key and value when a button is clicked", () => {
		render(
			<TranslationProvider>
				<AutoApproveToggle {...initialProps} />
			</TranslationProvider>,
		)

		const writeToggleButton = screen.getByTestId(autoApproveSettingsConfig.alwaysAllowWrite.testId)
		fireEvent.click(writeToggleButton)

		expect(mockOnToggle).toHaveBeenCalledTimes(1)
		expect(mockOnToggle).toHaveBeenCalledWith("alwaysAllowWrite", true)

		const readOnlyButton = screen.getByTestId(autoApproveSettingsConfig.alwaysAllowReadOnly.testId)
		fireEvent.click(readOnlyButton)
		expect(mockOnToggle).toHaveBeenCalledTimes(2)
		expect(mockOnToggle).toHaveBeenCalledWith("alwaysAllowReadOnly", false)
	})

	test("updates aria-pressed attribute after toggle", () => {
		const { rerender } = render(
			<TranslationProvider>
				<AutoApproveToggle {...initialProps} />
			</TranslationProvider>,
		)

		const writeToggleButton = screen.getByTestId(autoApproveSettingsConfig.alwaysAllowWrite.testId)
		expect(writeToggleButton).toHaveAttribute("aria-pressed", "false")

		const updatedProps = { ...initialProps, alwaysAllowWrite: true }
		rerender(
			<TranslationProvider>
				<AutoApproveToggle {...updatedProps} />
			</TranslationProvider>,
		)

		expect(screen.getByTestId(autoApproveSettingsConfig.alwaysAllowWrite.testId)).toHaveAttribute(
			"aria-pressed",
			"true",
		)
	})

	test("covers exactly the eight builtin categories, and browser is not one of them", () => {
		const configured = Object.values(autoApproveSettingsConfig).map((config) => config.toolGroup)

		expect(new Set(configured)).toEqual(new Set(toolGroups))
		expect(configured).not.toContain("browser")
	})
})

describe("AutoApproveDynamicToggles", () => {
	const mockOnToggle = vi.fn()

	beforeEach(() => {
		mockOnToggle.mockClear()
	})

	const renderToggles = (props: Partial<React.ComponentProps<typeof AutoApproveDynamicToggles>> = {}) =>
		render(
			<TranslationProvider>
				<AutoApproveDynamicToggles
					names={["browser", "salesforce"]}
					alwaysAllowGroups={{ browser: true }}
					onToggle={mockOnToggle}
					{...props}
				/>
			</TranslationProvider>,
		)

	test("renders one row per registered dynamic category", () => {
		renderToggles()

		expect(screen.getByTestId(dynamicToggleTestId("browser"))).toBeInTheDocument()
		expect(screen.getByTestId(dynamicToggleTestId("salesforce"))).toBeInTheDocument()
	})

	test("reads each row's state from alwaysAllowGroups, absent meaning ask", () => {
		renderToggles()

		expect(screen.getByTestId(dynamicToggleTestId("browser"))).toHaveAttribute("aria-pressed", "true")
		// `salesforce` has no entry at all — fail-closed, same as an explicit false.
		expect(screen.getByTestId(dynamicToggleTestId("salesforce"))).toHaveAttribute("aria-pressed", "false")
	})

	test("an explicit false is off", () => {
		renderToggles({ alwaysAllowGroups: { salesforce: false } })

		expect(screen.getByTestId(dynamicToggleTestId("salesforce"))).toHaveAttribute("aria-pressed", "false")
	})

	test("toggling reports the category name and the new value", () => {
		renderToggles()

		fireEvent.click(screen.getByTestId(dynamicToggleTestId("salesforce")))
		expect(mockOnToggle).toHaveBeenCalledWith("salesforce", true)

		fireEvent.click(screen.getByTestId(dynamicToggleTestId("browser")))
		expect(mockOnToggle).toHaveBeenCalledWith("browser", false)
	})

	test("renders nothing when no dynamic category is registered", () => {
		renderToggles({ names: [] })

		expect(screen.queryByTestId(dynamicToggleTestId("browser"))).not.toBeInTheDocument()
	})

	test("labels are templated with the category name rather than hand-keyed", () => {
		renderToggles({ names: ["salesforce"] })

		// The mock translator echoes the key, so a per-category key would surface here.
		expect(screen.getByTestId(dynamicToggleTestId("salesforce"))).toHaveAttribute(
			"aria-label",
			"settings:autoApprove.dynamic.label",
		)
	})
})
