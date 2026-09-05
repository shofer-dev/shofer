import { render } from "ink-testing-library"

import ScrollIndicator from "../ScrollIndicator.js"

describe("ScrollIndicator", () => {
	it("reports 100% when there is nothing to scroll", () => {
		const { lastFrame } = render(<ScrollIndicator scrollTop={0} maxScroll={0} />)
		expect(lastFrame()).toContain("100%")
	})

	it("reports 0% at the top of a scrollable region", () => {
		const { lastFrame } = render(<ScrollIndicator scrollTop={0} maxScroll={100} />)
		expect(lastFrame()).toContain("0%")
	})

	it("reports the rounded midpoint", () => {
		const { lastFrame } = render(<ScrollIndicator scrollTop={33} maxScroll={100} />)
		expect(lastFrame()).toContain("33%")
	})

	it("reports 100% at the bottom", () => {
		const { lastFrame } = render(<ScrollIndicator scrollTop={100} maxScroll={100} />)
		expect(lastFrame()).toContain("100%")
	})

	it("rounds a fractional percentage", () => {
		const { lastFrame } = render(<ScrollIndicator scrollTop={1} maxScroll={3} />)
		expect(lastFrame()).toContain("33%")
	})

	it("renders the key hints", () => {
		const { lastFrame } = render(<ScrollIndicator scrollTop={0} maxScroll={10} />)
		const output = lastFrame()

		expect(output).toContain("↑↓ scroll")
		expect(output).toContain("Ctrl+E end")
	})

	it("renders unfocused by default", () => {
		const { lastFrame } = render(<ScrollIndicator scrollTop={0} maxScroll={10} />)
		expect(lastFrame()).toContain("0%")
	})

	it("renders in the focused colour when focused", () => {
		const { lastFrame } = render(<ScrollIndicator scrollTop={5} maxScroll={10} isScrollFocused />)
		expect(lastFrame()).toContain("50%")
	})
})
