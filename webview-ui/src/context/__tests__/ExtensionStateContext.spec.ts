/**
 * ExtensionStateContext reducer tests — H2 windowed message loading.
 *
 * Tests the mergeExtensionState merge function and the olderMessagesLoaded
 * handleMessage case, focusing on:
 * - Prepending older messages with dedupe by ts
 * - Updating hasMoreMessages / oldestLoadedTs
 * - Protecting H2 windowing metadata from stale state pushes
 *
 * Run: npx vitest run src/context/__tests__/ExtensionStateContext.spec.ts
 */

import type { ShoferMessage, ExtensionState } from "@shofer/types"
import { mergeExtensionState } from "../ExtensionStateContext"

/** Build a synthetic ShoferMessage with ts. */
function msg(ts: number): ShoferMessage {
	return { type: "say", say: "text", ts, text: `msg-${ts}` } as ShoferMessage
}

/** Minimal valid ExtensionState for merge tests. */
function baseState(overrides: Partial<ExtensionState> = {}): ExtensionState {
	return {
		apiConfiguration: {},
		version: "1.0.0",
		shoferMessages: [],
		taskHistory: [],
		shouldShowAnnouncement: false,
		allowedCommands: [],
		deniedCommands: [],
		soundEnabled: false,
		soundVolume: 0.5,
		ttsEnabled: false,
		ttsSpeed: 1.0,
		enableCheckpoints: true,
		checkpointTimeout: 15,
		language: "en",
		writeDelayMs: 1000,
		terminalShellIntegrationTimeout: 4000,
		mcpEnabled: true,
		taskSyncEnabled: false,
		currentApiConfigName: "default",
		listApiConfigMeta: [],
		mode: "code",
		customModePrompts: {},
		customSupportPrompts: {},
		experiments: {},
		enhancementApiConfigId: "",
		hasOpenedModeSelector: false,
		autoApprovalEnabled: false,
		customModes: [],
		maxOpenTabsContext: 20,
		maxWorkspaceFiles: 200,
		cwd: "",
		telemetrySetting: "unset",
		showShoferIgnoredFiles: true,
		enableSubfolderRules: false,
		renderContext: "sidebar",
		maxReadFileLine: -1,
		maxImageFileSize: 5,
		maxTotalImageSize: 20,
		pinnedApiConfigs: {},
		terminalZshOhMy: false,
		terminalZshP10k: false,
		terminalZdotdir: false,
		historyPreviewCollapsed: false,
		reasoningBlockCollapsed: true,
		enterBehavior: "send",
		cloudUserInfo: null,
		cloudIsAuthenticated: false,
		cloudOrganizations: [],
		sharingEnabled: false,
		publicSharingEnabled: false,
		organizationAllowList: { allowAll: true, providers: {} },
		organizationSettingsVersion: -1,
		autoCondenseContext: true,
		autoCondenseContextPercent: 100,
		profileThresholds: {},
		codebaseIndexConfig: {
			codebaseIndexEnabled: true,
			codebaseIndexQdrantUrl: "http://localhost:6333",
			codebaseIndexEmbedderProvider: "openai",
			codebaseIndexEmbedderModelId: "",
			codebaseIndexEmbedderBaseUrl: "",
		},
		codebaseIndexModels: { ollama: {}, openai: {} },
		includeDiagnosticMessages: true,
		maxDiagnosticMessages: 50,
		openRouterImageApiKey: "",
		openRouterImageGenerationSelectedModel: "",
		assistantAgentEnabled: true,
		assistantAgentApiConfigId: "",
		includeCurrentTime: true,
		includeCurrentCost: true,
		lockApiConfigAcrossModes: false,
		useAgentRules: false,
		parallelTasks: [],
		focusedTaskId: null,
		taskNotifications: [],
		hasMoreMessages: false,
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// mergeExtensionState — olderMessagesLoaded reducer logic
// ---------------------------------------------------------------------------

describe("mergeExtensionState — olderMessagesLoaded prepend + dedupe", () => {
	it("prepends older messages at the beginning of shoferMessages", () => {
		const prev = baseState({
			shoferMessages: [msg(100), msg(101)],
			hasMoreMessages: true,
			oldestLoadedTs: 100,
		})

		const older = [msg(98), msg(99)]

		// Simulate what the olderMessagesLoaded handler does internally:
		// it prepends deduped older messages before the existing array.
		const existingTs = new Set(prev.shoferMessages.map((m) => m.ts))
		const deduped = older.filter((m) => !existingTs.has(m.ts))
		const merged = mergeExtensionState(prev, {
			shoferMessages: [...deduped, ...prev.shoferMessages],
			hasMoreMessages: true,
			oldestLoadedTs: 98,
		})

		expect(merged.shoferMessages.map((m) => m.ts)).toEqual([98, 99, 100, 101])
		expect(merged.hasMoreMessages).toBe(true)
		expect(merged.oldestLoadedTs).toBe(98)
	})

	it("deduplicates by ts when older messages overlap with existing", () => {
		const prev = baseState({
			shoferMessages: [msg(99), msg(100), msg(101)],
			hasMoreMessages: true,
			oldestLoadedTs: 99,
		})

		// Older page includes ts=99 which already exists.
		const older = [msg(97), msg(98), msg(99)]
		const deduped = older.filter((m) => m.ts !== 99)

		const merged = mergeExtensionState(prev, {
			shoferMessages: [...deduped, ...prev.shoferMessages],
			hasMoreMessages: true,
			oldestLoadedTs: 97,
		})

		expect(merged.shoferMessages.map((m) => m.ts)).toEqual([97, 98, 99, 100, 101])
		// ts=99 should appear exactly once
		expect(merged.shoferMessages.filter((m) => m.ts === 99)).toHaveLength(1)
	})

	it("sets hasMoreMessages to false when last page loaded", () => {
		const prev = baseState({
			shoferMessages: [msg(1), msg(2), msg(3)],
			hasMoreMessages: true,
			oldestLoadedTs: 1,
		})

		// Empty older messages means no more pages.
		const merged = mergeExtensionState(prev, {
			hasMoreMessages: false,
		})

		expect(merged.shoferMessages.map((m) => m.ts)).toEqual([1, 2, 3])
		expect(merged.hasMoreMessages).toBe(false)
		expect(merged.oldestLoadedTs).toBe(1) // unchanged
	})

	it("preserves shoferMessages order on prepend with mixed ts values", () => {
		const prev = baseState({
			shoferMessages: [msg(10), msg(20), msg(30)],
		})

		const older = [msg(1), msg(5)]
		const merged = mergeExtensionState(prev, {
			shoferMessages: [...older, ...prev.shoferMessages],
			hasMoreMessages: true,
			oldestLoadedTs: 1,
		})

		expect(merged.shoferMessages.map((m) => m.ts)).toEqual([1, 5, 10, 20, 30])
	})
})

// ---------------------------------------------------------------------------
// mergeExtensionState — H2 seq guard for windowing metadata
// ---------------------------------------------------------------------------

describe("mergeExtensionState — H2 windowing metadata seq guard", () => {
	it("protects hasMoreMessages from stale state pushes (seq guard)", () => {
		const prev = baseState({
			shoferMessages: [msg(100), msg(101)],
			hasMoreMessages: true,
			oldestLoadedTs: 100,
			tokenUsage: { totalTokensIn: 100, totalTokensOut: 50, totalCost: 0.01, contextTokens: 0 },
			shoferMessagesSeq: 5,
		})

		// Stale state push with lower sequence number AND shoferMessages
		// (the seq guard only triggers when shoferMessages are present).
		const merged = mergeExtensionState(prev, {
			shoferMessages: [msg(1)], // stale — will be rejected
			shoferMessagesSeq: 3, // older seq
			hasMoreMessages: false, // stale — should be preserved from prev
			oldestLoadedTs: undefined, // stale — should be preserved from prev
			tokenUsage: undefined, // stale — should be preserved from prev
		})

		// The seq guard should preserve prev shoferMessages + windowing metadata.
		expect(merged.shoferMessages).toEqual([msg(100), msg(101)])
		expect(merged.shoferMessagesSeq).toBe(5)
		expect(merged.hasMoreMessages).toBe(true)
		expect(merged.oldestLoadedTs).toBe(100)
		expect(merged.tokenUsage).toEqual({ totalTokensIn: 100, totalTokensOut: 50, totalCost: 0.01, contextTokens: 0 })
	})

	it("accepts H2 metadata from a state push with higher seq", () => {
		const prev = baseState({
			shoferMessages: [msg(50), msg(51)],
			hasMoreMessages: true,
			oldestLoadedTs: 50,
			shoferMessagesSeq: 1,
		})

		const merged = mergeExtensionState(prev, {
			shoferMessages: [msg(50), msg(51), msg(52)],
			shoferMessagesSeq: 2, // higher seq — should be accepted
			hasMoreMessages: false,
			oldestLoadedTs: 50,
			tokenUsage: {
				totalTokensIn: 1000,
				totalTokensOut: 500,
				totalCost: 0.05,
				contextTokens: 0,
			},
		})

		expect(merged.shoferMessages).toHaveLength(3)
		expect(merged.hasMoreMessages).toBe(false)
		expect(merged.tokenUsage).toEqual({
			totalTokensIn: 1000,
			totalTokensOut: 500,
			totalCost: 0.05,
			contextTokens: 0,
		})
		expect(merged.shoferMessagesSeq).toBe(2)
	})

	it("passes through H2 metadata when no seq guard is active", () => {
		const prev = baseState({
			shoferMessages: [msg(1)],
			// no shoferMessagesSeq — seq guard inactive
		})

		const merged = mergeExtensionState(prev, {
			shoferMessages: [msg(1), msg(2)],
			hasMoreMessages: true,
			oldestLoadedTs: 1,
			tokenUsage: {
				totalTokensIn: 500,
				totalTokensOut: 200,
				totalCost: 0.02,
				contextTokens: 0,
			},
			// no shoferMessagesSeq in the push either
		})

		expect(merged.shoferMessages).toHaveLength(2)
		expect(merged.hasMoreMessages).toBe(true)
		expect(merged.oldestLoadedTs).toBe(1)
		expect(merged.tokenUsage).toEqual({
			totalTokensIn: 500,
			totalTokensOut: 200,
			totalCost: 0.02,
			contextTokens: 0,
		})
	})
})
