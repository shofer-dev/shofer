import * as assert from "assert"

import { ShoferEventName, type ShoferMessage } from "@shofer/types"

import { waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("Shofer Task", function () {
	setDefaultSuiteTimeout(this)

	test("Should handle prompt and response correctly", async () => {
		const api = globalThis.api

		const messages: ShoferMessage[] = []

		api.on(ShoferEventName.Message, ({ message }) => {
			if (message.type === "say" && message.partial === false) {
				messages.push(message)
			}
		})

		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "Hello world, what is your name? Respond with 'My name is ...'",
		})

		await waitUntilCompleted({ api, taskId })

		assert.ok(
			!!messages.find(
				({ say, text }) =>
					(say === "completion_result" || say === "text") && text?.includes("My name is Shofer"),
			),
			`Completion should include "My name is Shofer"`,
		)
	})
})
