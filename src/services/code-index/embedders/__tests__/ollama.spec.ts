import type { MockedFunction } from "vitest"

import { CodeIndexOllamaEmbedder } from "../ollama"

// Mock fetch
global.fetch = vitest.fn() as MockedFunction<typeof fetch>

// Mock TelemetryService
vitest.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vitest.fn(),
		},
	},
}))

// Mock i18n
vitest.mock("../../../../i18n", () => ({
	t: (key: string, params?: Record<string, any>) => {
		const translations: Record<string, string> = {
			"embeddings:validation.serviceUnavailable":
				"The embedder service is not available. Please ensure it is running and accessible.",
			"embeddings:validation.modelNotAvailable":
				"The specified model is not available. Please check your model configuration.",
			"embeddings:validation.connectionFailed":
				"Failed to connect to the embedder service. Please check your connection settings and ensure the service is running.",
			"embeddings:validation.configurationError": "Invalid embedder configuration. Please review your settings.",
			"embeddings:errors.ollama.serviceNotRunning":
				"Ollama service is not running at {{baseUrl}}. Please start Ollama first.",
			"embeddings:errors.ollama.serviceUnavailable":
				"Ollama service is unavailable at {{baseUrl}}. HTTP status: {{status}}",
			"embeddings:errors.ollama.modelNotFound":
				"Model '{{model}}' not found. Available models: {{availableModels}}",
			"embeddings:errors.ollama.modelNotEmbedding": "Model '{{model}}' is not embedding capable",
			"embeddings:errors.ollama.hostNotFound": "Ollama host not found: {{baseUrl}}",
			"embeddings:errors.ollama.connectionTimeout": "Connection to Ollama timed out at {{baseUrl}}",
		}
		// Handle parameter substitution
		let result = translations[key] || key
		if (params) {
			Object.entries(params).forEach(([param, value]) => {
				result = result.replace(new RegExp(`{{${param}}}`, "g"), String(value))
			})
		}
		return result
	},
}))

// Mock console methods
const consoleMocks = {
	error: vitest.spyOn(console, "error").mockImplementation(() => {}),
}

describe("CodeIndexOllamaEmbedder", () => {
	let embedder: CodeIndexOllamaEmbedder
	let mockFetch: MockedFunction<typeof fetch>

	beforeEach(() => {
		vitest.clearAllMocks()
		consoleMocks.error.mockClear()

		mockFetch = global.fetch as MockedFunction<typeof fetch>

		embedder = new CodeIndexOllamaEmbedder({
			ollamaModelId: "nomic-embed-text",
			ollamaBaseUrl: "http://localhost:11434",
		})
	})

	afterEach(() => {
		vitest.clearAllMocks()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(embedder.embedderInfo.name).toBe("ollama")
		})

		it("should use default values when not provided", () => {
			const embedderWithDefaults = new CodeIndexOllamaEmbedder({})
			expect(embedderWithDefaults.embedderInfo.name).toBe("ollama")
		})

		it("should normalize URLs with trailing slashes", async () => {
			// Create embedder with URL that has a trailing slash
			const embedderWithTrailingSlash = new CodeIndexOllamaEmbedder({
				ollamaBaseUrl: "http://localhost:11434/",
				ollamaModelId: "nomic-embed-text",
			})

			// Mock successful /api/tags call to test the normalized URL
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ models: [{ name: "nomic-embed-text" }] }),
				} as Response),
			)

			// Call a method that uses the baseUrl
			await embedderWithTrailingSlash.validateConfiguration()

			// Verify the URL used in the fetch call doesn't have a trailing slash
			expect(mockFetch).toHaveBeenCalledWith(
				"http://localhost:11434/api/tags",
				expect.objectContaining({
					method: "GET",
				}),
			)
		})

		it("should not modify URLs without trailing slashes", async () => {
			// Create embedder with URL that doesn't have a trailing slash
			const embedderWithoutTrailingSlash = new CodeIndexOllamaEmbedder({
				ollamaBaseUrl: "http://localhost:11434",
				ollamaModelId: "nomic-embed-text",
			})

			// Mock successful /api/tags call
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ models: [{ name: "nomic-embed-text" }] }),
				} as Response),
			)

			// Call a method that uses the baseUrl
			await embedderWithoutTrailingSlash.validateConfiguration()

			// Verify the URL used in the fetch call is correct
			expect(mockFetch).toHaveBeenCalledWith(
				"http://localhost:11434/api/tags",
				expect.objectContaining({
					method: "GET",
				}),
			)
		})

		it("should handle multiple trailing slashes", async () => {
			// Create embedder with URL that has multiple trailing slashes
			const embedderWithMultipleTrailingSlashes = new CodeIndexOllamaEmbedder({
				ollamaBaseUrl: "http://localhost:11434///",
				ollamaModelId: "nomic-embed-text",
			})

			// Mock successful /api/tags call
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ models: [{ name: "nomic-embed-text" }] }),
				} as Response),
			)

			// Call a method that uses the baseUrl
			await embedderWithMultipleTrailingSlashes.validateConfiguration()

			// Verify the URL used in the fetch call doesn't have trailing slashes
			expect(mockFetch).toHaveBeenCalledWith(
				"http://localhost:11434/api/tags",
				expect.objectContaining({
					method: "GET",
				}),
			)
		})
	})

	describe("validateConfiguration", () => {
		it("should validate successfully when service is available and model exists", async () => {
			// Mock successful /api/tags call
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							models: [{ name: "nomic-embed-text:latest" }, { name: "llama2:latest" }],
						}),
				} as Response),
			)

			// Mock successful /api/embed test call
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							embeddings: [[0.1, 0.2, 0.3]],
						}),
				} as Response),
			)

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(true)
			expect(result.error).toBeUndefined()
			expect(mockFetch).toHaveBeenCalledTimes(2)

			// Check first call (GET /api/tags)
			const firstCall = mockFetch.mock.calls[0]
			expect(firstCall[0]).toBe("http://localhost:11434/api/tags")
			expect(firstCall[1]?.method).toBe("GET")
			expect(firstCall[1]?.headers).toEqual({ "Content-Type": "application/json" })
			expect(firstCall[1]?.signal).toBeDefined() // AbortSignal for timeout

			// Check second call (POST /api/embed)
			const secondCall = mockFetch.mock.calls[1]
			expect(secondCall[0]).toBe("http://localhost:11434/api/embed")
			expect(secondCall[1]?.method).toBe("POST")
			expect(secondCall[1]?.headers).toEqual({ "Content-Type": "application/json" })
			expect(secondCall[1]?.body).toBe(JSON.stringify({ model: "nomic-embed-text", input: ["test"] }))
			expect(secondCall[1]?.signal).toBeDefined() // AbortSignal for timeout
		})

		it("should fail validation when service is not available", async () => {
			mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("embeddings:ollama.serviceNotRunning")
		})

		it("should fail validation when tags endpoint returns 404", async () => {
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: false,
					status: 404,
				} as Response),
			)

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("embeddings:ollama.serviceNotRunning")
		})

		it("should fail validation when tags endpoint returns other error", async () => {
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: false,
					status: 500,
				} as Response),
			)

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("embeddings:ollama.serviceUnavailable")
		})

		it("should fail validation when model does not exist", async () => {
			// Mock successful /api/tags call with different models
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							models: [{ name: "llama2:latest" }, { name: "mistral:latest" }],
						}),
				} as Response),
			)

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("embeddings:ollama.modelNotFound")
		})

		it("should fail validation when model exists but doesn't support embeddings", async () => {
			// Mock successful /api/tags call
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							models: [{ name: "nomic-embed-text" }],
						}),
				} as Response),
			)

			// Mock failed /api/embed test call
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: false,
					status: 400,
				} as Response),
			)

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("embeddings:ollama.modelNotEmbeddingCapable")
		})

		it("should handle ECONNREFUSED errors", async () => {
			mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("embeddings:ollama.serviceNotRunning")
		})

		it("should handle ENOTFOUND errors", async () => {
			mockFetch.mockRejectedValueOnce(new Error("ENOTFOUND"))

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("embeddings:ollama.hostNotFound")
		})

		it("should handle generic network errors", async () => {
			mockFetch.mockRejectedValueOnce(new Error("Network timeout"))

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("Network timeout")
		})
	})

	describe("createEmbeddings", () => {
		// Helper: mock the `/api/show` probe response for a given context length.
		const mockShow = (contextLength: number, archPrefix = "nomic-bert") =>
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							model_info: { [`${archPrefix}.context_length`]: contextLength },
						}),
				} as Response),
			)

		// Helper: mock the `/api/embed` response with a single zero vector per input.
		const mockEmbed = (dim = 3) =>
			mockFetch.mockImplementationOnce((_url, init) => {
				const body = JSON.parse((init as RequestInit).body as string)
				const inputs: string[] = body.input
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							embeddings: inputs.map(() => Array(dim).fill(0)),
						}),
				} as Response)
			})

		it("probes /api/show, caches the result, and sets options.num_ctx to the probed value", async () => {
			mockShow(2048)
			mockEmbed()
			mockEmbed()

			await embedder.createEmbeddings(["hello"])
			await embedder.createEmbeddings(["world"]) // second call must reuse cached probe

			// Three calls total: 1 probe + 2 embeds (no second probe).
			expect(mockFetch).toHaveBeenCalledTimes(3)

			const showCall = mockFetch.mock.calls[0]
			expect(showCall[0]).toBe("http://localhost:11434/api/show")
			expect(JSON.parse((showCall[1] as RequestInit).body as string)).toEqual({ name: "nomic-embed-text" })

			for (const idx of [1, 2]) {
				const embedCall = mockFetch.mock.calls[idx]
				expect(embedCall[0]).toBe("http://localhost:11434/api/embed")
				const body = JSON.parse((embedCall[1] as RequestInit).body as string)
				expect(body.options).toEqual({ num_ctx: 2048 })
			}
		})

		it("truncates inputs that exceed the chars-per-token budget derived from the probed context", async () => {
			mockShow(2048)
			mockEmbed()

			// Cap = floor((2048 - 8) * 2.5) = 5100 chars.
			const oversized = "a".repeat(10_000)
			await embedder.createEmbeddings([oversized])

			const embedCall = mockFetch.mock.calls[1]
			const body = JSON.parse((embedCall[1] as RequestInit).body as string)
			expect(body.input[0].length).toBe(5100)
		})

		it("falls back to 2048 tokens when /api/show fails", async () => {
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: false,
					status: 500,
					statusText: "boom",
					json: () => Promise.resolve({}),
				} as Response),
			)
			mockEmbed()

			await embedder.createEmbeddings(["hi"])

			const embedCall = mockFetch.mock.calls[1]
			const body = JSON.parse((embedCall[1] as RequestInit).body as string)
			expect(body.options).toEqual({ num_ctx: 2048 })
		})

		it("takes the minimum across multiple *.context_length keys", async () => {
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							model_info: {
								"nomic-bert.context_length": 8192,
								"general.context_length": 2048,
							},
						}),
				} as Response),
			)
			mockEmbed()

			await embedder.createEmbeddings(["hi"])

			const embedCall = mockFetch.mock.calls[1]
			const body = JSON.parse((embedCall[1] as RequestInit).body as string)
			expect(body.options).toEqual({ num_ctx: 2048 })
		})
	})
})
