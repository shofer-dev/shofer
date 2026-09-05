import { render } from "ink-testing-library"

import type { TokenUsage } from "@shofer/types"

import MetricsDisplay, { formatNumber, formatCost } from "../MetricsDisplay.js"

const usage = (over: Partial<TokenUsage> = {}): TokenUsage =>
	({
		totalCost: 0,
		totalTokensIn: 0,
		totalTokensOut: 0,
		contextTokens: 0,
		...over,
	}) as TokenUsage

describe("MetricsDisplay", () => {
	describe("formatNumber", () => {
		it("leaves values under a thousand alone", () => {
			expect(formatNumber(0)).toBe("0")
			expect(formatNumber(500)).toBe("500")
			expect(formatNumber(999)).toBe("999")
		})

		it("uses the K suffix from a thousand up", () => {
			expect(formatNumber(1_000)).toBe("1.0K")
			expect(formatNumber(1_234)).toBe("1.2K")
			expect(formatNumber(999_999)).toBe("1000.0K")
		})

		it("uses the M suffix from a million up", () => {
			expect(formatNumber(1_000_000)).toBe("1.0M")
			expect(formatNumber(1_234_567)).toBe("1.2M")
		})
	})

	describe("formatCost", () => {
		it("renders two decimal places with a dollar prefix", () => {
			expect(formatCost(0.12345)).toBe("$0.12")
			expect(formatCost(1.5)).toBe("$1.50")
			expect(formatCost(0)).toBe("$0.00")
		})
	})

	describe("rendering", () => {
		it("renders cost, input, output and the context bar", () => {
			const { lastFrame } = render(
				<MetricsDisplay
					tokenUsage={usage({
						totalCost: 0.1234,
						totalTokensIn: 45_200,
						totalTokensOut: 8_700,
						contextTokens: 50_000,
					})}
					contextWindow={100_000}
				/>,
			)
			const output = lastFrame()

			expect(output).toContain("$0.12")
			expect(output).toContain("45.2K")
			expect(output).toContain("8.7K")
			expect(output).toContain("50%")
			expect(output).toContain("↓")
			expect(output).toContain("↑")
		})

		it("renders zeroed usage", () => {
			const { lastFrame } = render(<MetricsDisplay tokenUsage={usage()} contextWindow={100_000} />)
			const output = lastFrame()

			expect(output).toContain("$0.00")
			expect(output).toContain("0%")
		})
	})
})
