import * as assert from "assert"

import { ShoferEventName } from "@shofer/types"

import { waitUntilCompleted, cancelCurrentTask } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("Shofer Modes", function () {
	setDefaultSuiteTimeout(this)

	test("Should handle switching modes correctly", async () => {
		const modes: string[] = []

		globalThis.api.on(ShoferEventName.TaskModeSwitched, (_taskId, mode) => modes.push(mode))

		const { taskId: switchModesTaskId } = await globalThis.api.createTask({
			configuration: { mode: "code", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			prompt: "Use the `switch_mode` tool to switch to ask mode.",
		})

		await waitUntilCompleted({ api: globalThis.api, taskId: switchModesTaskId })
		await cancelCurrentTask(globalThis.api)

		assert.ok(modes.includes("ask"))
		assert.ok(modes.length === 1)
	})
})
