import { render, screen, act } from "@/utils/test-utils"

import {
	type ProviderSettings,
	type ExperimentId,
	type ExtensionState,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
} from "@shofer/types"

import { ExtensionStateContextProvider, useExtensionState, mergeExtensionState } from "../ExtensionStateContext"

const TestComponent = () => {
	const { allowedCommands, setAllowedCommands, soundEnabled, showShoferIgnoredFiles, setShowShoferIgnoredFiles } =
		useExtensionState()

	return (
		<div>
			<div data-testid="allowed-commands">{JSON.stringify(allowedCommands)}</div>
			<div data-testid="sound-enabled">{JSON.stringify(soundEnabled)}</div>
			<div data-testid="show-rooignored-files">{JSON.stringify(showShoferIgnoredFiles)}</div>
			<button data-testid="update-button" onClick={() => setAllowedCommands(["npm install", "git status"])}>
				Update Commands
			</button>
			<button
				data-testid="toggle-rooignore-button"
				onClick={() => setShowShoferIgnoredFiles(!showShoferIgnoredFiles)}>
				Update Commands
			</button>
		</div>
	)
}

const ApiConfigTestComponent = () => {
	const { apiConfiguration, setApiConfiguration } = useExtensionState()

	return (
		<div>
			<div data-testid="api-configuration">{JSON.stringify(apiConfiguration)}</div>
			<button
				data-testid="update-api-config-button"
				onClick={() => setApiConfiguration({ apiModelId: "new-model", apiProvider: "anthropic" })}>
				Update API Config
			</button>
			<button data-testid="partial-update-button" onClick={() => setApiConfiguration({ modelTemperature: 0.7 })}>
				Partial Update
			</button>
		</div>
	)
}

const HasMoreTestComponent = () => {
	const { hasMoreShoferMessages, currentTaskId } = useExtensionState()
	return (
		<div>
			<div data-testid="has-more">{JSON.stringify(hasMoreShoferMessages)}</div>
			<div data-testid="current-task">{JSON.stringify(currentTaskId)}</div>
		</div>
	)
}

const postStateInit = (state: Partial<ExtensionState>) => {
	window.dispatchEvent(new MessageEvent("message", { data: { type: "stateInit", state } }))
}

describe("hasMoreShoferMessages windowing stickiness (H24)", () => {
	const renderHasMore = () =>
		render(
			<ExtensionStateContextProvider>
				<HasMoreTestComponent />
			</ExtensionStateContextProvider>,
		)

	it("a full state push cannot flip the windowing flag true→false for the same task", () => {
		renderHasMore()
		// Cold-load: a long task enters windowed (tail only).
		act(() => postStateInit({ currentTaskId: "t1", hasMoreShoferMessages: true }))
		expect(screen.getByTestId("has-more").textContent).toBe("true")
		// Routine full push for the SAME task carries a spurious false (host emits
		// `currentTask?.hasMoreShoferMessages ?? false` when momentarily unresolved).
		// This used to drop the synthetic header + remount Virtuoso on every append.
		act(() => postStateInit({ currentTaskId: "t1", hasMoreShoferMessages: false }))
		expect(screen.getByTestId("has-more").textContent).toBe("true")
	})

	it("clears windowing on a genuine task switch", () => {
		renderHasMore()
		act(() => postStateInit({ currentTaskId: "t1", hasMoreShoferMessages: true }))
		expect(screen.getByTestId("has-more").textContent).toBe("true")
		// Different task → adopt its (non-windowed) value.
		act(() => postStateInit({ currentTaskId: "t2", hasMoreShoferMessages: false }))
		expect(screen.getByTestId("has-more").textContent).toBe("false")
	})

	it("still allows cold-load activation false→true on the same task", () => {
		renderHasMore()
		act(() => postStateInit({ currentTaskId: "t1", hasMoreShoferMessages: false }))
		expect(screen.getByTestId("has-more").textContent).toBe("false")
		// Async cold-load completes and reports more-on-disk for the same task.
		act(() => postStateInit({ currentTaskId: "t1", hasMoreShoferMessages: true }))
		expect(screen.getByTestId("has-more").textContent).toBe("true")
	})
})

describe("ExtensionStateContext", () => {
	it("initializes with empty allowedCommands array", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual([])
	})

	it("initializes with soundEnabled set to false", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("sound-enabled").textContent!)).toBe(false)
	})

	it("initializes with showShoferIgnoredFiles set to true", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(true)
	})

	it("updates showShoferIgnoredFiles through setShowShoferIgnoredFiles", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("toggle-rooignore-button").click()
		})

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(false)
	})

	it("updates allowedCommands through setAllowedCommands", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("update-button").click()
		})

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual(["npm install", "git status"])
	})

	it("throws error when used outside provider", () => {
		// Suppress console.error for this test since we expect an error
		const consoleSpy = vi.spyOn(console, "error")
		consoleSpy.mockImplementation(() => {})

		expect(() => {
			render(<TestComponent />)
		}).toThrow("useExtensionState must be used within an ExtensionStateContextProvider")

		consoleSpy.mockRestore()
	})

	it("updates apiConfiguration through setApiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		const initialContent = screen.getByTestId("api-configuration").textContent!
		expect(initialContent).toBeDefined()

		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")

		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: "anthropic",
			}),
		)
	})

	it("correctly merges partial updates to apiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		// First set the initial configuration
		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		// Verify initial update
		const initialContent = screen.getByTestId("api-configuration").textContent!
		const initialConfig = JSON.parse(initialContent || "{}")
		expect(initialConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: "anthropic",
			}),
		)

		// Now perform a partial update
		act(() => {
			screen.getByTestId("partial-update-button").click()
		})

		// Verify that the partial update was merged with the existing configuration
		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")
		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model", // Should retain this from previous update
				apiProvider: "anthropic", // Should retain this from previous update
				modelTemperature: 0.7, // Should add this from partial update
			}),
		)
	})
})

describe("mergeExtensionState", () => {
	it("should correctly merge extension states", () => {
		const baseState: ExtensionState = {
			version: "",
			mcpEnabled: false,
			shoferMessages: [],
			taskHistory: [],
			shouldShowAnnouncement: false,
			enableCheckpoints: true,
			writeDelayMs: 1000,
			mode: "default",
			experiments: {} as Record<ExperimentId, boolean>,
			customModes: [],
			maxOpenTabsContext: 20,
			maxWorkspaceFiles: 100,
			apiConfiguration: { providerId: "openrouter" } as ProviderSettings,
			telemetrySetting: "unset",
			showShoferIgnoredFiles: true,
			enableSubfolderRules: false,
			renderContext: "sidebar",
			cloudUserInfo: null,
			organizationAllowList: { allowAll: true, providers: {} },
			autoCondenseContext: true,
			autoCondenseContextPercent: 100,
			cloudIsAuthenticated: false,
			sharingEnabled: false,
			publicSharingEnabled: false,
			profileThresholds: {},
			hasOpenedModeSelector: false, // Add the new required property
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
			taskSyncEnabled: false,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, // Add the checkpoint timeout property
			maxReadFileLine: -1,
			useAgentRules: false,
		}

		const prevState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxTokens: 1234, modelMaxThinkingTokens: 123 },
			experiments: {} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS - 5,
		}

		const newState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxThinkingTokens: 456, modelTemperature: 0.3 },
			experiments: {
				preventFocusDisruption: false,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
			} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS + 5,
		}

		const result = mergeExtensionState(prevState, newState)

		expect(result.apiConfiguration).toEqual({
			modelMaxThinkingTokens: 456,
			modelTemperature: 0.3,
		})

		expect(result.experiments).toEqual({
			preventFocusDisruption: false,
			imageGeneration: false,
			runSlashCommand: false,
			customTools: false,
		})
	})

	// shoferMessagesSeq protection tests removed — the seq-guard in
	// mergeExtensionState was deleted because it was mechanically dead:
	// postInitState() bumps the counter synchronously before the FIFO
	// postMessage, so the guard condition (newSeq <= prevSeq) was never
	// true. The real protection is the live currentTask.shoferMessages
	// reference with no await before serialization.
})
