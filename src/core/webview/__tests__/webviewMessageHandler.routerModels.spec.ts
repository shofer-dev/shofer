import { describe, it, expect, vi, beforeEach } from "vitest"
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ShoferProvider } from "../ShoferProvider"

// Mock vscode (minimal)
vi.mock("vscode", async (importOriginal) => {
	const actual: any = await importOriginal()
	const showErrorMessage = vi.fn()
	const showWarningMessage = vi.fn()
	const showInformationMessage = vi.fn()
	const getConfiguration = vi.fn(() => ({
		get: vi.fn(),
		update: vi.fn(),
	}))
	const clipboardWriteText = vi.fn()
	const openExternal = vi.fn()
	const executeCommand = vi.fn()
	const uriParse = vi.fn((s: string) => ({ toString: () => s }))
	const uriFile = vi.fn((p: string) => ({ fsPath: p }))

	return {
		...actual,
		window: {
			...actual.window,
			showErrorMessage,
			showWarningMessage,
			showInformationMessage,
		},
		workspace: {
			...actual.workspace,
			workspaceFolders: undefined,
			getConfiguration,
		},
		env: {
			...actual.env,
			clipboard: { writeText: clipboardWriteText },
			openExternal,
		},
		commands: {
			...actual.commands,
			executeCommand,
		},
		Uri: {
			...actual.Uri,
			parse: uriParse,
			file: uriFile,
		},
		ConfigurationTarget: {
			Global: 1,
			Workspace: 2,
			WorkspaceFolder: 3,
		},
	}
})

// Mock modelCache getModels/flushModels used by the handler
const getModelsMock = vi.fn()
const flushModelsMock = vi.fn()
vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: (...args: any[]) => getModelsMock(...args),
	flushModels: (...args: any[]) => flushModelsMock(...args),
}))

describe("webviewMessageHandler - requestRouterModels provider filter", () => {
	let mockProvider: ShoferProvider & {
		postMessageToWebview: ReturnType<typeof vi.fn>
		getState: ReturnType<typeof vi.fn>
		contextProxy: any
		log: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		vi.clearAllMocks()

		mockProvider = {
			// Only methods used by this code path
			postMessageToWebview: vi.fn(),
			getState: vi.fn().mockResolvedValue({ apiConfiguration: {} }),
			contextProxy: {
				getValue: vi.fn(),
				setValue: vi.fn(),
				globalStorageUri: { fsPath: "/mock/storage" },
			},
			log: vi.fn(),
		} as any

		// Default mock: return distinct model maps per provider so we can verify keys
		getModelsMock.mockImplementation(async (options: any) => {
			switch (options?.provider) {
				case "openrouter":
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case "requesty":
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case "vercel-ai-gateway":
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case "litellm":
					return { "litellm/model": { contextWindow: 8192, supportsPromptCache: false } }
				default:
					return {}
			}
		})
	})

	it("fetches only requested provider when values.provider is present ('requesty')", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
				values: { provider: "requesty" },
			} as any,
		)

		// Should post a single routerModels message
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "routerModels", routerModels: expect.any(Object) }),
		)

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === "routerModels",
		)
		expect(call).toBeTruthy()
		const payload = call[0]
		const routerModels = payload.routerModels as Record<string, Record<string, any>>

		// Only "requesty" key should be present
		const keys = Object.keys(routerModels)
		expect(keys).toEqual(["requesty"])
		expect(Object.keys(routerModels.requesty || {})).toContain("requesty/model")

		// getModels should have been called exactly once for requesty
		const providersCalled = getModelsMock.mock.calls.map((c: any[]) => c[0]?.provider)
		expect(providersCalled).toEqual(["requesty"])
	})

	it("defaults to aggregate fetching when no provider filter is sent", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
			} as any,
		)

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === "routerModels",
		)
		expect(call).toBeTruthy()
		const routerModels = call[0].routerModels as Record<string, Record<string, any>>

		// Aggregate handler initializes many known routers - ensure a few expected keys exist
		expect(routerModels).toHaveProperty("openrouter")
		expect(routerModels).toHaveProperty("openrouter")
		expect(routerModels).toHaveProperty("requesty")
	})

	it("supports filtering another single provider ('openrouter')", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
				values: { provider: "openrouter" },
			} as any,
		)

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === "routerModels",
		)
		expect(call).toBeTruthy()
		const routerModels = call[0].routerModels as Record<string, Record<string, any>>
		const keys = Object.keys(routerModels)

		expect(keys).toEqual(["openrouter"])
		expect(Object.keys(routerModels.openrouter || {})).toContain("openrouter/qwen2.5")

		const providersCalled = getModelsMock.mock.calls.map((c: any[]) => c[0]?.provider)
		expect(providersCalled).toEqual(["openrouter"])
	})

	it("flushes cache when LiteLLM credentials are provided in message values", async () => {
		// Provide LiteLLM credentials via message.values (simulating Refresh Models button)
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
				values: {
					litellmApiKey: "test-api-key",
					litellmBaseUrl: "http://localhost:4000",
				},
			} as any,
		)

		// flushModels should have been called for litellm with refresh=true and credentials
		expect(flushModelsMock).toHaveBeenCalledWith(
			{ provider: "litellm", apiKey: "test-api-key", baseUrl: "http://localhost:4000" },
			true,
		)

		// getModels should have been called with the provided credentials
		const litellmCalls = getModelsMock.mock.calls.filter((c: any[]) => c[0]?.provider === "litellm")
		expect(litellmCalls.length).toBe(1)
		expect(litellmCalls[0][0]).toEqual({
			provider: "litellm",
			apiKey: "test-api-key",
			baseUrl: "http://localhost:4000",
		})
	})

	it("does not flush cache when using stored LiteLLM credentials", async () => {
		// Provide stored credentials via apiConfiguration
		mockProvider.getState.mockResolvedValue({
			apiConfiguration: {
				litellmApiKey: "stored-api-key",
				litellmBaseUrl: "http://stored:4000",
			},
		})

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
			} as any,
		)

		// flushModels should NOT have been called for litellm
		const litellmFlushCalls = flushModelsMock.mock.calls.filter((c: any[]) => c[0] === "litellm")
		expect(litellmFlushCalls.length).toBe(0)

		// getModels should still have been called with stored credentials
		const litellmCalls = getModelsMock.mock.calls.filter((c: any[]) => c[0]?.provider === "litellm")
		expect(litellmCalls.length).toBe(1)
		expect(litellmCalls[0][0]).toEqual({
			provider: "litellm",
			apiKey: "stored-api-key",
			baseUrl: "http://stored:4000",
		})
	})
})
