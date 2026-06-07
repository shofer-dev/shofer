// npx vitest api/providers/__tests__/bedrock-reasoning.test.ts

import { AwsBedrockHandler } from "../bedrock"
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime"

// Mock the AWS SDK
vi.mock("@aws-sdk/client-bedrock-runtime")

// Mock the subsystem logger with spies
vi.mock("../../../utils/logging/subsystems", () => {
	const noop = () => {}
	return {
		apiLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		taskLog: { error: noop, info: noop, warn: noop },
		webviewLog: { error: noop, info: noop, warn: noop },
		utilLog: { error: noop, info: noop, warn: noop },
		configLog: { error: noop, info: noop, warn: noop },
		fsLog: { error: noop, info: noop, warn: noop },
		codeIndexLog: { error: noop, info: noop, warn: noop },
		gitLog: { error: noop, info: noop, warn: noop },
		checkpointLog: { error: noop, info: noop, warn: noop },
		assistantAgentLog: { error: noop, info: noop, warn: noop },
		mcpLog: { error: noop, info: noop, warn: noop },
		skillsLog: { error: noop, info: noop, warn: noop },
		marketplaceLog: { error: noop, info: noop, warn: noop },
		metricsLog: { error: noop, info: noop, warn: noop },
		workflowLog: { error: noop, info: noop, warn: noop },
		i18nLog: { error: noop, info: noop, warn: noop },
		scrollLog: { error: noop, info: noop, warn: noop },
	}
})

// Import the mocked logger for spy assertions
import { apiLog } from "../../../utils/logging/subsystems"

// Store the command payload for verification
let capturedPayload: any = null

describe("AwsBedrockHandler - Extended Thinking", () => {
	let handler: AwsBedrockHandler
	let mockSend: ReturnType<typeof vi.fn>

	beforeEach(() => {
		capturedPayload = null
		mockSend = vi.fn()

		// Mock ConverseStreamCommand to capture the payload
		;(ConverseStreamCommand as unknown as ReturnType<typeof vi.fn>).mockImplementation((payload) => {
			capturedPayload = payload
			return {
				input: payload,
			}
		})
		;(BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
			send: mockSend,
			config: { region: "us-east-1" },
		}))
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe("Extended Thinking Support", () => {
		it("should include thinking parameter for Claude Sonnet 4 when reasoning is enabled", async () => {
			handler = new AwsBedrockHandler({
				apiProvider: "bedrock",
				apiModelId: "anthropic.claude-sonnet-4-20250514-v1:0",
				awsRegion: "us-east-1",
				enableReasoningEffort: true,
				modelMaxTokens: 8192,
				modelMaxThinkingTokens: 4096,
			})

			// Mock the stream response
			mockSend.mockResolvedValue({
				stream: (async function* () {
					yield {
						messageStart: { role: "assistant" },
					}
					yield {
						contentBlockStart: {
							content_block: { type: "thinking", thinking: "Let me think..." },
							contentBlockIndex: 0,
						},
					}
					yield {
						contentBlockDelta: {
							delta: { type: "thinking_delta", thinking: " about this problem." },
						},
					}
					yield {
						contentBlockStart: {
							start: { text: "Here's the answer:" },
							contentBlockIndex: 1,
						},
					}
					yield {
						metadata: {
							usage: { inputTokens: 100, outputTokens: 50 },
						},
					}
				})(),
			})

			const messages = [{ role: "user" as const, content: "Test message" }]
			const stream = handler.createMessage("System prompt", messages)

			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify the command was called with the correct payload
			expect(mockSend).toHaveBeenCalledTimes(1)
			expect(capturedPayload).toBeDefined()
			expect(capturedPayload.additionalModelRequestFields).toBeDefined()
			expect(capturedPayload.additionalModelRequestFields.thinking).toEqual({
				type: "enabled",
				budget_tokens: 4096, // Uses the full modelMaxThinkingTokens value
			})

			// Verify reasoning chunks were yielded
			const reasoningChunks = chunks.filter((c) => c.type === "reasoning")
			expect(reasoningChunks).toHaveLength(2)
			expect(reasoningChunks[0].text).toBe("Let me think...")
			expect(reasoningChunks[1].text).toBe(" about this problem.")

			// Verify that topP is NOT present when thinking is enabled
			expect(capturedPayload.inferenceConfig).not.toHaveProperty("topP")
		})

		it("should pass thinking parameters from metadata", async () => {
			handler = new AwsBedrockHandler({
				apiProvider: "bedrock",
				apiModelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
				awsRegion: "us-east-1",
			})

			mockSend.mockResolvedValue({
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } }
					yield { metadata: { usage: { inputTokens: 100, outputTokens: 50 } } }
				})(),
			})

			const messages = [{ role: "user" as const, content: "Test message" }]
			const metadata = {
				taskId: "test-task",
				thinking: {
					enabled: true,
					maxTokens: 16384,
					maxThinkingTokens: 8192,
				},
			}

			const stream = handler.createMessage("System prompt", messages, metadata)
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify the thinking parameter was passed correctly
			expect(mockSend).toHaveBeenCalledTimes(1)
			expect(capturedPayload).toBeDefined()
			expect(capturedPayload.additionalModelRequestFields).toBeDefined()
			expect(capturedPayload.additionalModelRequestFields.thinking).toEqual({
				type: "enabled",
				budget_tokens: 8192,
			})

			// Verify that topP is NOT present when thinking is enabled via metadata
			expect(capturedPayload.inferenceConfig).not.toHaveProperty("topP")
		})

		it("should log when extended thinking is enabled", async () => {
			handler = new AwsBedrockHandler({
				apiProvider: "bedrock",
				apiModelId: "anthropic.claude-opus-4-20250514-v1:0",
				awsRegion: "us-east-1",
				enableReasoningEffort: true,
				modelMaxThinkingTokens: 5000,
			})

			mockSend.mockResolvedValue({
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } }
				})(),
			})

			const messages = [{ role: "user" as const, content: "Test" }]
			const stream = handler.createMessage("System prompt", messages)

			for await (const chunk of stream) {
				// consume stream
			}

			// Verify logging
			expect(apiLog.info).toHaveBeenCalledWith(
				expect.stringContaining("Extended thinking enabled"),
				expect.objectContaining({
					ctx: "bedrock",
					modelId: "anthropic.claude-opus-4-20250514-v1:0",
				}),
			)
		})

		it("should not include topP when thinking is disabled (global removal)", async () => {
			handler = new AwsBedrockHandler({
				apiProvider: "bedrock",
				apiModelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
				awsRegion: "us-east-1",
				// Note: no enableReasoningEffort = true, so thinking is disabled
			})

			mockSend.mockResolvedValue({
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } }
					yield {
						contentBlockStart: {
							start: { text: "Hello" },
							contentBlockIndex: 0,
						},
					}
					yield {
						contentBlockDelta: {
							delta: { text: " world" },
						},
					}
					yield { metadata: { usage: { inputTokens: 100, outputTokens: 50 } } }
				})(),
			})

			const messages = [{ role: "user" as const, content: "Test message" }]
			const stream = handler.createMessage("System prompt", messages)

			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify that topP is NOT present for any model (removed globally)
			expect(mockSend).toHaveBeenCalledTimes(1)
			expect(capturedPayload).toBeDefined()
			expect(capturedPayload.inferenceConfig).not.toHaveProperty("topP")

			// Verify that additionalModelRequestFields contains fine-grained-tool-streaming for Claude models
			expect(capturedPayload.additionalModelRequestFields).toBeDefined()
			expect(capturedPayload.additionalModelRequestFields.anthropic_beta).toContain(
				"fine-grained-tool-streaming-2025-05-14",
			)
		})

		it("should enable reasoning when enableReasoningEffort is true in settings", async () => {
			handler = new AwsBedrockHandler({
				apiProvider: "bedrock",
				apiModelId: "anthropic.claude-sonnet-4-20250514-v1:0",
				awsRegion: "us-east-1",
				enableReasoningEffort: true, // This should trigger reasoning
				modelMaxThinkingTokens: 4096,
			})

			mockSend.mockResolvedValue({
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } }
					yield {
						contentBlockStart: {
							content_block: { type: "thinking", thinking: "Let me think..." },
							contentBlockIndex: 0,
						},
					}
					yield {
						contentBlockDelta: {
							delta: { type: "thinking_delta", thinking: " about this problem." },
						},
					}
					yield { metadata: { usage: { inputTokens: 100, outputTokens: 50 } } }
				})(),
			})

			const messages = [{ role: "user" as const, content: "Test message" }]
			const stream = handler.createMessage("System prompt", messages)

			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify thinking was enabled via settings
			expect(mockSend).toHaveBeenCalledTimes(1)
			expect(capturedPayload).toBeDefined()
			expect(capturedPayload.additionalModelRequestFields).toBeDefined()
			expect(capturedPayload.additionalModelRequestFields.thinking).toEqual({
				type: "enabled",
				budget_tokens: 4096,
			})

			// Verify that topP is NOT present when thinking is enabled via settings
			expect(capturedPayload.inferenceConfig).not.toHaveProperty("topP")

			// Verify reasoning chunks were yielded
			const reasoningChunks = chunks.filter((c) => c.type === "reasoning")
			expect(reasoningChunks).toHaveLength(2)
			expect(reasoningChunks[0].text).toBe("Let me think...")
			expect(reasoningChunks[1].text).toBe(" about this problem.")
		})

		it("should support API key authentication", async () => {
			handler = new AwsBedrockHandler({
				apiProvider: "bedrock",
				apiModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				awsRegion: "us-east-1",
				awsUseApiKey: true,
				awsApiKey: "test-api-key-token",
			})

			mockSend.mockResolvedValue({
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } }
					yield {
						contentBlockStart: {
							start: { text: "Hello from API key auth" },
							contentBlockIndex: 0,
						},
					}
					yield { metadata: { usage: { inputTokens: 100, outputTokens: 50 } } }
				})(),
			})

			const messages = [{ role: "user" as const, content: "Test message" }]
			const stream = handler.createMessage("System prompt", messages)

			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify the client was created with API key token
			expect(BedrockRuntimeClient).toHaveBeenCalledWith(
				expect.objectContaining({
					region: "us-east-1",
					token: { token: "test-api-key-token" },
					authSchemePreference: ["httpBearerAuth"],
				}),
			)

			// Verify the stream worked correctly
			expect(mockSend).toHaveBeenCalledTimes(1)
			const textChunks = chunks.filter((c) => c.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Hello from API key auth")
		})
	})
})
