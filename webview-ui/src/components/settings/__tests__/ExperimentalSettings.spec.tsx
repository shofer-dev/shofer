// pnpm --filter @shofer/vscode-webview test src/components/settings/__tests__/ExperimentalSettings.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import { ExperimentalSettings } from "../ExperimentalSettings"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onInput, placeholder, "data-testid": dataTestId, children }: any) => (
		<div data-testid={dataTestId}>
			{children}
			<input
				type="text"
				value={value}
				onChange={(e: any) => onInput({ target: { value: e.target.value } })}
				placeholder={placeholder}
				data-testid={`${dataTestId}-input`}
			/>
		</div>
	),
	VSCodeCheckbox: ({ children, onChange, checked, "data-testid": dataTestId }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
				aria-label={typeof children === "string" ? children : undefined}
				data-testid={dataTestId}
			/>
			{children}
		</label>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href || "#"}>{children}</a>,
	VSCodeDropdown: ({ children, onChange, value, "data-testid": dataTestId }: any) => (
		<select onChange={onChange} value={value} data-testid={dataTestId}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: any) => <option value={value}>{children}</option>,
}))

vi.mock("@shofer/shared/experiments", () => ({
	EXPERIMENT_IDS: {},
	experimentConfigsMap: {},
}))

describe("ExperimentalSettings — maxParallelTasks", () => {
	const defaultProps = {
		experiments: {},
		setExperimentEnabled: vi.fn(),
		setCachedStateField: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the maxParallelTasks input with label and description", () => {
		render(<ExperimentalSettings {...defaultProps} maxParallelTasks={undefined} />)

		expect(screen.getByTestId("max-parallel-tasks-input")).toBeInTheDocument()
		expect(screen.getByText("settings:advanced.maxParallelTasks.label")).toBeInTheDocument()
		expect(screen.getByText("settings:advanced.maxParallelTasks.description")).toBeInTheDocument()
	})

	it("displays empty value when maxParallelTasks is undefined", () => {
		render(<ExperimentalSettings {...defaultProps} maxParallelTasks={undefined} />)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		expect(input.value).toBe("")
	})

	it("displays empty value when maxParallelTasks is null", () => {
		render(<ExperimentalSettings {...defaultProps} maxParallelTasks={null as any} />)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		expect(input.value).toBe("")
	})

	it("displays the numeric value when maxParallelTasks is set", () => {
		render(<ExperimentalSettings {...defaultProps} maxParallelTasks={5} />)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		expect(input.value).toBe("5")
	})

	it("accepts a valid integer >= 0", () => {
		const setCachedStateField = vi.fn()
		render(
			<ExperimentalSettings
				{...defaultProps}
				maxParallelTasks={undefined}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		fireEvent.change(input, { target: { value: "10" } })

		expect(setCachedStateField).toHaveBeenCalledWith("maxParallelTasks", 10)
	})

	it("accepts 0 (unlimited)", () => {
		const setCachedStateField = vi.fn()
		render(
			<ExperimentalSettings
				{...defaultProps}
				maxParallelTasks={undefined}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		fireEvent.change(input, { target: { value: "0" } })

		expect(setCachedStateField).toHaveBeenCalledWith("maxParallelTasks", 0)
	})

	it("calls setCachedStateField with null on empty input", () => {
		const setCachedStateField = vi.fn()
		render(
			<ExperimentalSettings {...defaultProps} maxParallelTasks={5} setCachedStateField={setCachedStateField} />,
		)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		fireEvent.change(input, { target: { value: "" } })

		expect(setCachedStateField).toHaveBeenCalledWith("maxParallelTasks", null)
	})

	it("rejects non-integer values", () => {
		const setCachedStateField = vi.fn()
		render(
			<ExperimentalSettings
				{...defaultProps}
				maxParallelTasks={undefined}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		fireEvent.change(input, { target: { value: "3.5" } })

		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("rejects negative values", () => {
		const setCachedStateField = vi.fn()
		render(
			<ExperimentalSettings
				{...defaultProps}
				maxParallelTasks={undefined}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		fireEvent.change(input, { target: { value: "-1" } })

		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("rejects non-numeric text", () => {
		const setCachedStateField = vi.fn()
		render(
			<ExperimentalSettings
				{...defaultProps}
				maxParallelTasks={undefined}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		fireEvent.change(input, { target: { value: "abc" } })

		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("shows the placeholder text", () => {
		render(<ExperimentalSettings {...defaultProps} maxParallelTasks={undefined} />)

		const input = screen.getByTestId("max-parallel-tasks-input-input") as HTMLInputElement
		expect(input.placeholder).toBe("settings:advanced.maxParallelTasks.placeholder")
	})
})
