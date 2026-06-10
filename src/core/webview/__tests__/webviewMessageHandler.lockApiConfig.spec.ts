// npx vitest run core/webview/__tests__/webviewMessageHandler.lockApiConfig.spec.ts

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ShoferProvider } from "../ShoferProvider"

describe("webviewMessageHandler - lockApiConfigAcrossModes", () => {
	let mockProvider: {
		context: {
			workspaceState: {
				get: ReturnType<typeof vi.fn>
				update: ReturnType<typeof vi.fn>
			}
		}
		getState: ReturnType<typeof vi.fn>
		postInitState: ReturnType<typeof vi.fn>
		providerSettingsManager: {
			setModeConfig: ReturnType<typeof vi.fn>
		}
		postMessageToWebview: ReturnType<typeof vi.fn>
		getCurrentTask: ReturnType<typeof vi.fn>
		postConfigUpdate: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		vi.clearAllMocks()

		mockProvider = {
			context: {
				workspaceState: {
					get: vi.fn(),
					update: vi.fn().mockResolvedValue(undefined),
				},
			},
			getState: vi.fn().mockResolvedValue({
				currentApiConfigName: "test-config",
				listApiConfigMeta: [{ name: "test-config", id: "config-123" }],
				customModes: [],
			}),
			postInitState: vi.fn().mockResolvedValue(undefined),
			providerSettingsManager: {
				setModeConfig: vi.fn(),
			},
			postMessageToWebview: vi.fn(),
			getCurrentTask: vi.fn(),
			postConfigUpdate: vi.fn(),
		}
	})

	it("sets lockApiConfigAcrossModes to true and posts state without mode config fan-out", async () => {
		await webviewMessageHandler(mockProvider as unknown as ShoferProvider, {
			type: "lockApiConfigAcrossModes",
			bool: true,
		})

		expect(mockProvider.context.workspaceState.update).toHaveBeenCalledWith("lockApiConfigAcrossModes", true)
		expect(mockProvider.providerSettingsManager.setModeConfig).not.toHaveBeenCalled()
		expect(mockProvider.postConfigUpdate).toHaveBeenCalledWith("lockApiConfigAcrossModes", true)
	})

	it("sets lockApiConfigAcrossModes to false without applying to all modes", async () => {
		await webviewMessageHandler(mockProvider as unknown as ShoferProvider, {
			type: "lockApiConfigAcrossModes",
			bool: false,
		})

		expect(mockProvider.context.workspaceState.update).toHaveBeenCalledWith("lockApiConfigAcrossModes", false)
		expect(mockProvider.providerSettingsManager.setModeConfig).not.toHaveBeenCalled()
		expect(mockProvider.postConfigUpdate).toHaveBeenCalledWith("lockApiConfigAcrossModes", false)
	})
})
