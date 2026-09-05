// npx vitest src/components/settings/__tests__/DefaultCostLimitSetting.spec.tsx
//
// The default per-root-task cost cap. It is a `cachedState` field, so every
// control stages through `setCachedStateField` and nothing reaches the host
// until Save — and the row collapses to a single checkbox until a default is
// actually set.

import { render, screen, fireEvent } from "@/utils/test-utils"

import { DefaultCostLimitSetting } from "../DefaultCostLimitSetting"

const postMessage = vi.fn()
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, checked, onChange, "data-testid": testId }: any) => (
		<label>
			<input data-testid={testId} type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e)} />
			{children}
		</label>
	),
	VSCodeTextField: ({ value, onInput, "data-testid": testId }: any) => (
		<input data-testid={testId} value={value ?? ""} onChange={(e) => onInput?.(e)} />
	),
}))

const setCachedStateField = vi.fn()

const renderRow = (defaultCostLimit?: { maxUsd: number; action: "pause" | "abort" | "kill" }) =>
	render(<DefaultCostLimitSetting defaultCostLimit={defaultCostLimit} setCachedStateField={setCachedStateField} />)

beforeEach(() => vi.clearAllMocks())

describe("DefaultCostLimitSetting", () => {
	it("collapses to a single checkbox until a default is set", () => {
		renderRow()
		expect(screen.getByTestId("default-cost-limit-enabled-checkbox")).not.toBeChecked()
		expect(screen.queryByTestId("default-cost-limit-max-usd-input")).not.toBeInTheDocument()
	})

	it("stages a five-dollar pause default when enabled", () => {
		renderRow()
		fireEvent.click(screen.getByTestId("default-cost-limit-enabled-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("defaultCostLimit", { maxUsd: 5, action: "pause" })
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("clears the default when disabled", () => {
		renderRow({ maxUsd: 10, action: "abort" })
		fireEvent.click(screen.getByTestId("default-cost-limit-enabled-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("defaultCostLimit", undefined)
	})

	it("reveals the amount and the action once a default exists", () => {
		renderRow({ maxUsd: 12.5, action: "kill" })
		expect(screen.getByTestId("default-cost-limit-enabled-checkbox")).toBeChecked()
		expect(screen.getByTestId("default-cost-limit-max-usd-input")).toBeInTheDocument()
		expect(screen.getByTestId("default-cost-limit-action-select")).toBeInTheDocument()
	})

	it("stages an edited amount, and refuses a non-positive one", () => {
		renderRow({ maxUsd: 5, action: "pause" })
		const input = screen.getByTestId("default-cost-limit-max-usd-input")

		fireEvent.input(input, { target: { value: "20" } })
		expect(setCachedStateField).toHaveBeenCalledWith("defaultCostLimit", { maxUsd: 20, action: "pause" })

		setCachedStateField.mockClear()
		fireEvent.input(input, { target: { value: "0" } })
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("never posts a setting to the host", () => {
		renderRow({ maxUsd: 5, action: "pause" })
		fireEvent.input(screen.getByTestId("default-cost-limit-max-usd-input"), { target: { value: "9" } })
		expect(postMessage).not.toHaveBeenCalled()
	})
})
