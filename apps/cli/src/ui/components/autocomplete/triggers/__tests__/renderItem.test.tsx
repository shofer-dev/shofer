import { render } from "ink-testing-library"

import { createFileTrigger, type FileResult } from "../FileTrigger.js"
import { createSlashCommandTrigger, type SlashCommandResult } from "../SlashCommandTrigger.js"
import { createModeTrigger, type ModeResult } from "../ModeTrigger.js"
import { createHistoryTrigger, type HistoryResult } from "../HistoryTrigger.js"
import { createHelpTrigger } from "../HelpTrigger.js"

/**
 * The triggers' `renderItem` output and the few filtering branches the
 * behaviour-focused sibling suites do not reach.
 */
describe("trigger renderItem", () => {
	describe("SlashCommandTrigger", () => {
		const command = (over: Partial<SlashCommandResult> = {}): SlashCommandResult => ({
			key: "help",
			name: "help",
			source: "built-in",
			...over,
		})

		const trigger = createSlashCommandTrigger({ getCommands: () => [] })

		it("renders the command name with a leading slash", () => {
			const { lastFrame } = render(<>{trigger.renderItem(command(), false)}</>)
			expect(lastFrame()).toContain("/help")
		})

		it("renders the description when present", () => {
			const { lastFrame } = render(<>{trigger.renderItem(command({ description: "Show help" }), false)}</>)
			expect(lastFrame()).toContain("Show help")
		})

		it("omits the description separator when absent", () => {
			const { lastFrame } = render(<>{trigger.renderItem(command(), false)}</>)
			expect(lastFrame()).not.toContain(" - ")
		})

		it("marks an action command with the gear icon", () => {
			const { lastFrame } = render(<>{trigger.renderItem(command({ action: "clearTask" }), false)}</>)
			expect(lastFrame()).toContain("⚙")
		})

		it("marks a built-in command with the bolt icon", () => {
			const { lastFrame } = render(<>{trigger.renderItem(command({ source: "built-in" }), false)}</>)
			expect(lastFrame()).toContain("⚡")
		})

		it("marks a project command with the folder icon", () => {
			const { lastFrame } = render(<>{trigger.renderItem(command({ source: "project" }), false)}</>)
			expect(lastFrame()).toContain("📁")
		})

		it("marks a global command with the globe icon", () => {
			const { lastFrame } = render(<>{trigger.renderItem(command({ source: "global" }), false)}</>)
			expect(lastFrame()).toContain("🌐")
		})

		it("renders a selected item", () => {
			const { lastFrame } = render(<>{trigger.renderItem(command(), true)}</>)
			expect(lastFrame()).toContain("/help")
		})

		it("substitutes the command into the line", () => {
			expect(trigger.getReplacementText(command({ name: "new" }), "  /ne", 2)).toBe("  /new ")
		})
	})

	describe("ModeTrigger", () => {
		const mode = (over: Partial<ModeResult> = {}): ModeResult => ({
			key: "code",
			slug: "code",
			name: "Code",
			...over,
		})

		const trigger = createModeTrigger({ getModes: () => [] })

		it("renders the mode name", () => {
			const { lastFrame } = render(<>{trigger.renderItem(mode(), false)}</>)
			expect(lastFrame()).toContain("Code")
		})

		it("renders the description when present", () => {
			const { lastFrame } = render(<>{trigger.renderItem(mode({ description: "Write code" }), false)}</>)
			expect(lastFrame()).toContain("Write code")
		})

		it("omits the description separator when absent", () => {
			const { lastFrame } = render(<>{trigger.renderItem(mode(), false)}</>)
			expect(lastFrame()).not.toContain(" - ")
		})

		it("renders a selected item", () => {
			const { lastFrame } = render(<>{trigger.renderItem(mode(), true)}</>)
			expect(lastFrame()).toContain("Code")
		})

		it("clears the line on selection, since the switch travels as a message", () => {
			expect(trigger.getReplacementText(mode(), "!co", 0)).toBe("")
		})
	})

	describe("FileTrigger", () => {
		const file = (path: string): FileResult => ({ key: path, path, type: "file" })

		it("returns the results untouched for an empty query", () => {
			const results = [file("b.ts"), file("a.ts")]
			const trigger = createFileTrigger({ onSearch: () => {}, getResults: () => results })

			expect(trigger.refreshResults?.("")).toEqual(results)
		})

		it("returns an empty result set untouched rather than fuzzy-sorting it", () => {
			const trigger = createFileTrigger({ onSearch: () => {}, getResults: () => [] })

			expect(trigger.refreshResults?.("query")).toEqual([])
		})

		it("fuzzy-sorts a non-empty result set", () => {
			const results = [file("src/zebra.ts"), file("src/alpha.ts")]
			const trigger = createFileTrigger({ onSearch: () => {}, getResults: () => results })

			const sorted = trigger.refreshResults?.("alpha") as FileResult[]
			expect(sorted[0]?.path).toBe("src/alpha.ts")
		})
	})

	describe("HistoryTrigger relative times", () => {
		const trigger = createHistoryTrigger({ getHistory: () => [] })

		const at = (msAgo: number): HistoryResult => ({
			key: "t1",
			id: "t1",
			task: "a task",
			ts: Date.now() - msAgo,
		})

		it("renders minutes for a recent entry", () => {
			const { lastFrame } = render(<>{trigger.renderItem(at(5 * 60_000), false)}</>)
			expect(lastFrame()).toContain("5 mins ago")
		})

		it("renders the singular minute", () => {
			const { lastFrame } = render(<>{trigger.renderItem(at(60_000), false)}</>)
			expect(lastFrame()).toContain("1 min ago")
		})

		it("renders just now for a fresh entry", () => {
			const { lastFrame } = render(<>{trigger.renderItem(at(1_000), false)}</>)
			expect(lastFrame()).toContain("just now")
		})
	})

	describe("HelpTrigger", () => {
		it("renders its shortcut rows", async () => {
			const trigger = createHelpTrigger()
			const results = await trigger.search("")
			const first = results[0]

			expect(first).toBeDefined()
			const { lastFrame } = render(<>{trigger.renderItem(first!, true)}</>)
			expect(lastFrame()).toBeTruthy()
		})
	})
})
