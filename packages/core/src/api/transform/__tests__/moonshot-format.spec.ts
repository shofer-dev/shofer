// npx vitest run src/api/transform/__tests__/moonshot-format.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import { convertToMoonshotFormat } from "../moonshot-format.js"

describe("convertToMoonshotFormat", () => {
	describe("basic message conversion", () => {
		it("converts simple string user messages", () => {
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			const result = convertToMoonshotFormat(messages)

			expect(result).toHaveLength(1)
			expect(result[0]).toEqual({ role: "user", content: "Hello" })
		})

		it("converts simple string assistant messages", () => {
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "assistant", content: "Hi there" }]

			const result = convertToMoonshotFormat(messages)

			expect(result).toHaveLength(1)
			expect(result[0]).toEqual({ role: "assistant", content: "Hi there" })
		})

		it("converts text block user messages", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [{ type: "text", text: "Hello world" }],
				},
			]

			const result = convertToMoonshotFormat(messages)

			expect(result).toHaveLength(1)
			expect(result[0]).toEqual({ role: "user", content: "Hello world" })
		})
	})

	describe("reasoning_content preservation", () => {
		it("extracts reasoning from content blocks and sets reasoning_content", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "I should help the user." } as any,
						{ type: "text", text: "Hello!" },
					],
				},
			]

			const result = convertToMoonshotFormat(messages)

			expect(result).toHaveLength(1)
			const assistant = result[0] as { role: string; content: string; reasoning_content?: string }
			expect(assistant.role).toBe("assistant")
			expect(assistant.content).toBe("Hello!")
			expect(assistant.reasoning_content).toBe("I should help the user.")
		})

		it("preserves reasoning_content alongside tool calls", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "I need to use a tool." } as any,
						{
							type: "tool_use",
							id: "call_1",
							name: "read_file",
							input: { path: "test.ts" },
						},
					],
				},
			]

			const result = convertToMoonshotFormat(messages)

			expect(result).toHaveLength(1)
			const assistant = result[0] as {
				role: string
				content: string | null
				reasoning_content?: string
				tool_calls?: unknown[]
			}
			expect(assistant.role).toBe("assistant")
			expect(assistant.reasoning_content).toBe("I need to use a tool.")
			expect(assistant.tool_calls).toHaveLength(1)
		})

		it("prefers top-level reasoning_content over content block reasoning", () => {
			const messages = [
				{
					role: "assistant",
					content: [{ type: "reasoning", text: "from block" } as any, { type: "text", text: "response" }],
					reasoning_content: "from top level",
				},
			] as unknown as Anthropic.Messages.MessageParam[]

			const result = convertToMoonshotFormat(messages)

			const assistant = result[0] as { reasoning_content?: string }
			expect(assistant.reasoning_content).toBe("from top level")
		})

		it("does not set reasoning_content when no reasoning is present", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [{ type: "text", text: "Just a normal response" }],
				},
			]

			const result = convertToMoonshotFormat(messages)

			const assistant = result[0] as { reasoning_content?: string }
			expect(assistant.reasoning_content).toBeUndefined()
		})
	})

	describe("tool result handling", () => {
		it("converts tool_result blocks to tool messages", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read the file" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_1",
							name: "read_file",
							input: { path: "test.ts" },
						},
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call_1", content: "file contents" }],
				},
			]

			const result = convertToMoonshotFormat(messages)

			// Should have: user, assistant, tool
			expect(result).toHaveLength(3)
			expect(result[2]).toEqual({
				role: "tool",
				tool_call_id: "call_1",
				content: "file contents",
			})
		})

		it("merges post-tool-result text into the last tool message by default", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read the file" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_1",
							name: "read_file",
							input: { path: "test.ts" },
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_1", content: "file contents" },
						{ type: "text", text: "[environment_details]" },
					],
				},
			]

			const result = convertToMoonshotFormat(messages)

			// The text should be merged into the tool message, not a separate user message
			const toolMessages = result.filter((m) => m.role === "tool")
			expect(toolMessages).toHaveLength(1)
			expect((toolMessages[0] as { content: string }).content).toContain("file contents")
			expect((toolMessages[0] as { content: string }).content).toContain("[environment_details]")

			// No extra user message after the tool message
			const userMessages = result.filter((m) => m.role === "user")
			expect(userMessages).toHaveLength(1)
		})

		it("does NOT merge text into tool message when mergeToolResultText is false", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read the file" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_1",
							name: "read_file",
							input: { path: "test.ts" },
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_1", content: "file contents" },
						{ type: "text", text: "extra text" },
					],
				},
			]

			const result = convertToMoonshotFormat(messages, { mergeToolResultText: false })

			// Text should NOT be merged — a separate user message is created
			const toolMessages = result.filter((m) => m.role === "tool")
			expect((toolMessages[0] as { content: string }).content).toBe("file contents")

			const userMessages = result.filter((m) => m.role === "user")
			expect(userMessages).toHaveLength(2)
		})

		it("does NOT merge text into tool message when images are present", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read the file" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_1",
							name: "read_file",
							input: { path: "test.ts" },
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_1", content: "file contents" },
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: "abc" },
						},
					],
				},
			]

			const result = convertToMoonshotFormat(messages)

			// With images, text should NOT be merged into tool message
			const toolMessages = result.filter((m) => m.role === "tool")
			expect((toolMessages[0] as { content: string }).content).toBe("file contents")
		})
	})

	describe("consecutive message merging", () => {
		it("merges consecutive user messages", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "First message" },
				{ role: "user", content: "Second message" },
			]

			const result = convertToMoonshotFormat(messages)

			expect(result).toHaveLength(1)
			expect((result[0] as { content: string }).content).toBe("First message\nSecond message")
		})

		it("merges consecutive assistant messages without tool calls", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "assistant", content: "First part" },
				{ role: "assistant", content: "Second part" },
			]

			const result = convertToMoonshotFormat(messages)

			expect(result).toHaveLength(1)
			expect((result[0] as { content: string }).content).toBe("First part\nSecond part")
		})
	})

	describe("full conversation with reasoning and tools", () => {
		it("preserves reasoning_content across multiple tool-call rounds", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read two files" },
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "I need to read both files." } as any,
						{ type: "text", text: "Let me read them." },
						{
							type: "tool_use",
							id: "call_1",
							name: "read_file",
							input: { path: "a.ts" },
						},
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call_1", content: "contents of a.ts" }],
				},
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "Now I need to read the second file." } as any,
						{
							type: "tool_use",
							id: "call_2",
							name: "read_file",
							input: { path: "b.ts" },
						},
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call_2", content: "contents of b.ts" }],
				},
			]

			const result = convertToMoonshotFormat(messages)

			const assistants = result.filter((m) => m.role === "assistant") as {
				reasoning_content?: string
				tool_calls?: unknown[]
			}[]

			expect(assistants).toHaveLength(2)
			expect(assistants[0]!.reasoning_content).toBe("I need to read both files.")
			expect(assistants[0]!.tool_calls).toHaveLength(1)
			expect(assistants[1]!.reasoning_content).toBe("Now I need to read the second file.")
			expect(assistants[1]!.tool_calls).toHaveLength(1)
		})
	})
})
