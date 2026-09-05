// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/index.test.ts

import * as hooks from "../index.js"
import * as uiUtils from "../../utils/index.js"

/**
 * The two barrels the UI imports through. A barrel is not ceremony here: it is
 * the module boundary App.tsx binds against, so a hook renamed or dropped without
 * updating it is a runtime `undefined is not a function` at first keystroke
 * rather than a type error.
 */
describe("ui barrels", () => {
	it("re-exports every hook the app consumes", () => {
		expect(Object.keys(hooks).sort()).toEqual(
			[
				"TerminalSizeProvider",
				"useExtensionHost",
				"useFocusManagement",
				"useFollowupCountdown",
				"useGlobalInput",
				"useInputHistory",
				"useMessageHandlers",
				"usePickerHandlers",
				"useTaskSubmit",
				"useTerminalSize",
				"useToast",
				"useToastStore",
			].sort(),
		)

		for (const value of Object.values(hooks)) {
			expect(typeof value).toBe("function")
		}
	})

	it("re-exports the tool and view helpers", () => {
		expect(typeof uiUtils.extractToolData).toBe("function")
		expect(typeof uiUtils.formatToolOutput).toBe("function")
		expect(typeof uiUtils.formatToolAskMessage).toBe("function")
		expect(typeof uiUtils.parseTodosFromToolInfo).toBe("function")
		expect(typeof uiUtils.parseMarkdownChecklist).toBe("function")
		expect(typeof uiUtils.getView).toBe("function")
	})
})
