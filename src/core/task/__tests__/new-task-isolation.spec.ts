/**
 * Tests for new_task tool isolation enforcement.
 *
 * These tests verify the runtime enforcement that prevents tools from executing
 * after `new_task` in parallel tool calls. When `new_task` is called alongside
 * other tools, any tools that come after it in the assistant message are truncated
 * and their tool_results are pre-injected with error messages.
 *
 * Multiple new_task calls in one message:
 * - All with is_background=true  → allowed (fan-out pattern)
 * - Any without is_background    → ALL new_task calls rejected, preventing an
 *   orphaned sync child from being created before the LLM retries correctly
 *
 * This prevents orphaned tools when delegation disposes the parent task.
 */

import type { Anthropic } from "@anthropic-ai/sdk"

describe("new_task Tool Isolation Enforcement", () => {
	/**
	 * Simulates the new_task isolation enforcement logic from Task.ts.
	 * This tests the truncation and error injection that happens when building
	 * assistant message content for the API.
	 */
	const enforceNewTaskIsolation = (
		assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam>,
	): {
		truncatedContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam>
		injectedToolResults: Anthropic.ToolResultBlockParam[]
	} => {
		const injectedToolResults: Anthropic.ToolResultBlockParam[] = []

		const newTaskBlocks = assistantContent.filter(
			(block): block is Anthropic.ToolUseBlockParam =>
				block.type === "tool_use" && (block as Anthropic.ToolUseBlockParam).name === "new_task",
		)

		if (newTaskBlocks.length > 1) {
			const allBackground = newTaskBlocks.every(
				(block) => (block.input as Record<string, unknown>)?.is_background === true,
			)

			if (!allBackground) {
				// Reject ALL new_task calls — the first one would otherwise create an
				// unintended sync child before the LLM retries with is_background.
				for (const block of newTaskBlocks) {
					if (block.id) {
						injectedToolResults.push({
							type: "tool_result",
							tool_use_id: block.id,
							content:
								"This new_task call was not executed. When calling new_task multiple times in one message, every call must have is_background: true. To launch parallel subtasks, set is_background: true on each new_task call and send them all in one message.",
							is_error: true,
						})
					}
				}

				const truncatedContent = assistantContent.filter(
					(block) =>
						!(block.type === "tool_use" && (block as Anthropic.ToolUseBlockParam).name === "new_task"),
				)
				return { truncatedContent, injectedToolResults }
			}

			// All background — allow all to execute; no truncation needed.
			return { truncatedContent: assistantContent, injectedToolResults: [] }
		}

		// Single new_task case: truncate tools after it.
		const newTaskIndex = assistantContent.findIndex(
			(block) => block.type === "tool_use" && (block as Anthropic.ToolUseBlockParam).name === "new_task",
		)

		if (newTaskIndex !== -1 && newTaskIndex < assistantContent.length - 1) {
			// new_task found but not last - truncate subsequent tools
			const truncatedTools = assistantContent.slice(newTaskIndex + 1)
			const truncatedContent = assistantContent.slice(0, newTaskIndex + 1)

			// Pre-inject error tool_results for truncated tools
			for (const tool of truncatedTools) {
				if (tool.type === "tool_use" && (tool as Anthropic.ToolUseBlockParam).id) {
					injectedToolResults.push({
						type: "tool_result",
						tool_use_id: (tool as Anthropic.ToolUseBlockParam).id,
						content:
							"This tool was not executed because new_task was called in the same message turn. The new_task tool must be the last tool in a message.",
						is_error: true,
					})
				}
			}

			return { truncatedContent, injectedToolResults }
		}

		return { truncatedContent: assistantContent, injectedToolResults: [] }
	}

	describe("new_task as last tool (no truncation needed)", () => {
		it("should not truncate when new_task is the only tool", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.truncatedContent).toHaveLength(1)
			expect(result.injectedToolResults).toHaveLength(0)
		})

		it("should not truncate when new_task is the last tool", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.truncatedContent).toHaveLength(2)
			expect(result.injectedToolResults).toHaveLength(0)
		})

		it("should not truncate when there is no new_task tool", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
				{
					type: "tool_use",
					id: "toolu_write_1",
					name: "write_to_file",
					input: { path: "test.txt", content: "hello" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.truncatedContent).toHaveLength(2)
			expect(result.injectedToolResults).toHaveLength(0)
		})
	})

	describe("new_task followed by other tools (truncation required)", () => {
		it("should truncate tools after new_task", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.truncatedContent).toHaveLength(1)
			expect(result.truncatedContent[0].type).toBe("tool_use")
			expect((result.truncatedContent[0] as Anthropic.ToolUseBlockParam).name).toBe("new_task")
		})

		it("should inject error tool_results for truncated tools", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.injectedToolResults).toHaveLength(1)
			expect(result.injectedToolResults[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: "toolu_read_1",
				is_error: true,
			})
			expect(result.injectedToolResults[0].content).toContain("new_task was called")
		})

		it("should truncate multiple tools after new_task", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
				{
					type: "tool_use",
					id: "toolu_write_1",
					name: "write_to_file",
					input: { path: "test.txt", content: "hello" },
				},
				{
					type: "tool_use",
					id: "toolu_execute_1",
					name: "execute_command",
					input: { command: "ls" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.truncatedContent).toHaveLength(1)
			expect(result.injectedToolResults).toHaveLength(3)

			// Verify all truncated tools get error results
			const truncatedIds = result.injectedToolResults.map((r) => r.tool_use_id)
			expect(truncatedIds).toContain("toolu_read_1")
			expect(truncatedIds).toContain("toolu_write_1")
			expect(truncatedIds).toContain("toolu_execute_1")
		})

		it("should preserve tools before new_task", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_write_1",
					name: "write_to_file",
					input: { path: "test.txt", content: "hello" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			// Should preserve read_file and new_task, truncate write_to_file
			expect(result.truncatedContent).toHaveLength(2)
			expect((result.truncatedContent[0] as Anthropic.ToolUseBlockParam).name).toBe("read_file")
			expect((result.truncatedContent[1] as Anthropic.ToolUseBlockParam).name).toBe("new_task")

			// Should inject error for write_to_file only
			expect(result.injectedToolResults).toHaveLength(1)
			expect(result.injectedToolResults[0].tool_use_id).toBe("toolu_write_1")
		})
	})

	describe("Mixed content (text and tools)", () => {
		it("should handle text blocks before new_task", () => {
			const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [
				{
					type: "text",
					text: "I will delegate this task.",
				},
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			// Should preserve text and new_task, truncate read_file
			expect(result.truncatedContent).toHaveLength(2)
			expect(result.truncatedContent[0].type).toBe("text")
			expect((result.truncatedContent[1] as Anthropic.ToolUseBlockParam).name).toBe("new_task")

			expect(result.injectedToolResults).toHaveLength(1)
			expect(result.injectedToolResults[0].tool_use_id).toBe("toolu_read_1")
		})

		it("should not count text blocks when checking if new_task is last tool", () => {
			// This is a subtle case - if text comes AFTER new_task, we need to decide
			// whether that counts as "new_task is last tool". The implementation only
			// checks array position, so text after new_task means new_task is NOT last.
			// However, text blocks don't need tool_results, so this is fine.
			const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "text",
					text: "Done delegating.",
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			// Text after new_task gets truncated but doesn't need tool_result
			expect(result.truncatedContent).toHaveLength(1)
			expect(result.injectedToolResults).toHaveLength(0) // Text blocks don't get tool_results
		})
	})

	describe("Edge cases", () => {
		it("should handle empty content array", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = []

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.truncatedContent).toHaveLength(0)
			expect(result.injectedToolResults).toHaveLength(0)
		})

		it("should handle tool without id (should not inject error result)", () => {
			const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				// Simulating a malformed tool without ID (shouldn't happen, but defensive)
				{
					type: "tool_use",
					name: "read_file",
					input: { path: "test.txt" },
				} as any,
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.truncatedContent).toHaveLength(1)
			// No error result for tool without ID
			expect(result.injectedToolResults).toHaveLength(0)
		})

		it("should reject ALL new_task calls when multiple sync new_task appear (the extra-child bug)", () => {
			// Regression: the LLM may send 3 sync new_task calls in one message when asked
			// for 3 parallel subtasks. Previously the first one executed (creating an
			// unintended sync child) while the other two were rejected. The LLM then
			// retried with is_background=true — creating 3 more — for a total of 4.
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Subtask 1", is_background: false },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_2",
					name: "new_task",
					input: { mode: "code", message: "Subtask 2", is_background: false },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_3",
					name: "new_task",
					input: { mode: "code", message: "Subtask 3", is_background: false },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			// All new_task blocks removed — none should execute
			expect(result.truncatedContent).toHaveLength(0)
			// Every new_task call gets an error result
			expect(result.injectedToolResults).toHaveLength(3)
			const errorIds = result.injectedToolResults.map((r) => r.tool_use_id)
			expect(errorIds).toContain("toolu_new_task_1")
			expect(errorIds).toContain("toolu_new_task_2")
			expect(errorIds).toContain("toolu_new_task_3")
			for (const r of result.injectedToolResults) {
				expect(r.is_error).toBe(true)
				expect(r.content as string).toContain("is_background: true")
			}
		})

		it("should reject mixed new_task calls when not all are is_background=true", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Background subtask", is_background: true },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_2",
					name: "new_task",
					input: { mode: "code", message: "Sync subtask" }, // no is_background
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.truncatedContent).toHaveLength(0)
			expect(result.injectedToolResults).toHaveLength(2)
			for (const r of result.injectedToolResults) {
				expect(r.is_error).toBe(true)
			}
		})
	})

	describe("Multiple background new_task calls (fan-out)", () => {
		it("should allow all new_task calls when all have is_background=true", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Subtask 1", is_background: true },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_2",
					name: "new_task",
					input: { mode: "code", message: "Subtask 2", is_background: true },
				},
				{
					type: "tool_use",
					id: "toolu_new_task_3",
					name: "new_task",
					input: { mode: "code", message: "Subtask 3", is_background: true },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			// All three background new_task calls must be preserved for execution
			expect(result.truncatedContent).toHaveLength(3)
			expect(result.injectedToolResults).toHaveLength(0)
		})
	})

	describe("Error message content", () => {
		it("should include descriptive error message", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.injectedToolResults[0].content).toContain("new_task was called")
			expect(result.injectedToolResults[0].content).toContain("must be the last tool")
		})

		it("should mark error results with is_error: true", () => {
			const assistantContent: Anthropic.ToolUseBlockParam[] = [
				{
					type: "tool_use",
					id: "toolu_new_task_1",
					name: "new_task",
					input: { mode: "code", message: "Do something" },
				},
				{
					type: "tool_use",
					id: "toolu_read_1",
					name: "read_file",
					input: { path: "test.txt" },
				},
			]

			const result = enforceNewTaskIsolation(assistantContent)

			expect(result.injectedToolResults[0].is_error).toBe(true)
		})
	})
})
