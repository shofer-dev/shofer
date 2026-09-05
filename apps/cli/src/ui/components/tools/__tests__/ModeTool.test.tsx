import { render } from "ink-testing-library"

import { resetNerdFontCache } from "../../Icon.js"
import { ModeTool } from "../ModeTool.js"

describe("ModeTool", () => {
	beforeEach(() => {
		process.env.SHOFER_NERD_FONT = "0"
		resetNerdFontCache()
	})

	afterEach(() => {
		delete process.env.SHOFER_NERD_FONT
		resetNerdFontCache()
	})

	it("renders the switch sentence for switch_mode", () => {
		const { lastFrame } = render(<ModeTool toolData={{ tool: "switch_mode", mode: "architect" }} />)
		const output = lastFrame()

		expect(output).toContain("Switching to")
		expect(output).toContain("architect")
		expect(output).toContain("mode")
	})

	it("renders the switch sentence for the camelCase switchMode", () => {
		const { lastFrame } = render(<ModeTool toolData={{ tool: "switchMode", mode: "code" }} />)
		expect(lastFrame()).toContain("Switching to")
	})

	it("omits the sentence when the mode is missing", () => {
		const { lastFrame } = render(<ModeTool toolData={{ tool: "switch_mode" }} />)
		expect(lastFrame()).not.toContain("Switching to")
	})

	it("omits the sentence for a non-switch mode tool", () => {
		const { lastFrame } = render(<ModeTool toolData={{ tool: "new_task", mode: "code" }} />)
		expect(lastFrame()).not.toContain("Switching to")
	})

	it("still renders the icon row for a non-switch tool", () => {
		const { lastFrame } = render(<ModeTool toolData={{ tool: "finishTask" }} />)
		// finishTask maps to the "check" icon, whose ASCII fallback is a check mark.
		expect(lastFrame()).toContain("✓")
	})
})
