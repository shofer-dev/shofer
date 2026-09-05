import { render } from "ink-testing-library"

import LoadingText from "../LoadingText.js"

/**
 * `LoadingText` picks a random phrase from a fixed table when it is given no
 * children (or the literal "Thinking"), so the tests pin `Math.random` rather
 * than asserting on whichever phrase happened to come out.
 */
describe("LoadingText", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses the first phrase in the table when random lands at zero", () => {
		vi.spyOn(Math, "random").mockReturnValue(0)

		const { lastFrame } = render(<LoadingText />)
		expect(lastFrame()).toContain("Thinking...")
	})

	it("uses the last phrase in the table when random lands just under one", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.9999)

		const { lastFrame } = render(<LoadingText />)
		expect(lastFrame()).toContain("Cogitating...")
	})

	it("substitutes a random phrase for the literal 'Thinking' child", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.9999)

		const { lastFrame } = render(<LoadingText>Thinking</LoadingText>)
		expect(lastFrame()).toContain("Cogitating...")
	})

	it("keeps a custom label verbatim", () => {
		const { lastFrame } = render(<LoadingText>Compiling</LoadingText>)
		expect(lastFrame()).toContain("Compiling...")
	})

	it("stringifies a non-string child", () => {
		const { lastFrame } = render(<LoadingText>{42}</LoadingText>)
		expect(lastFrame()).toContain("42...")
	})

	it("falls back to a random phrase for an empty-string child", () => {
		vi.spyOn(Math, "random").mockReturnValue(0)

		const { lastFrame } = render(<LoadingText>{""}</LoadingText>)
		expect(lastFrame()).toContain("Thinking...")
	})
})
