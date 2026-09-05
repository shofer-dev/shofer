import { render } from "ink-testing-library"

import ProgressBar from "../ProgressBar.js"

describe("ProgressBar", () => {
	it("renders an empty bar at zero", () => {
		const { lastFrame } = render(<ProgressBar value={0} max={100} width={10} />)
		const output = lastFrame()

		expect(output).toContain("0%")
		expect(output).toContain("░".repeat(10))
		expect(output).not.toContain("█")
	})

	it("renders a full bar at the maximum", () => {
		const { lastFrame } = render(<ProgressBar value={100} max={100} width={10} />)
		const output = lastFrame()

		expect(output).toContain("100%")
		expect(output).toContain("█".repeat(10))
	})

	it("renders a half bar at 50%", () => {
		const { lastFrame } = render(<ProgressBar value={50} max={100} width={10} />)
		const output = lastFrame()

		expect(output).toContain("50%")
		expect(output).toContain("█".repeat(5))
		expect(output).toContain("░".repeat(5))
	})

	it("clamps a value above the maximum to 100%", () => {
		const { lastFrame } = render(<ProgressBar value={500} max={100} width={8} />)
		expect(lastFrame()).toContain("100%")
	})

	it("clamps a negative value to 0%", () => {
		const { lastFrame } = render(<ProgressBar value={-20} max={100} width={8} />)
		expect(lastFrame()).toContain("0%")
	})

	it("reports 0% when the maximum is zero", () => {
		const { lastFrame } = render(<ProgressBar value={10} max={0} width={8} />)
		expect(lastFrame()).toContain("0%")
	})

	it("reports 0% when the maximum is negative", () => {
		const { lastFrame } = render(<ProgressBar value={10} max={-5} width={8} />)
		expect(lastFrame()).toContain("0%")
	})

	it("defaults to a width of 16 characters", () => {
		const { lastFrame } = render(<ProgressBar value={100} max={100} />)
		expect(lastFrame()).toContain("█".repeat(16))
	})

	it("renders the warning band between 50% and 75%", () => {
		const { lastFrame } = render(<ProgressBar value={60} max={100} width={10} />)
		expect(lastFrame()).toContain("60%")
	})

	it("renders the danger band above 75%", () => {
		const { lastFrame } = render(<ProgressBar value={90} max={100} width={10} />)
		expect(lastFrame()).toContain("90%")
	})

	it("renders the boundary at exactly 75%", () => {
		const { lastFrame } = render(<ProgressBar value={75} max={100} width={12} />)
		expect(lastFrame()).toContain("75%")
	})
})
