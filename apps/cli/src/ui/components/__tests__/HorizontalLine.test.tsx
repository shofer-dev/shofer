import { render } from "ink-testing-library"

import { TerminalSizeProvider } from "../../hooks/TerminalSizeContext.js"
import { HorizontalLine } from "../HorizontalLine.js"

describe("HorizontalLine", () => {
	const originalColumns = process.stdout.columns

	afterEach(() => {
		Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true })
	})

	const withWidth = (columns: number) => {
		Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true })
	}

	it("draws a rule as wide as the terminal", () => {
		withWidth(20)

		const { lastFrame } = render(
			<TerminalSizeProvider>
				<HorizontalLine />
			</TerminalSizeProvider>,
		)

		expect(lastFrame()).toBe("─".repeat(20))
	})

	it("draws the active variant", () => {
		withWidth(10)

		const { lastFrame } = render(
			<TerminalSizeProvider>
				<HorizontalLine active />
			</TerminalSizeProvider>,
		)

		expect(lastFrame()).toContain("─".repeat(10))
	})

	it("tracks a narrow terminal", () => {
		withWidth(3)

		const { lastFrame } = render(
			<TerminalSizeProvider>
				<HorizontalLine />
			</TerminalSizeProvider>,
		)

		expect(lastFrame()).toBe("───")
	})
})
