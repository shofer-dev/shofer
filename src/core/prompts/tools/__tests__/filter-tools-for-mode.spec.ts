// npx vitest run core/prompts/tools/__tests__/filter-tools-for-mode.spec.ts

import type OpenAI from "openai"

import { filterNativeToolsForMode } from "../filter-tools-for-mode"

function makeTool(name: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name,
			description: `${name} tool`,
			parameters: { type: "object", properties: {} },
		},
	} as OpenAI.Chat.ChatCompletionTool
}

describe("filterNativeToolsForMode - disabledTools", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("execute_command"),
		makeTool("read_file"),
		makeTool("write_to_file"),
		makeTool("apply_diff"),
		makeTool("edit"),
	]

	it("removes tools listed in settings.disabledTools", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(
			nativeTools,
			"code",
			undefined,
			undefined,
			undefined,
			undefined,
			settings,
		)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is empty", () => {
		const settings = {
			disabledTools: [],
		}

		const result = filterNativeToolsForMode(
			nativeTools,
			"code",
			undefined,
			undefined,
			undefined,
			undefined,
			settings,
		)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is undefined", () => {
		const settings = {}

		const result = filterNativeToolsForMode(
			nativeTools,
			"code",
			undefined,
			undefined,
			undefined,
			undefined,
			settings,
		)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
	})

	it("combines disabledTools with other setting-based exclusions", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(
			nativeTools,
			"code",
			undefined,
			undefined,
			undefined,
			undefined,
			settings,
		)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("execute_command")
		expect(resultNames).toContain("read_file")
	})

	it("disables canonical tool when disabledTools contains alias name", () => {
		const settings = {
			disabledTools: ["search_and_replace"],
			modelInfo: {
				includedTools: ["search_and_replace"],
			},
		}

		const result = filterNativeToolsForMode(
			nativeTools,
			"code",
			undefined,
			undefined,
			undefined,
			undefined,
			settings,
		)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("search_and_replace")
		expect(resultNames).not.toContain("edit")
	})
})

it("includes send_message_to_task in subtasks group for code mode", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("send_message_to_task"),
		makeTool("new_task"),
		makeTool("check_task_status"),
		makeTool("write_to_file"),
	]

	const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, undefined, undefined)

	const resultNames = result.map((t) => (t as any).function.name)
	expect(resultNames).toContain("send_message_to_task")
	expect(resultNames).toContain("new_task")
	expect(resultNames).toContain("check_task_status")
})

it("includes subtasks tools by default (no model exclusions)", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("send_message_to_task"),
		makeTool("new_task"),
		makeTool("check_task_status"),
		makeTool("wait_for_task"),
		makeTool("list_background_tasks"),
		makeTool("cancel_tasks"),
		makeTool("answer_subtask_question"),
	]

	const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, undefined, undefined)

	const resultNames = result.map((t) => (t as any).function.name)
	expect(resultNames).toHaveLength(7)
	expect(resultNames).toContain("send_message_to_task")
	expect(resultNames).toContain("new_task")
})
