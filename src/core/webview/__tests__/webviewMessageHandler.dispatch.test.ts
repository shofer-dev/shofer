// npx vitest src/core/webview/__tests__/webviewMessageHandler.dispatch.test.ts

/**
 * The central webview→host dispatcher, driven the way the webview drives it: one
 * typed `WebviewMessage` in, one observable effect out. Per the Webview Message
 * Routing Rule this switch is the ONLY place a `message.type` is branched on, so
 * it is also the only place these behaviours can be pinned.
 *
 * The cases grouped here are the ones whose whole content is a decision:
 *
 *  - the settings writes, which must go through `ContextProxy` (Typed Settings
 *    Rule) and not `context.globalState`;
 *  - `updateVSCodeSetting` / `getVSCodeSetting`, the ONE sanctioned ad-hoc
 *    `workspace.getConfiguration()` bypass (No Ad-Hoc VS Code Config Reads Rule)
 *    — and therefore the one that must refuse a setting outside
 *    `ALLOWED_VSCODE_SETTINGS`;
 *  - the delegating cases, whose only job is to reach the right collaborator with
 *    the right arguments; and
 *  - the refusal paths — no current task, missing id, malformed payload — which
 *    are what a user experiences as "the button does nothing" when they regress.
 *
 * Anything requiring a real `Task`, a real McpHub or the router-model catalogs is
 * covered by the sibling specs; this file deliberately stays on the dispatcher.
 */

import type { WebviewMessage } from "@shofer/types"

const hoisted = vi.hoisted(() => ({
	notifier: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		showChoice: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
	},
	executeCommand: vi.fn(async () => undefined),
	openExternal: vi.fn(async () => true),
	openTextDocument: vi.fn(async (p: string) => ({ uri: { fsPath: p } })),
	configurationGet: vi.fn((key: string) => `value-of-${key}`),
	configurationUpdate: vi.fn(async () => undefined),
	workspaceFolders: [{ uri: { fsPath: "/workspace" } }] as unknown,
	readFile: vi.fn(async () => "file contents"),
	writeFile: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	mkdir: vi.fn(async () => undefined),
	openFile: vi.fn(async () => undefined),
	openImage: vi.fn(async () => undefined),
	saveImage: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	selectImages: vi.fn(async () => ["data:image/png;base64,AA"]),
	playTts: vi.fn(),
	stopTts: vi.fn(),
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
	skills: {
		handleRequestSkills: vi.fn(async () => undefined),
		handleCreateSkill: vi.fn(async () => undefined),
		handleDeleteSkill: vi.fn(async () => undefined),
		handleMoveSkill: vi.fn(async () => undefined),
		handleUpdateSkillModes: vi.fn(async () => undefined),
		handleOpenSkillFile: vi.fn(async () => undefined),
	},
	generateErrorDiagnostics: vi.fn(async () => ({ success: true })),
	getCommands: vi.fn(async () => [] as unknown[]),
	openMention: vi.fn(),
	isPathOutsideWorkspace: vi.fn(() => false),
	resolveTaskCwd: vi.fn(async () => "/workspace/worktree"),
	safeWriteJson: vi.fn(async () => undefined),
	fileExists: vi.fn(async () => true),
	captureTabShown: vi.fn(),
	captureModeSettingChanged: vi.fn(),
	captureCustomModeCreated: vi.fn(),
	captureTelemetrySettingsChanged: vi.fn(),
	updateTelemetryState: vi.fn(),
	getTaskLogs: vi.fn(() => ["line one"]),
	importSettingsWithFeedback: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	enhanceMessage: vi.fn(
		async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
			success: true,
			enhancedText: "better",
		}),
	),
	generateSystemPrompt: vi.fn(async (..._args: unknown[]): Promise<string> => "SYSTEM PROMPT"),
	clipboardWrite: vi.fn(async () => undefined),
	searchCommits: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
	loadFromDirectories: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	getSlashCommand: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	unlink: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	access: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	showTextDocument: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	getAccessToken: vi.fn(async (): Promise<string | null> => "token-1"),
	getAccountId: vi.fn(async (): Promise<string | null> => "acct-1"),
	fetchRateLimits: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ fetchedAt: 1 })),
	startAuthorizationFlow: vi.fn(() => "https://auth.openai.com/authorize"),
	waitForCallback: vi.fn(async () => ({})),
	clearCredentials: vi.fn(async () => undefined),
	getModels: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({})),
	flushModels: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	getOpenAiModels: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({})),
	getVsCodeLmModels: vi.fn(async (): Promise<unknown[]> => []),
	showSaveDialog: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	showOpenDialog: vi.fn(async (..._args: unknown[]): Promise<unknown[] | undefined> => undefined),
	getTheme: vi.fn(async (): Promise<unknown> => ({ name: "dark" })),
	exportSettings: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
}))

vi.mock("vscode", () => ({
	commands: { executeCommand: hoisted.executeCommand },
	env: { openExternal: hoisted.openExternal, clipboard: { writeText: hoisted.clipboardWrite } },
	Uri: { file: (p: string) => ({ fsPath: p, path: p }), parse: (v: string) => ({ value: v }) },
	workspace: {
		get workspaceFolders() {
			return hoisted.workspaceFolders
		},
		getConfiguration: () => ({ get: hoisted.configurationGet, update: hoisted.configurationUpdate }),
		openTextDocument: hoisted.openTextDocument,
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showTextDocument: hoisted.showTextDocument,
		showSaveDialog: hoisted.showSaveDialog,
		showOpenDialog: hoisted.showOpenDialog,
	},
}))

vi.mock("../../../integrations/theme/getTheme", () => ({ getTheme: hoisted.getTheme }))

vi.mock("fs/promises", () => {
	const api = {
		readFile: hoisted.readFile,
		writeFile: hoisted.writeFile,
		mkdir: hoisted.mkdir,
		unlink: hoisted.unlink,
		access: hoisted.access,
	}
	return { default: api, ...api }
})

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({ notifier: hoisted.notifier }),
}))

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		hasInstance: () => true,
		instance: {
			captureTabShown: hoisted.captureTabShown,
			captureModeSettingChanged: hoisted.captureModeSettingChanged,
			captureCustomModeCreated: hoisted.captureCustomModeCreated,
			captureTelemetrySettingsChanged: hoisted.captureTelemetrySettingsChanged,
			updateTelemetryState: hoisted.updateTelemetryState,
		},
	},
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	getCommands: hoisted.getCommands,
	getTaskLogs: hoisted.getTaskLogs,
	openMention: hoisted.openMention,
	isPathOutsideWorkspace: hoisted.isPathOutsideWorkspace,
	safeWriteJson: hoisted.safeWriteJson,
	getWorkspacePath: () => "/workspace",
	searchCommits: hoisted.searchCommits,
	getModels: hoisted.getModels,
	flushModels: hoisted.flushModels,
	getOpenAiModels: hoisted.getOpenAiModels,
	getSlashCommand: hoisted.getSlashCommand,
	getRooDirectoriesForCwd: () => ["/workspace/.shofer"],
	customToolRegistry: { loadFromDirectories: hoisted.loadFromDirectories, getAllSerialized: () => [] },
	getTaskDirectoryPath: async () => "/global/tasks/task-1",
	t: (key: string) => key,
}))

vi.mock("../messageEnhancer", () => ({
	MessageEnhancer: { enhanceMessage: hoisted.enhanceMessage, captureTelemetry: vi.fn() },
}))

vi.mock("../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		getAccessToken: hoisted.getAccessToken,
		getAccountId: hoisted.getAccountId,
		startAuthorizationFlow: hoisted.startAuthorizationFlow,
		waitForCallback: hoisted.waitForCallback,
		clearCredentials: hoisted.clearCredentials,
	},
}))

vi.mock("../../../integrations/openai-codex/rate-limits", () => ({
	fetchOpenAiCodexRateLimitInfo: hoisted.fetchRateLimits,
}))

vi.mock("../../../api/providers/vscode-lm", () => ({ getVsCodeLmModels: hoisted.getVsCodeLmModels }))

vi.mock("../../../integrations/misc/open-file", () => ({ openFile: hoisted.openFile }))
vi.mock("../../../integrations/misc/image-handler", () => ({
	openImage: hoisted.openImage,
	saveImage: hoisted.saveImage,
}))
vi.mock("../../../integrations/misc/process-images", () => ({ selectImages: hoisted.selectImages }))
vi.mock("../../../utils/tts", () => ({
	playTts: hoisted.playTts,
	stopTts: hoisted.stopTts,
	setTtsEnabled: hoisted.setTtsEnabled,
	setTtsSpeed: hoisted.setTtsSpeed,
}))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: hoisted.fileExists }))
vi.mock("../skillsMessageHandler", () => hoisted.skills)
vi.mock("../diagnosticsHandler", () => ({ generateErrorDiagnostics: hoisted.generateErrorDiagnostics }))
vi.mock("../resolveTaskCwd", () => ({ resolveTaskCwd: hoisted.resolveTaskCwd }))
vi.mock("../generateSystemPrompt", () => ({ generateSystemPrompt: hoisted.generateSystemPrompt }))
vi.mock("../../config/importExport", () => ({
	importSettingsWithFeedback: hoisted.importSettingsWithFeedback,
	exportSettings: hoisted.exportSettings,
}))

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ShoferProvider } from "../ShoferProvider"

type Harness = {
	provider: ShoferProvider
	posted: () => Array<Record<string, unknown>>
	state: Record<string, unknown>
	setValue: ReturnType<typeof vi.fn>
	log: ReturnType<typeof vi.fn>
	task: ReturnType<typeof makeTask> | undefined
	mcpHub: ReturnType<typeof makeMcpHub>
	settingsManager: ReturnType<typeof makeSettingsManager>
	customModesManager: ReturnType<typeof makeCustomModesManager>
	taskManager: { registerBackgroundTask: ReturnType<typeof vi.fn>; getManagedTaskInstance: ReturnType<typeof vi.fn> }
}

function makeTask(): Record<string, any> {
	return {
		taskId: "task-1",
		abort: false,
		cwd: "/workspace",
		shoferMessages: [] as unknown[],
		apiConversationHistory: [] as unknown[],
		getTaskMode: vi.fn(async () => "code"),
		cancelAutoApprovalTimeout: vi.fn(),
		cancelAndProcessQueuedMessages: vi.fn(async () => undefined),
		handleWebviewAskResponse: vi.fn(),
		getBlobStore: vi.fn(async () => ({ read: async () => "blob body" })),
		messageQueueService: { addMessage: vi.fn(), removeMessage: vi.fn(), updateMessage: vi.fn() },
		updateApiConfiguration: vi.fn(),
		setTaskApiConfigName: vi.fn(),
		instanceId: 1,
		handleTerminalOperation: vi.fn(),
		trustOutsideWorkspacePath: vi.fn(),
		invalidateCostLimitCache: vi.fn(),
		costLimit: undefined as number | undefined,
		parentTask: undefined as ReturnType<typeof makeTask> | undefined,
	}
}

function makeMcpHub() {
	return {
		getMcpSettingsFilePath: vi.fn(async () => "/global/mcp.json"),
		deleteServer: vi.fn(async () => undefined),
		restartConnection: vi.fn(async () => undefined),
		toggleToolEnabledForPrompt: vi.fn(async () => undefined),
		toggleServerDisabled: vi.fn(async () => undefined),
		refreshAllConnections: vi.fn(async () => undefined),
		handleMcpEnabledChange: vi.fn(async () => undefined),
		updateServerTimeout: vi.fn(async () => undefined),
		setToolGroup: vi.fn(async () => undefined),
		updateServerConfigFromUI: vi.fn(async () => undefined),
		getAllServers: vi.fn(() => [] as unknown[]),
	}
}

function makeCustomModesManager() {
	return {
		getCustomModesFilePath: vi.fn(async () => "/global/modes.yaml"),
		getCustomModes: vi.fn(async () => [] as Array<Record<string, unknown>>),
		updateCustomMode: vi.fn(async () => undefined),
		deleteCustomMode: vi.fn(async () => undefined),
		checkRulesDirectoryHasContent: vi.fn(async () => true),
		exportModeWithRules: vi.fn(
			async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
				success: true,
				yaml: "slug: code\n",
			}),
		),
		importModeWithRules: vi.fn(
			async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
				success: true,
				slug: "imported",
			}),
		),
	}
}

function makeSettingsManager() {
	return {
		saveConfig: vi.fn(async () => "cfg-1"),
		deleteConfig: vi.fn(async () => undefined),
		listConfig: vi.fn(async () => [{ id: "1", name: "prod" }]),
		getProfile: vi.fn(async () => ({ id: "profile-id", name: "prod", apiProvider: "anthropic" })),
	}
}

function makeHarness(overrides: Partial<Record<string, unknown>> = {}): Harness {
	const state: Record<string, unknown> = {}
	const postedMessages: Array<Record<string, unknown>> = []
	const task = (overrides.task as ReturnType<typeof makeTask> | undefined) ?? undefined
	const mcpHub = makeMcpHub()
	const settingsManager = makeSettingsManager()
	const customModesManager = makeCustomModesManager()
	const setValue = vi.fn(async (key: string, value: unknown) => {
		state[key] = value
	})
	const log = vi.fn()
	const taskManager = {
		registerBackgroundTask: vi.fn(),
		getManagedTaskInstance: vi.fn(() => task),
		getFocusedTaskId: vi.fn(() => (overrides.focusedTaskId as string | null) ?? null),
	}

	const provider = {
		cwd: "/workspace",
		contextProxy: {
			getValue: (key: string) => state[key],
			setValue,
			getWriteScopeValue: vi.fn(async (key: string) => state[key]),
			globalStorageUri: { fsPath: "/global" },
		},
		context: {
			globalState: { update: vi.fn(async () => undefined) },
			workspaceState: { update: vi.fn(async () => undefined) },
		},
		log,
		debug: vi.fn(),
		postMessageToWebview: vi.fn(async (m: Record<string, unknown>) => {
			postedMessages.push(m)
		}),
		postInitState: vi.fn(async () => undefined),
		postConfigUpdate: vi.fn(),
		getState: vi.fn(async () => ({ mode: "code", apiConfiguration: {}, ...(overrides.stateValue as object) })),
		getCurrentTask: vi.fn(() => task),
		getMcpHub: vi.fn(() => (overrides.noMcpHub ? undefined : mcpHub)),
		getSkillsManager: vi.fn(() => overrides.skillsManager),
		getModes: vi.fn(async () => [{ slug: "code" }]),
		getManagedTasks: vi.fn(() => (overrides.managedTasks as unknown[]) ?? []),
		getTaskNotifications: vi.fn(() => (overrides.taskNotifications as unknown[]) ?? []),
		pushPluginUiContributions: vi.fn(async () => undefined),
		workspaceTracker: { initializeFilePaths: vi.fn() },
		getStateToPostToWebview: vi.fn(async () => ({ telemetrySetting: "enabled" })),
		isViewLaunched: false,
		customModesManager,
		providerSettingsManager: settingsManager,
		upsertProviderProfile: vi.fn(async () => "cfg-1"),
		activateProviderProfile: vi.fn(async () => undefined),
		setDefaultApiConfiguration: vi.fn(async () => undefined),
		loadApiConfigurationForEdit: vi.fn(async () => undefined),
		setModeApiConfig: vi.fn(async () => undefined),
		cancelTask: vi.fn(async () => undefined),
		clearTask: vi.fn(async () => undefined),
		latestAnnouncementId: "announcement-1",
		updateCustomInstructions: vi.fn(async () => undefined),
		loadOlderShoferMessages: vi.fn(async () => undefined),
		condenseTaskContext: vi.fn(async () => undefined),
		deleteTaskWithId: vi.fn(async () => undefined),
		exportTaskWithId: vi.fn(async () => undefined),
		exportTaskWithIdJson: vi.fn(async () => undefined),
		getTaskWithId: vi.fn(async (id: string) => ({ historyItem: { id } })),
		getTaskWithAggregatedCosts: vi.fn(async (id: string) => ({
			historyItem: { id },
			aggregatedCosts: { totalCost: 1 },
		})),
		getTaskInteractions: vi.fn(async () => []),
		updateTaskHistory: vi.fn(async () => []),
		handlePluginRequest: vi.fn(async () => undefined),
		handlePluginUiMessage: vi.fn(async () => undefined),
		resetState: vi.fn(async () => undefined),
		handleUserModeSwitch: vi.fn(async () => undefined),
		createManagedTask: vi.fn(async () => undefined),
		focusTask: vi.fn(async () => undefined),
		startManagedTask: vi.fn(async () => undefined),
		pauseManagedTask: vi.fn(async () => undefined),
		resumeManagedTask: vi.fn(async () => undefined),
		stopManagedTask: vi.fn(async () => undefined),
		renameManagedTask: vi.fn(),
		deleteManagedTask: vi.fn(async () => undefined),
		archiveManagedTask: vi.fn(async () => undefined),
		unarchiveManagedTask: vi.fn(async () => undefined),
		pinManagedTask: vi.fn(async () => undefined),
		unpinManagedTask: vi.fn(async () => undefined),
		clearTaskNotification: vi.fn(),
		popFromStackWithoutAborting: vi.fn(() => overrides.poppedTask),
		refreshWorkspace: vi.fn(async () => undefined),
		refreshWebview: vi.fn(async () => undefined),
		setLogsWatchTaskId: vi.fn(),
		taskManager,
		_onWebviewLaunched: vi.fn(),
		_onFatalError: vi.fn(async () => undefined),
		_recordPong: vi.fn(),
	} as unknown as ShoferProvider

	return {
		provider,
		posted: () => postedMessages,
		state,
		setValue,
		log,
		task,
		mcpHub,
		settingsManager,
		customModesManager,
		taskManager,
	}
}

/** Drive one message through the dispatcher. */
async function dispatch(harness: Harness, message: Record<string, unknown>) {
	await webviewMessageHandler(harness.provider, message as unknown as WebviewMessage)
}

function postedOfType(harness: Harness, type: string) {
	return harness.posted().filter((m) => m.type === type)
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.workspaceFolders = [{ uri: { fsPath: "/workspace" } }]
	hoisted.isPathOutsideWorkspace.mockReturnValue(false)
	hoisted.readFile.mockResolvedValue("file contents")
	hoisted.getCommands.mockResolvedValue([])
	hoisted.enhanceMessage.mockResolvedValue({ success: true, enhancedText: "better" })
	hoisted.generateSystemPrompt.mockResolvedValue("SYSTEM PROMPT")
	hoisted.searchCommits.mockResolvedValue([])
	hoisted.loadFromDirectories.mockResolvedValue(undefined)
	hoisted.getSlashCommand.mockResolvedValue(undefined)
	hoisted.access.mockResolvedValue(undefined)
	hoisted.unlink.mockResolvedValue(undefined)
	hoisted.getAccessToken.mockResolvedValue("token-1")
	hoisted.getAccountId.mockResolvedValue("acct-1")
	hoisted.fetchRateLimits.mockResolvedValue({ fetchedAt: 1 })
	hoisted.startAuthorizationFlow.mockReturnValue("https://auth.openai.com/authorize")
	hoisted.clearCredentials.mockResolvedValue(undefined)
	hoisted.getModels.mockResolvedValue({})
	hoisted.flushModels.mockResolvedValue(undefined)
	hoisted.getOpenAiModels.mockResolvedValue({})
	hoisted.getVsCodeLmModels.mockResolvedValue([])
	hoisted.showSaveDialog.mockResolvedValue(undefined)
	hoisted.captureTelemetrySettingsChanged.mockImplementation(() => undefined)
	hoisted.updateTelemetryState.mockImplementation(() => undefined)
})

describe("unknown message types", () => {
	it("fall through the default branch without throwing", async () => {
		const harness = makeHarness()
		await expect(dispatch(harness, { type: "somethingNobodyHandles" })).resolves.toBeUndefined()
		expect(harness.posted()).toEqual([])
	})
})

describe("logging and liveness", () => {
	it("webviewLog mirrors the line to the output channel", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "webviewLog", text: "hello" })
		expect(harness.provider.debug).toHaveBeenCalledWith("[webview] hello")
	})

	it("webviewLog routes a [scroll:…] line to the Scroll category and still debugs it", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "webviewLog", text: "[scroll:top] at 0" })
		expect(harness.provider.debug).toHaveBeenCalledWith("[webview] [scroll:top] at 0")
	})

	it("webviewLog tolerates a missing text", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "webviewLog" })
		expect(harness.provider.debug).toHaveBeenCalledWith("[webview] ")
	})

	it("pong records liveness and nothing else", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "pong" })
		expect(harness.provider._recordPong).toHaveBeenCalled()
	})

	it("fatal_error logs the renderer's message and triggers an explicit reset", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "fatal_error", text: "render crash" })
		expect(harness.log).toHaveBeenCalledWith("[fatal_error] render crash")
		expect(harness.provider._onFatalError).toHaveBeenCalledWith("render crash")
	})

	it("fatal_error substitutes a placeholder when the renderer sent no text", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "fatal_error" })
		expect(harness.provider._onFatalError).toHaveBeenCalledWith("(no message)")
	})
})

describe("requestTaskLogs", () => {
	it("sets the watch and returns the buffered snapshot for the requested task", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "requestTaskLogs", taskId: "task-9" })

		expect(harness.provider.setLogsWatchTaskId).toHaveBeenCalledWith("task-9")
		expect(postedOfType(harness, "taskLogs")[0]).toEqual({
			type: "taskLogs",
			taskLogTaskId: "task-9",
			taskLogs: ["line one"],
		})
	})

	it("CLEARS the watch and posts nothing when the webview asks for no task", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "requestTaskLogs" })

		expect(harness.provider.setLogsWatchTaskId).toHaveBeenCalledWith(undefined)
		expect(postedOfType(harness, "taskLogs")).toEqual([])
	})
})

describe("getBlobContent", () => {
	const sha = "a".repeat(64)

	it("refuses a non-sha256 reference with an error payload, never silence", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "getBlobContent", sha256: "nope" })

		expect(postedOfType(harness, "blobContent")[0].blob).toEqual({
			sha256: "nope",
			bytes: 0,
			error: "invalid sha256",
		})
	})

	it("reports a missing sha as an empty reference rather than crashing", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "getBlobContent" })

		expect(postedOfType(harness, "blobContent")[0].blob).toEqual({ sha256: "", bytes: 0, error: "invalid sha256" })
	})

	it("reports 'no active task' when there is no task holding a blob store", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "getBlobContent", sha256: sha })

		expect(postedOfType(harness, "blobContent")[0].blob).toEqual({ sha256: sha, bytes: 0, error: "no active task" })
	})

	it("returns the content with its BYTE length, not its character length", async () => {
		const task = makeTask()
		task.getBlobStore = vi.fn(async () => ({ read: async () => "héllo" })) as never
		const harness = makeHarness({ task })

		await dispatch(harness, { type: "getBlobContent", sha256: sha })

		expect(postedOfType(harness, "blobContent")[0].blob).toEqual({
			sha256: sha,
			bytes: Buffer.byteLength("héllo", "utf8"),
			content: "héllo",
		})
	})

	it("reports 'not found' when the store has no such blob", async () => {
		const task = makeTask()
		task.getBlobStore = vi.fn(async () => ({ read: async () => undefined })) as never
		const harness = makeHarness({ task })

		await dispatch(harness, { type: "getBlobContent", sha256: sha })

		expect(postedOfType(harness, "blobContent")[0].blob).toEqual({ sha256: sha, bytes: 0, error: "not found" })
	})

	it("surfaces a store failure as the error payload", async () => {
		const task = makeTask()
		task.getBlobStore = vi.fn(async () => {
			throw new Error("store offline")
		}) as never
		const harness = makeHarness({ task })

		await dispatch(harness, { type: "getBlobContent", sha256: sha })

		expect(postedOfType(harness, "blobContent")[0].blob).toMatchObject({ error: "store offline" })
	})
})

describe("pushMetrics validates at the trust boundary", () => {
	it("rejects a malformed push instead of recording garbage", async () => {
		const harness = makeHarness()
		await expect(
			dispatch(harness, { type: "pushMetrics", metrics: { histograms: "nope" } }),
		).resolves.toBeUndefined()
	})

	it("accepts a well-formed push", async () => {
		const harness = makeHarness()
		await expect(
			dispatch(harness, {
				type: "pushMetrics",
				metrics: { histograms: [{ name: "h", value: 3 }], counters: [{ name: "c", value: 1 }] },
			}),
		).resolves.toBeUndefined()
	})
})

describe("settings writes go through ContextProxy", () => {
	it.each([
		["autoApprovalEnabled", { type: "autoApprovalEnabled", bool: true }, "autoApprovalEnabled", true],
		["autoApprovalEnabled default", { type: "autoApprovalEnabled" }, "autoApprovalEnabled", false],
		["hasOpenedModeSelector", { type: "hasOpenedModeSelector", bool: false }, "hasOpenedModeSelector", false],
		["hasOpenedModeSelector default", { type: "hasOpenedModeSelector" }, "hasOpenedModeSelector", true],
		["enhancementApiConfigId", { type: "enhancementApiConfigId", text: "cfg" }, "enhancementApiConfigId", "cfg"],
		["ttsEnabled", { type: "ttsEnabled", bool: false }, "ttsEnabled", false],
		["ttsSpeed", { type: "ttsSpeed", value: 2 }, "ttsSpeed", 2],
	])("%s persists and re-broadcasts", async (_name, message, key, value) => {
		const harness = makeHarness()

		await dispatch(harness, message as Record<string, unknown>)

		expect(harness.setValue).toHaveBeenCalledWith(key, value)
		expect(harness.provider.postConfigUpdate).toHaveBeenCalledWith(key, value)
	})

	it("ttsEnabled/ttsSpeed also push the value into the speaker", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "ttsEnabled", bool: true })
		await dispatch(harness, { type: "ttsSpeed" })

		expect(hoisted.setTtsEnabled).toHaveBeenCalledWith(true)
		expect(hoisted.setTtsSpeed).toHaveBeenCalledWith(1.0)
	})

	it("lockApiConfigAcrossModes is WORKSPACE state, not global", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "lockApiConfigAcrossModes", bool: true })

		expect(harness.provider.context.workspaceState.update).toHaveBeenCalledWith("lockApiConfigAcrossModes", true)
		expect(harness.provider.postConfigUpdate).toHaveBeenCalledWith("lockApiConfigAcrossModes", true)
	})

	it.each([
		["allowedCommands", "allowedCommands"],
		["deniedCommands", "deniedCommands"],
	])("%s drops blanks and non-strings before persisting", async (type, key) => {
		const harness = makeHarness()

		await dispatch(harness, { type, commands: ["npm test", "  ", "", 42, null, "ls"] })

		expect(harness.setValue).toHaveBeenCalledWith(key, ["npm test", "ls"])
	})

	it.each(["allowedCommands", "deniedCommands"])("%s treats a non-array payload as empty", async (type) => {
		const harness = makeHarness()

		await dispatch(harness, { type, commands: "rm -rf /" })

		expect(harness.setValue).toHaveBeenCalledWith(type, [])
	})
})

describe("toggleApiConfigPin", () => {
	it("pins a profile that is not pinned", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "toggleApiConfigPin", text: "gpt" })

		expect(harness.setValue).toHaveBeenCalledWith("pinnedApiConfigs", { gpt: true })
	})

	it("UNPINS by deleting the key, not by storing false", async () => {
		const harness = makeHarness()
		harness.state.pinnedApiConfigs = { gpt: true, claude: true }

		await dispatch(harness, { type: "toggleApiConfigPin", text: "gpt" })

		expect(harness.setValue).toHaveBeenCalledWith("pinnedApiConfigs", { claude: true })
	})

	it("ignores a pin toggle with no profile name", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "toggleApiConfigPin" })

		expect(harness.setValue).not.toHaveBeenCalled()
	})
})

describe("updatePrompt", () => {
	it("merges the new prompt into the existing map and reports the first changed field", async () => {
		const harness = makeHarness()
		harness.state.customModePrompts = { code: { roleDefinition: "old" } }

		await dispatch(harness, {
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: { roleDefinition: "new" },
		})

		expect(harness.setValue).toHaveBeenCalledWith("customModePrompts", { code: { roleDefinition: "new" } })
		expect(hoisted.captureModeSettingChanged).toHaveBeenCalledWith("roleDefinition")
	})

	it("captures nothing when the prompt did not actually change", async () => {
		const harness = makeHarness()
		harness.state.customModePrompts = { code: { roleDefinition: "same" } }

		await dispatch(harness, { type: "updatePrompt", promptMode: "code", customPrompt: { roleDefinition: "same" } })

		expect(hoisted.captureModeSettingChanged).not.toHaveBeenCalled()
	})

	it("ignores a message with no mode or no prompt", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updatePrompt", promptMode: "code" })
		await dispatch(harness, { type: "updatePrompt", customPrompt: {} })

		expect(harness.setValue).not.toHaveBeenCalled()
	})
})

describe("the VS Code settings bypass is allow-listed", () => {
	it("writes the ONE permitted setting globally", async () => {
		const harness = makeHarness()

		await dispatch(harness, {
			type: "updateVSCodeSetting",
			setting: "terminal.integrated.inheritEnv",
			value: false,
		})

		expect(hoisted.configurationUpdate).toHaveBeenCalledWith("terminal.integrated.inheritEnv", false, true)
	})

	it("REFUSES any other setting, loudly", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateVSCodeSetting", setting: "editor.fontSize", value: 24 })

		expect(hoisted.configurationUpdate).not.toHaveBeenCalled()
		expect(hoisted.notifier.error).toHaveBeenCalledWith(expect.stringContaining("editor.fontSize"))
	})

	it("ignores a write missing either half of the pair", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateVSCodeSetting", setting: "terminal.integrated.inheritEnv" })
		await dispatch(harness, { type: "updateVSCodeSetting", value: false })

		expect(hoisted.configurationUpdate).not.toHaveBeenCalled()
		expect(hoisted.notifier.error).not.toHaveBeenCalled()
	})

	it("reads a setting back to the webview", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "getVSCodeSetting", setting: "editor.fontSize" })

		expect(postedOfType(harness, "vsCodeSetting")[0]).toEqual({
			type: "vsCodeSetting",
			setting: "editor.fontSize",
			value: "value-of-editor.fontSize",
		})
	})

	it("reports a read failure as an error payload rather than throwing", async () => {
		const harness = makeHarness()
		hoisted.configurationGet.mockImplementationOnce(() => {
			throw new Error("no configuration service")
		})

		await dispatch(harness, { type: "getVSCodeSetting", setting: "editor.fontSize" })

		expect(postedOfType(harness, "vsCodeSetting")[0]).toMatchObject({
			error: expect.stringContaining("no configuration service"),
		})
	})

	it("ignores a read with no setting named", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "getVSCodeSetting" })

		expect(postedOfType(harness, "vsCodeSetting")).toEqual([])
	})
})

describe("file and image affordances", () => {
	it("openFile resolves a relative path against the CURRENT TASK's cwd", async () => {
		const task = makeTask()
		task.cwd = "/worktree"
		const harness = makeHarness({ task })

		await dispatch(harness, { type: "openFile", text: "src/a.ts", values: { line: 3 } })

		expect(hoisted.openFile).toHaveBeenCalledWith("/worktree/src/a.ts", { line: 3 })
	})

	it("openFile leaves an absolute path alone", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openFile", text: "/etc/hosts" })

		expect(hoisted.openFile).toHaveBeenCalledWith("/etc/hosts", undefined)
	})

	it("openImage forwards the action values", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openImage", text: "/tmp/a.png", values: { action: "copy" } })

		expect(hoisted.openImage).toHaveBeenCalledWith("/tmp/a.png", { values: { action: "copy" } })
	})

	it("saveImage hands a malformed data URI straight to saveImage so IT reports the error", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "saveImage", dataUri: "nonsense" })

		expect(hoisted.saveImage).toHaveBeenCalledWith("nonsense", expect.objectContaining({ fsPath: "" }))
	})

	it("saveImage defaults to Downloads (never the workspace) and remembers where it landed", async () => {
		const harness = makeHarness()
		hoisted.saveImage.mockResolvedValueOnce({ fsPath: "/home/u/Downloads/img.png" })

		await dispatch(harness, { type: "saveImage", dataUri: "data:image/png;base64,AA" })

		const [, defaultUri] = hoisted.saveImage.mock.calls[0] as [string, { fsPath: string }]
		expect(defaultUri.fsPath).toContain("Downloads")
		expect(harness.setValue).toHaveBeenCalledWith("lastImageSavePath", "/home/u/Downloads/img.png")
	})

	it("saveImage records nothing when the user cancels", async () => {
		const harness = makeHarness()
		hoisted.saveImage.mockResolvedValueOnce(undefined)

		await dispatch(harness, { type: "saveImage", dataUri: "data:image/png;base64,AA" })

		expect(harness.setValue).not.toHaveBeenCalled()
	})

	it("saveImage with no dataUri does nothing at all", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "saveImage" })

		expect(hoisted.saveImage).not.toHaveBeenCalled()
	})

	it("openMention passes the current cwd through", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openMention", text: "@/src/a.ts" })

		expect(hoisted.openMention).toHaveBeenCalledWith("/workspace", "@/src/a.ts")
	})

	it("openExternal opens a url and ignores a message without one", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openExternal", url: "https://example.com" })
		expect(hoisted.openExternal).toHaveBeenCalledWith({ value: "https://example.com" })

		hoisted.openExternal.mockClear()
		await dispatch(harness, { type: "openExternal" })
		expect(hoisted.openExternal).not.toHaveBeenCalled()
	})
})

describe("readFileContent refuses to leave the workspace", () => {
	it("returns the file's content for a path inside the workspace", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "readFileContent", text: "src/a.ts" })

		expect(postedOfType(harness, "fileContent")[0].fileContent).toEqual({
			path: "src/a.ts",
			content: "file contents",
		})
	})

	it("refuses an empty path", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "readFileContent", text: "" })

		expect(postedOfType(harness, "fileContent")[0].fileContent).toMatchObject({ error: "No path provided" })
	})

	it("REFUSES a traversal out of the workspace", async () => {
		const harness = makeHarness()
		hoisted.isPathOutsideWorkspace.mockReturnValue(true)

		await dispatch(harness, { type: "readFileContent", text: "../../etc/passwd" })

		expect(postedOfType(harness, "fileContent")[0].fileContent).toMatchObject({
			error: "Path is outside workspace",
		})
		expect(hoisted.readFile).not.toHaveBeenCalled()
	})

	it("reports a read failure with its own message", async () => {
		const harness = makeHarness()
		hoisted.readFile.mockRejectedValueOnce(new Error("EACCES"))

		await dispatch(harness, { type: "readFileContent", text: "src/a.ts" })

		expect(postedOfType(harness, "fileContent")[0].fileContent).toMatchObject({ error: "EACCES" })
	})
})

describe("mcp settings surfaces", () => {
	it("openCustomModesSettings opens the modes file", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openCustomModesSettings" })

		expect(hoisted.openFile).toHaveBeenCalledWith("/global/modes.yaml")
	})

	it("openMcpSettings opens the hub's own settings file", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openMcpSettings" })

		expect(hoisted.openFile).toHaveBeenCalledWith("/global/mcp.json")
	})

	it("openMcpSettings does nothing with no hub", async () => {
		const harness = makeHarness({ noMcpHub: true })

		await dispatch(harness, { type: "openMcpSettings" })

		expect(hoisted.openFile).not.toHaveBeenCalled()
	})

	it("openProjectMcpSettings REFUSES with no workspace open", async () => {
		const harness = makeHarness()
		hoisted.workspaceFolders = undefined

		await dispatch(harness, { type: "openProjectMcpSettings" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
		expect(hoisted.mkdir).not.toHaveBeenCalled()
	})

	it("openProjectMcpSettings SEEDS the file when it does not exist yet", async () => {
		const harness = makeHarness()
		hoisted.fileExists.mockResolvedValueOnce(false)

		await dispatch(harness, { type: "openProjectMcpSettings" })

		expect(hoisted.mkdir).toHaveBeenCalledWith("/workspace/.shofer", { recursive: true })
		expect(hoisted.safeWriteJson).toHaveBeenCalledWith(
			"/workspace/.shofer/mcp.json",
			{ mcpServers: {} },
			{ prettyPrint: true },
		)
		expect(hoisted.openFile).toHaveBeenCalledWith("/workspace/.shofer/mcp.json")
	})

	it("openProjectMcpSettings does NOT overwrite an existing file", async () => {
		const harness = makeHarness()
		hoisted.fileExists.mockResolvedValueOnce(true)

		await dispatch(harness, { type: "openProjectMcpSettings" })

		expect(hoisted.safeWriteJson).not.toHaveBeenCalled()
		expect(hoisted.openFile).toHaveBeenCalled()
	})

	it("openProjectMcpSettings reports a filesystem failure", async () => {
		const harness = makeHarness()
		hoisted.mkdir.mockRejectedValueOnce(new Error("EROFS"))

		await dispatch(harness, { type: "openProjectMcpSettings" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("deleteMcpServer refreshes the webview after a successful delete", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "deleteMcpServer", serverName: "srv", source: "project" })

		expect(harness.mcpHub.deleteServer).toHaveBeenCalledWith("srv", "project")
		expect(harness.provider.postInitState).toHaveBeenCalled()
	})

	it("deleteMcpServer ignores a message with no server name", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "deleteMcpServer" })

		expect(harness.mcpHub.deleteServer).not.toHaveBeenCalled()
	})

	it("deleteMcpServer logs a failure instead of throwing", async () => {
		const harness = makeHarness()
		harness.mcpHub.deleteServer.mockRejectedValueOnce(new Error("busy"))

		await dispatch(harness, { type: "deleteMcpServer", serverName: "srv" })

		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("Failed to delete MCP server"))
	})

	it("restartMcpServer forwards the server and scope, and logs a failure", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "restartMcpServer", text: "srv", source: "global" })
		expect(harness.mcpHub.restartConnection).toHaveBeenCalledWith("srv", "global")

		harness.mcpHub.restartConnection.mockRejectedValueOnce(new Error("down"))
		await dispatch(harness, { type: "restartMcpServer", text: "srv" })
		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("Failed to retry connection"))
	})

	it("toggleToolEnabledForPrompt coerces the flag to a boolean", async () => {
		const harness = makeHarness()

		await dispatch(harness, {
			type: "toggleToolEnabledForPrompt",
			serverName: "srv",
			source: "project",
			toolName: "t",
			isEnabled: undefined,
		})

		expect(harness.mcpHub.toggleToolEnabledForPrompt).toHaveBeenCalledWith("srv", "project", "t", false)
	})

	it("toggleToolEnabledForPrompt logs a failure", async () => {
		const harness = makeHarness()
		harness.mcpHub.toggleToolEnabledForPrompt.mockRejectedValueOnce(new Error("nope"))

		await dispatch(harness, { type: "toggleToolEnabledForPrompt", serverName: "s", toolName: "t", isEnabled: true })

		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("Failed to toggle enabled for prompt"))
	})

	it("toggleMcpServer forwards the disabled flag, and logs a failure", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "toggleMcpServer", serverName: "srv", disabled: true, source: "global" })
		expect(harness.mcpHub.toggleServerDisabled).toHaveBeenCalledWith("srv", true, "global")

		harness.mcpHub.toggleServerDisabled.mockRejectedValueOnce(new Error("nope"))
		await dispatch(harness, { type: "toggleMcpServer", serverName: "srv", disabled: false })
		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("Failed to toggle MCP server"))
	})

	it("refreshAllMcpServers reconnects everything, and is a no-op with no hub", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "refreshAllMcpServers" })
		expect(harness.mcpHub.refreshAllConnections).toHaveBeenCalled()

		const noHub = makeHarness({ noMcpHub: true })
		await expect(dispatch(noHub, { type: "refreshAllMcpServers" })).resolves.toBeUndefined()
	})

	it("taskSyncEnabled is retired and does nothing", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "taskSyncEnabled", bool: true })
		expect(harness.setValue).not.toHaveBeenCalled()
	})
})

describe("tts messages", () => {
	it("playTts wires start/stop callbacks back to the webview", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "playTts", text: "read this" })

		const [text, options] = hoisted.playTts.mock.calls[0] as [string, { onStart: () => void; onStop: () => void }]
		expect(text).toBe("read this")
		options.onStart()
		options.onStop()
		expect(postedOfType(harness, "ttsStart")).toHaveLength(1)
		expect(postedOfType(harness, "ttsStop")).toHaveLength(1)
	})

	it("playTts with no text says nothing", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "playTts" })
		expect(hoisted.playTts).not.toHaveBeenCalled()
	})

	it("stopTts stops the speaker", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "stopTts" })
		expect(hoisted.stopTts).toHaveBeenCalled()
	})
})

describe("task-scoped messages refuse without a task", () => {
	it("cancelTask always reaches the provider", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "cancelTask" })
		expect(harness.provider.cancelTask).toHaveBeenCalled()
	})

	it("cancelAutoApproval is a no-op with no task", async () => {
		const harness = makeHarness()
		await expect(dispatch(harness, { type: "cancelAutoApproval" })).resolves.toBeUndefined()
	})

	it("cancelAutoApproval cancels the pending timeout when there IS a task", async () => {
		const harness = makeHarness({ task: makeTask() })
		await dispatch(harness, { type: "cancelAutoApproval" })
		expect(harness.task!.cancelAutoApprovalTimeout).toHaveBeenCalled()
	})

	it("deleteMessage refuses with no active task", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "deleteMessage", value: 123 })

		expect(hoisted.notifier.error).toHaveBeenCalled()
		expect(postedOfType(harness, "showDeleteMessageDialog")).toEqual([])
	})

	it("deleteMessage refuses a non-numeric timestamp", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "deleteMessage", value: "later" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("deleteMessage refuses a ZERO timestamp — it is not a real message id", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "deleteMessage", value: 0 })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("deleteMessage raises the confirmation dialog, reporting whether state can come back", async () => {
		const task = makeTask()
		task.shoferMessages = [
			{ ts: 100, say: "user_feedback" },
			{ ts: 200, say: "plugin_marker", marker: { restorable: true } },
		]
		const harness = makeHarness({ task })

		await dispatch(harness, { type: "deleteMessage", value: 100 })

		expect(postedOfType(harness, "showDeleteMessageDialog")[0]).toEqual({
			type: "showDeleteMessageDialog",
			messageTs: 100,
			hasRestorableState: true,
		})
	})

	it("submitEditedMessage raises the edit dialog with the pending text", async () => {
		const task = makeTask()
		task.shoferMessages = [{ ts: 100, say: "user_feedback" }]
		const harness = makeHarness({ task })

		await dispatch(harness, {
			type: "submitEditedMessage",
			value: 100,
			editedMessageContent: "reworded",
			images: ["data:image/png;base64,AA"],
		})

		expect(postedOfType(harness, "showEditMessageDialog")[0]).toMatchObject({
			messageTs: 100,
			text: "reworded",
			hasRestorableState: false,
		})
	})

	it("submitEditedMessage does nothing without a task or without content", async () => {
		const noTask = makeHarness()
		await dispatch(noTask, { type: "submitEditedMessage", value: 1, editedMessageContent: "x" })
		expect(noTask.posted()).toEqual([])

		const withTask = makeHarness({ task: makeTask() })
		await dispatch(withTask, { type: "submitEditedMessage", value: 1 })
		expect(withTask.posted()).toEqual([])
	})
})

describe("chat message queue", () => {
	it("removeQueuedMessage and editQueuedMessage reach the queue service", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "removeQueuedMessage", text: "id-1" })
		expect(harness.task!.messageQueueService.removeMessage).toHaveBeenCalledWith("id-1")

		await dispatch(harness, {
			type: "editQueuedMessage",
			payload: { id: "id-1", text: "new", images: ["i"] },
		})
		expect(harness.task!.messageQueueService.updateMessage).toHaveBeenCalledWith("id-1", "new", ["i"])
	})

	it("removeQueuedMessage substitutes an empty id rather than passing undefined", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "removeQueuedMessage" })

		expect(harness.task!.messageQueueService.removeMessage).toHaveBeenCalledWith("")
	})

	it("editQueuedMessage with no payload does nothing", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "editQueuedMessage" })

		expect(harness.task!.messageQueueService.updateMessage).not.toHaveBeenCalled()
	})

	it("cancelAndSendQueuedMessages soft-cancels the running task", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "cancelAndSendQueuedMessages" })

		expect(harness.task!.cancelAndProcessQueuedMessages).toHaveBeenCalled()
	})

	it("cancelAndSendQueuedMessages with no task is a no-op", async () => {
		const harness = makeHarness()
		await expect(dispatch(harness, { type: "cancelAndSendQueuedMessages" })).resolves.toBeUndefined()
	})
})

describe("dismissed upsells", () => {
	it("appends an id and echoes the whole list back", async () => {
		const harness = makeHarness()
		harness.state.dismissedUpsells = ["a"]

		await dispatch(harness, { type: "dismissUpsell", upsellId: "b" })

		expect(harness.setValue).toHaveBeenCalledWith("dismissedUpsells", ["a", "b"])
		expect(postedOfType(harness, "dismissedUpsells")[0]).toEqual({ type: "dismissedUpsells", list: ["a", "b"] })
	})

	it("does not duplicate an id already dismissed, and writes nothing", async () => {
		const harness = makeHarness()
		harness.state.dismissedUpsells = ["a"]

		await dispatch(harness, { type: "dismissUpsell", upsellId: "a" })

		expect(harness.setValue).not.toHaveBeenCalled()
		expect(postedOfType(harness, "dismissedUpsells")[0]).toEqual({ type: "dismissedUpsells", list: ["a"] })
	})

	it("ignores a dismissal with no id", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "dismissUpsell" })

		expect(harness.posted()).toEqual([])
	})

	it("getDismissedUpsells answers with an empty list when nothing was dismissed", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "getDismissedUpsells" })

		expect(postedOfType(harness, "dismissedUpsells")[0]).toEqual({ type: "dismissedUpsells", list: [] })
	})
})

describe("markdown preview", () => {
	it("writes a temp file and asks VS Code to preview it", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openMarkdownPreview", text: "# hi" })

		const [tmpPath, body, encoding] = hoisted.writeFile.mock.calls[0] as [string, string, string]
		expect(tmpPath).toMatch(/shofer-preview-\d+\.md$/)
		expect(body).toBe("# hi")
		expect(encoding).toBe("utf8")
		expect(hoisted.executeCommand).toHaveBeenCalledWith("markdown.showPreview", { fsPath: tmpPath })
	})

	it("reports a failure through the notifier and the log", async () => {
		const harness = makeHarness()
		hoisted.writeFile.mockRejectedValueOnce(new Error("ENOSPC"))

		await dispatch(harness, { type: "openMarkdownPreview", text: "# hi" })

		expect(hoisted.notifier.error).toHaveBeenCalledWith(expect.stringContaining("ENOSPC"))
		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("ENOSPC"))
	})

	it("ignores an empty preview request", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openMarkdownPreview" })

		expect(hoisted.writeFile).not.toHaveBeenCalled()
	})
})

describe("commands, modes and skills discovery", () => {
	it("requestCommands returns the discovered slash commands", async () => {
		const harness = makeHarness()
		hoisted.getCommands.mockResolvedValueOnce([
			{ name: "review", source: "project", filePath: "/w/.shofer/commands/review.md", description: "d" },
		])

		await dispatch(harness, { type: "requestCommands" })

		expect(postedOfType(harness, "commands")[0].commands).toEqual([
			{
				name: "review",
				source: "project",
				filePath: "/w/.shofer/commands/review.md",
				description: "d",
				argumentHint: undefined,
			},
		])
	})

	it("requestCommands APPENDS the current mode's skills, without shadowing a real command", async () => {
		const skillsManager = {
			getSkillsForMode: vi.fn(() => [
				{ name: "review", source: "global", path: "/skills/review", description: "skill" },
				{ name: "deploy", source: "project", path: "/skills/deploy", description: "skill" },
			]),
		}
		const harness = makeHarness({ skillsManager, task: makeTask() })
		hoisted.getCommands.mockResolvedValueOnce([{ name: "review", source: "project", filePath: "/cmd" }])

		await dispatch(harness, { type: "requestCommands" })

		const commands = postedOfType(harness, "commands")[0].commands as Array<{ name: string; filePath: string }>
		expect(commands.map((c) => c.name)).toEqual(["review", "deploy"])
		expect(commands[0].filePath).toBe("/cmd")
		expect(skillsManager.getSkillsForMode).toHaveBeenCalledWith("code")
	})

	it("requestCommands falls back to the DEFAULT mode when the task cannot report one", async () => {
		const task = makeTask()
		task.getTaskMode = vi.fn(async () => {
			throw new Error("no mode")
		})
		const skillsManager = { getSkillsForMode: vi.fn(() => []) }
		const harness = makeHarness({ skillsManager, task })

		await dispatch(harness, { type: "requestCommands" })

		expect(skillsManager.getSkillsForMode).toHaveBeenCalledWith("code")
		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("Error resolving current task mode"))
	})

	it("requestCommands answers with an EMPTY list when discovery fails", async () => {
		const harness = makeHarness()
		hoisted.getCommands.mockRejectedValueOnce(new Error("bad glob"))

		await dispatch(harness, { type: "requestCommands" })

		expect(postedOfType(harness, "commands")[0]).toEqual({ type: "commands", commands: [] })
	})

	it("requestModes answers with the provider's modes, and with [] on failure", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "requestModes" })
		expect(postedOfType(harness, "modes")[0]).toEqual({ type: "modes", modes: [{ slug: "code" }] })

		const failing = makeHarness()
		;(failing.provider.getModes as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nope"))
		await dispatch(failing, { type: "requestModes" })
		expect(postedOfType(failing, "modes")[0]).toEqual({ type: "modes", modes: [] })
	})

	it.each([
		["requestSkills", "handleRequestSkills"],
		["createSkill", "handleCreateSkill"],
		["deleteSkill", "handleDeleteSkill"],
		["moveSkill", "handleMoveSkill"],
		["updateSkillModes", "handleUpdateSkillModes"],
		["openSkillFile", "handleOpenSkillFile"],
	] as const)("%s delegates to the extracted skills handler", async (type, handler) => {
		const harness = makeHarness()

		await dispatch(harness, { type })

		expect(hoisted.skills[handler]).toHaveBeenCalled()
	})
})

describe("navigation and misc", () => {
	it("focusPanelRequest goes through the typed command id", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "focusPanelRequest" })

		expect(hoisted.executeCommand).toHaveBeenCalledWith("shofer.focusPanel")
	})

	it("switchTab records the tab and forwards it", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "switchTab", tab: "settings", values: { section: "about" } })

		expect(hoisted.captureTabShown).toHaveBeenCalledWith("settings")
		expect(postedOfType(harness, "action")[0]).toEqual({
			type: "action",
			action: "switchTab",
			tab: "settings",
			values: { section: "about" },
		})
	})

	it("switchTab with no tab does nothing", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "switchTab" })

		expect(harness.posted()).toEqual([])
	})

	it("insertTextIntoTextarea echoes the text back, and ignores an empty one", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "insertTextIntoTextarea", text: "hello" })
		expect(postedOfType(harness, "insertTextIntoTextarea")[0]).toEqual({
			type: "insertTextIntoTextarea",
			text: "hello",
		})

		await dispatch(harness, { type: "insertTextIntoTextarea", text: "" })
		expect(postedOfType(harness, "insertTextIntoTextarea")).toHaveLength(1)
	})

	it("showMdmAuthRequiredNotification warns", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "showMdmAuthRequiredNotification" })

		expect(hoisted.notifier.warn).toHaveBeenCalled()
	})

	it("openKeyboardShortcuts passes a search query through when there is one", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openKeyboardShortcuts", text: "shofer" })
		expect(hoisted.executeCommand).toHaveBeenCalledWith("workbench.action.openGlobalKeybindings", "shofer")

		hoisted.executeCommand.mockClear()
		await dispatch(harness, { type: "openKeyboardShortcuts" })
		expect(hoisted.executeCommand).toHaveBeenCalledWith("workbench.action.openGlobalKeybindings")
	})

	it("clearCloudAuthSkipModel clears the flag and refreshes state", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "clearCloudAuthSkipModel" })

		expect(harness.provider.context.globalState.update).toHaveBeenCalledWith("shofer-auth-skip-model", undefined)
		expect(harness.provider.postInitState).toHaveBeenCalled()
	})

	it("switchOrganization is retired and does nothing", async () => {
		const harness = makeHarness()
		await expect(dispatch(harness, { type: "switchOrganization" })).resolves.toBeUndefined()
	})

	it("mode delegates the switch to the provider", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "mode", text: "architect" })

		expect(harness.provider.handleUserModeSwitch).toHaveBeenCalledWith("architect")
	})

	it("webviewDidLaunch starts the heartbeat", async () => {
		const harness = makeHarness()
		// The remainder of this case reaches collaborators this harness does not
		// fake; what must be pinned here is that the heartbeat starts FIRST, since
		// starting it before the renderer's listener exists causes a reset loop.
		await dispatch(harness, { type: "webviewDidLaunch" }).catch(() => {})

		expect(harness.provider._onWebviewLaunched).toHaveBeenCalled()
	})
})

describe("error diagnostics", () => {
	it("refuses without an active task", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "downloadErrorDiagnostics" })

		expect(hoisted.notifier.error).toHaveBeenCalledWith("No active task to generate diagnostics for")
		expect(hoisted.generateErrorDiagnostics).not.toHaveBeenCalled()
	})

	it("passes the task id and the global storage path", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "downloadErrorDiagnostics", values: { includeApi: true } })

		expect(hoisted.generateErrorDiagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "task-1", globalStoragePath: "/global", values: { includeApi: true } }),
		)
	})
})

describe("parallel task management", () => {
	const forwarding = [
		["focusParallelTask", "focusTask"],
		["startParallelTask", "startManagedTask"],
		["pauseParallelTask", "pauseManagedTask"],
		["resumeParallelTask", "resumeManagedTask"],
		["stopParallelTask", "stopManagedTask"],
		["deleteParallelTask", "deleteManagedTask"],
		["archiveParallelTask", "archiveManagedTask"],
		["unarchiveParallelTask", "unarchiveManagedTask"],
		["pinParallelTask", "pinManagedTask"],
		["unpinParallelTask", "unpinManagedTask"],
	] as const

	it.each(forwarding)("%s forwards the id to %s", async (type, method) => {
		const harness = makeHarness()

		await dispatch(harness, { type, taskId: "t-9" })

		expect(harness.provider[method]).toHaveBeenCalledWith("t-9")
	})

	it.each(forwarding)("%s ignores a message with no task id", async (type, method) => {
		const harness = makeHarness()

		await dispatch(harness, { type })

		expect(harness.provider[method]).not.toHaveBeenCalled()
	})

	it.each(forwarding)("%s logs a failure rather than rejecting", async (type, method) => {
		const harness = makeHarness()
		;(harness.provider[method] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"))

		await expect(dispatch(harness, { type, taskId: "t-9" })).resolves.toBeUndefined()
		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("boom"))
	})

	it("renameParallelTask needs BOTH an id and a name", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "renameParallelTask", taskId: "t-9", text: "New name" })
		expect(harness.provider.renameManagedTask).toHaveBeenCalledWith("t-9", "New name")
		;(harness.provider.renameManagedTask as ReturnType<typeof vi.fn>).mockClear()
		await dispatch(harness, { type: "renameParallelTask", taskId: "t-9" })
		expect(harness.provider.renameManagedTask).not.toHaveBeenCalled()
	})

	it("clearTaskNotification forwards the id and survives a throw", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "clearTaskNotification", taskId: "t-9" })
		expect(harness.provider.clearTaskNotification).toHaveBeenCalledWith("t-9")
		;(harness.provider.clearTaskNotification as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error("gone")
		})
		await expect(dispatch(harness, { type: "clearTaskNotification", taskId: "t-9" })).resolves.toBeUndefined()
	})

	it("createParallelTask asks the placement seam for the cwd and resets the chat surface", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "createParallelTask", taskName: "n", text: "do it", images: ["i"] })

		expect(harness.provider.createManagedTask).toHaveBeenCalledWith("n", "do it", ["i"], "/workspace/worktree")
		expect(postedOfType(harness, "invoke")[0]).toEqual({ type: "invoke", invoke: "newChat" })
		expect(harness.provider.postInitState).toHaveBeenCalled()
	})

	it("createParallelTask STILL resets the input when creation fails — the user must not be stuck", async () => {
		const harness = makeHarness()
		;(harness.provider.createManagedTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no worker"))

		await dispatch(harness, { type: "createParallelTask", text: "do it" })

		expect(postedOfType(harness, "invoke")[0]).toEqual({ type: "invoke", invoke: "newChat" })
		expect(harness.provider.postInitState).not.toHaveBeenCalled()
	})

	it("requestParallelTasks projects only the fields the UI renders", async () => {
		const harness = makeHarness({
			managedTasks: [
				{
					id: "m1",
					name: "n",
					taskId: "t1",
					workspace: "/w",
					createdAt: 1,
					lastActiveAt: 2,
					state: { lifecycle: "idle" },
					activeTimeMs: 5,
					secret: "must not leak",
				},
			],
		})

		await dispatch(harness, { type: "requestParallelTasks" })

		expect(postedOfType(harness, "parallelTasksUpdated")[0].parallelTasks).toEqual([
			{
				id: "m1",
				name: "n",
				taskId: "t1",
				workspace: "/w",
				createdAt: 1,
				lastActiveAt: 2,
				state: { lifecycle: "idle" },
				activeTimeMs: 5,
			},
		])
	})

	it("requestParallelTasks logs a failure rather than rejecting", async () => {
		const harness = makeHarness()
		;(harness.provider.getManagedTasks as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error("no manager")
		})

		await expect(dispatch(harness, { type: "requestParallelTasks" })).resolves.toBeUndefined()
		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("Error requesting managed tasks"))
	})

	it("launchTask backgrounds the current task rather than aborting it", async () => {
		const popped = { taskId: "t-old" }
		const harness = makeHarness({ poppedTask: popped })

		await dispatch(harness, { type: "launchTask" })

		expect(harness.taskManager.registerBackgroundTask).toHaveBeenCalledWith(popped)
		expect(harness.posted().map((m) => `${m.type}:${m.action ?? m.invoke ?? ""}`)).toEqual([
			"action:chatButtonClicked",
			"invoke:newChat",
			"action:focusInput",
		])
	})

	it("launchTask still resets the surface when the stack was already empty", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "launchTask" })

		expect(harness.taskManager.registerBackgroundTask).not.toHaveBeenCalled()
		expect(postedOfType(harness, "invoke")[0]).toEqual({ type: "invoke", invoke: "newChat" })
	})

	it("approveBackgroundTask answers the parked ask and clears the notification", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "approveBackgroundTask", taskId: "t-1", text: "ok", images: ["i"] })

		expect(harness.task!.handleWebviewAskResponse).toHaveBeenCalledWith("yesButtonClicked", "ok", ["i"])
		expect(harness.provider.clearTaskNotification).toHaveBeenCalledWith("t-1")
	})

	it("approveBackgroundTask honours an explicit askResponse", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "approveBackgroundTask", taskId: "t-1", askResponse: "noButtonClicked" })

		expect(harness.task!.handleWebviewAskResponse).toHaveBeenCalledWith("noButtonClicked", undefined, undefined)
	})

	it("approveBackgroundTask does nothing for a task the manager does not know", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "approveBackgroundTask", taskId: "t-1" })

		expect(harness.provider.clearTaskNotification).not.toHaveBeenCalled()
	})
})

describe("task lifecycle messages", () => {
	it("newTask asks the placement seam FIRST and aborts creation when it refuses", async () => {
		const harness = makeHarness()
		hoisted.resolveTaskCwd.mockRejectedValueOnce(new Error("worktree provisioning failed"))

		await dispatch(harness, { type: "newTask", text: "do it" })

		expect(harness.provider.createManagedTask).not.toHaveBeenCalled()
		expect(hoisted.notifier.error).toHaveBeenCalledWith("worktree provisioning failed")
		// The chat surface is reset either way so the user is not stuck.
		expect(postedOfType(harness, "invoke")[0]).toEqual({ type: "invoke", invoke: "newChat" })
	})

	it("newTask carries the pre-task mode and profile seeds from the chat dropdown", async () => {
		const harness = makeHarness()

		await dispatch(harness, {
			type: "newTask",
			text: "do it",
			images: ["i"],
			mode: "architect",
			apiConfigName: "prod",
		})

		expect(harness.provider.createManagedTask).toHaveBeenCalledWith(
			undefined,
			"do it",
			["i"],
			"/workspace/worktree",
			{ mode: "architect", apiConfigName: "prod" },
		)
	})

	it("newTask resets the chat surface and reports a creation failure", async () => {
		const harness = makeHarness()
		;(harness.provider.createManagedTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no slot"))

		await dispatch(harness, { type: "newTask", text: "do it" })

		expect(postedOfType(harness, "invoke")).toHaveLength(1)
		expect(hoisted.notifier.error).toHaveBeenCalledWith(expect.stringContaining("Failed to create task"))
	})

	it("customInstructions delegates to the provider's own setter", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "customInstructions", text: "be terse" })

		expect(harness.provider.updateCustomInstructions).toHaveBeenCalledWith("be terse")
	})

	it("clearTask clears and re-broadcasts", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "clearTask" })

		expect(harness.provider.clearTask).toHaveBeenCalled()
		expect(harness.provider.postInitState).toHaveBeenCalled()
	})

	it("didShowAnnouncement records the CURRENT announcement id, not a webview-supplied one", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "didShowAnnouncement", text: "something-else" })

		expect(harness.setValue).toHaveBeenCalledWith("lastShownAnnouncementId", "announcement-1")
	})

	it("showTaskWithId FOCUSES the task rather than replacing the current one", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "showTaskWithId", text: "t-9" })

		expect(harness.provider.focusTask).toHaveBeenCalledWith("t-9")
	})

	it("loadOlderMessages and condenseTaskContextRequest delegate", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "loadOlderMessages" })
		expect(harness.provider.loadOlderShoferMessages).toHaveBeenCalled()

		await dispatch(harness, { type: "condenseTaskContextRequest", text: "t-1" })
		expect(harness.provider.condenseTaskContext).toHaveBeenCalledWith("t-1")
	})

	it("the export messages address the CURRENT task, and do nothing without one", async () => {
		const withTask = makeHarness({ task: makeTask() })
		await dispatch(withTask, { type: "exportCurrentTask" })
		await dispatch(withTask, { type: "exportCurrentTaskJson" })
		expect(withTask.provider.exportTaskWithId).toHaveBeenCalledWith("task-1")
		expect(withTask.provider.exportTaskWithIdJson).toHaveBeenCalledWith("task-1")

		const noTask = makeHarness()
		await dispatch(noTask, { type: "exportCurrentTask" })
		await dispatch(noTask, { type: "exportCurrentTaskJson" })
		expect(noTask.provider.exportTaskWithId).not.toHaveBeenCalled()
	})

	it("exportTaskWithId / exportTaskWithIdJson address an explicit id", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "exportTaskWithId", text: "t-9" })
		await dispatch(harness, { type: "exportTaskWithIdJson", text: "t-9" })

		expect(harness.provider.exportTaskWithId).toHaveBeenCalledWith("t-9")
		expect(harness.provider.exportTaskWithIdJson).toHaveBeenCalledWith("t-9")
	})

	it("terminalOperation reaches the current task, and is a no-op without one", async () => {
		const harness = makeHarness({ task: makeTask() })
		await dispatch(harness, { type: "terminalOperation", terminalOperation: "continue" })
		expect(harness.task!.handleTerminalOperation).toHaveBeenCalledWith("continue")

		const empty = makeHarness()
		await expect(
			dispatch(empty, { type: "terminalOperation", terminalOperation: "continue" }),
		).resolves.toBeUndefined()
	})

	it("terminalOperation with no operation named does nothing", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "terminalOperation" })

		expect(harness.task!.handleTerminalOperation).not.toHaveBeenCalled()
	})
})

describe("askResponse routing", () => {
	it("routes to the task the WEBVIEW named, not to whatever is current", async () => {
		const addressed = makeTask()
		addressed.taskId = "t-9"
		const harness = makeHarness({ task: addressed })

		await dispatch(harness, {
			type: "askResponse",
			taskId: "t-9",
			askResponse: "yesButtonClicked",
			text: "ok",
			askId: "ask-1",
		})

		expect(addressed.handleWebviewAskResponse).toHaveBeenCalledWith(
			"yesButtonClicked",
			"ok",
			expect.anything(),
			"ask-1",
		)
	})

	it("DROPS a response with no resolvable target rather than landing it on the wrong task", async () => {
		const harness = makeHarness()

		await expect(
			dispatch(harness, { type: "askResponse", taskId: "gone", askResponse: "yesButtonClicked" }),
		).resolves.toBeUndefined()
	})

	it("falls back to the current task when the webview names none", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "askResponse", askResponse: "noButtonClicked" })

		expect(harness.task!.handleWebviewAskResponse).toHaveBeenCalled()
	})
})

describe("trustOutsideWorkspacePath", () => {
	it("PERSISTS a write grant into allowedWritePaths — write covers read", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, {
			type: "trustOutsideWorkspacePath",
			outsideWorkspacePath: "/elsewhere",
			outsideWorkspaceAccess: "write",
			outsideWorkspacePersist: true,
		})

		expect(harness.setValue).toHaveBeenCalledWith("allowedWritePaths", ["/elsewhere"])
		expect(harness.provider.postInitState).toHaveBeenCalled()
	})

	it("persists a read grant into allowedReadPaths, defaulting the access to read", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, {
			type: "trustOutsideWorkspacePath",
			outsideWorkspacePath: "/elsewhere",
			outsideWorkspacePersist: true,
		})

		expect(harness.setValue).toHaveBeenCalledWith("allowedReadPaths", ["/elsewhere"])
	})

	it("does not re-add a path the allowlist already carries", async () => {
		const harness = makeHarness({ task: makeTask() })
		harness.state.allowedReadPaths = ["/elsewhere"]

		await dispatch(harness, {
			type: "trustOutsideWorkspacePath",
			outsideWorkspacePath: "/elsewhere",
			outsideWorkspacePersist: true,
		})

		expect(harness.setValue).not.toHaveBeenCalled()
	})

	it("defaults to a TASK-SCOPED grant, which is in-memory only", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, {
			type: "trustOutsideWorkspacePath",
			outsideWorkspacePath: "/elsewhere",
			outsideWorkspaceAccess: "read",
		})

		expect(harness.task!.trustOutsideWorkspacePath).toHaveBeenCalledWith("/elsewhere", "read")
		expect(harness.setValue).not.toHaveBeenCalled()
	})

	it("APPROVES the pending ask in the same click", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, {
			type: "trustOutsideWorkspacePath",
			outsideWorkspacePath: "/elsewhere",
			askId: "ask-1",
		})

		expect(harness.task!.handleWebviewAskResponse).toHaveBeenCalledWith(
			"yesButtonClicked",
			expect.anything(),
			expect.anything(),
			"ask-1",
		)
	})

	it("drops the grant when no task can be resolved", async () => {
		const harness = makeHarness()

		await expect(
			dispatch(harness, { type: "trustOutsideWorkspacePath", outsideWorkspacePath: "/elsewhere" }),
		).resolves.toBeUndefined()
	})
})

describe("updateCostLimit", () => {
	it("sets the cap on the ROOT task — a subtask resolves through its parent", async () => {
		const root = makeTask()
		root.taskId = "root"
		const child = makeTask()
		child.parentTask = root
		const harness = makeHarness({ task: child })

		await dispatch(harness, { type: "updateCostLimit", taskId: "task-1", costLimit: 5 })

		expect(root.costLimit).toBe(5)
		expect(root.invalidateCostLimitCache).toHaveBeenCalled()
		expect(child.costLimit).toBeUndefined()
	})

	it("PERSISTS the cap to history and re-broadcasts", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "updateCostLimit", taskId: "task-1", costLimit: 5 })

		expect(harness.provider.updateTaskHistory).toHaveBeenCalledWith(expect.objectContaining({ costLimit: 5 }))
		expect(harness.provider.postInitState).toHaveBeenCalled()
	})

	it("logs — and still re-broadcasts — when the persist fails", async () => {
		const harness = makeHarness({ task: makeTask() })
		;(harness.provider.getTaskWithId as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no history"))

		await dispatch(harness, { type: "updateCostLimit", taskId: "task-1", costLimit: 5 })

		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("[updateCostLimit] persist failed"))
		expect(harness.provider.postInitState).toHaveBeenCalled()
	})

	it("ignores a message missing either the id or the limit", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "updateCostLimit", taskId: "task-1" })
		await dispatch(harness, { type: "updateCostLimit", costLimit: 5 })

		expect(harness.provider.updateTaskHistory).not.toHaveBeenCalled()
	})
})

describe("plugin channels", () => {
	it("the Plugins panel request and the plugin-UI channel each reach their own handler", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "plugin", plugin: { action: "list" } })
		expect(harness.provider.handlePluginRequest).toHaveBeenCalledWith({ action: "list" })

		await dispatch(harness, { type: "pluginUiMessage", pluginUiMessage: { pluginName: "p", message: {} } })
		expect(harness.provider.handlePluginUiMessage).toHaveBeenCalledWith({ pluginName: "p", message: {} })
	})

	it("both ignore an empty payload", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "plugin" })
		await dispatch(harness, { type: "pluginUiMessage" })

		expect(harness.provider.handlePluginRequest).not.toHaveBeenCalled()
		expect(harness.provider.handlePluginUiMessage).not.toHaveBeenCalled()
	})
})

describe("bulk task deletion", () => {
	it("deletes every id and refreshes the UI as it goes", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "deleteMultipleTasksWithIds", ids: ["a", "b"] })

		expect((harness.provider.deleteTaskWithId as ReturnType<typeof vi.fn>).mock.calls.map(([id]) => id)).toEqual([
			"a",
			"b",
		])
		expect(harness.provider.postInitState).toHaveBeenCalled()
	})

	it("CONTINUES past a failure rather than abandoning the rest of the batch", async () => {
		const harness = makeHarness()
		;(harness.provider.deleteTaskWithId as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("locked"))

		await dispatch(harness, { type: "deleteMultipleTasksWithIds", ids: ["a", "b"] })

		expect(harness.provider.deleteTaskWithId).toHaveBeenCalledTimes(2)
	})

	it("ignores a non-array payload", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "deleteMultipleTasksWithIds", ids: "a" })

		expect(harness.provider.deleteTaskWithId).not.toHaveBeenCalled()
	})

	it("deleteTaskWithId addresses one id", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "deleteTaskWithId", text: "t-9" })

		expect(harness.provider.deleteTaskWithId).toHaveBeenCalledWith("t-9")
	})
})

describe("aggregated costs and interactions", () => {
	it("keys the aggregated-costs reply BY TASK ID so the chat can correlate it", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "getTaskWithAggregatedCosts", text: "t-9" })

		expect(postedOfType(harness, "taskWithAggregatedCosts")[0]).toMatchObject({
			text: "t-9",
			historyItem: { id: "t-9" },
			aggregatedCosts: { totalCost: 1 },
		})
	})

	it("answers with an ERROR payload — still keyed by id — when there is no task id", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "getTaskWithAggregatedCosts" })

		expect(postedOfType(harness, "taskWithAggregatedCosts")[0]).toMatchObject({ error: "Task ID is required" })
	})

	it("answers with an error payload when the lookup fails", async () => {
		const harness = makeHarness()
		;(harness.provider.getTaskWithAggregatedCosts as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("gone"),
		)

		await dispatch(harness, { type: "getTaskWithAggregatedCosts", text: "t-9" })

		expect(postedOfType(harness, "taskWithAggregatedCosts")[0]).toMatchObject({ text: "t-9", error: "gone" })
	})

	it("keys the interactions reply by the ROOT task id", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "getTaskInteractions", text: "root-1" })

		expect(postedOfType(harness, "taskInteractions")[0]).toMatchObject({
			text: "root-1",
			taskInteractions: [],
		})
	})

	it("answers with an error payload for a missing root id or a failed lookup", async () => {
		const missing = makeHarness()
		await dispatch(missing, { type: "getTaskInteractions" })
		expect(postedOfType(missing, "taskInteractions")[0]).toMatchObject({ error: "Root task ID is required" })

		const failing = makeHarness()
		;(failing.provider.getTaskInteractions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nope"))
		await dispatch(failing, { type: "getTaskInteractions", text: "root-1" })
		expect(postedOfType(failing, "taskInteractions")[0]).toMatchObject({ error: "nope" })
	})
})

describe("settings import/export and reset", () => {
	it("importSettings runs the shared importer with no file path (it prompts)", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "importSettings" })

		expect(hoisted.importSettingsWithFeedback).toHaveBeenCalledWith(
			expect.objectContaining({ provider: harness.provider }),
		)
	})

	it("exportSettings writes through the proxy", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "exportSettings" })

		expect(hoisted.exportSettings).toHaveBeenCalledWith({ contextProxy: harness.provider.contextProxy })
	})

	it("resetState delegates to the provider", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "resetState" })

		expect(harness.provider.resetState).toHaveBeenCalled()
	})
})

describe("updateSettings", () => {
	it("writes each key through ContextProxy and re-broadcasts ONCE", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { ttsSpeed: 2, soundEnabled: true } })

		expect(harness.setValue).toHaveBeenCalledWith("ttsSpeed", 2)
		expect(harness.setValue).toHaveBeenCalledWith("soundEnabled", true)
		expect(harness.provider.postInitState).toHaveBeenCalledTimes(1)
	})

	it("ignores a message with no settings at all", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings" })

		expect(harness.setValue).not.toHaveBeenCalled()
		expect(harness.provider.postInitState).not.toHaveBeenCalled()
	})

	it("defaults a cleared language back to English", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { language: undefined } })

		expect(harness.setValue).toHaveBeenCalledWith("language", "en")
	})

	it("treats alwaysAllowGroups as a PATCH over the WRITE SCOPE's own map, never the merged view", async () => {
		const harness = makeHarness()
		harness.state.alwaysAllowGroups = { browser: false, salesforce: true }

		await dispatch(harness, {
			type: "updateSettings",
			updatedSettings: { alwaysAllowGroups: { browser: true } },
		})

		expect(harness.setValue).toHaveBeenCalledWith("alwaysAllowGroups", { browser: true, salesforce: true })
	})

	it("a NULL entry DELETES the category so a less specific scope can answer", async () => {
		const harness = makeHarness()
		harness.state.alwaysAllowGroups = { browser: true, salesforce: true }

		await dispatch(harness, {
			type: "updateSettings",
			updatedSettings: { alwaysAllowGroups: { browser: null } },
		})

		expect(harness.setValue).toHaveBeenCalledWith("alwaysAllowGroups", { salesforce: true })
	})

	it("starts from an EMPTY map when the write scope has none", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { alwaysAllowGroups: { a: true } } })

		expect(harness.setValue).toHaveBeenCalledWith("alwaysAllowGroups", { a: true })
	})

	it.each([[null], [undefined], [["a"]], ["nope"]])(
		"SKIPS an alwaysAllowGroups payload that is not a record (%s)",
		async (payload) => {
			const harness = makeHarness()

			await dispatch(harness, { type: "updateSettings", updatedSettings: { alwaysAllowGroups: payload } })

			expect(harness.setValue).not.toHaveBeenCalled()
		},
	)

	it("sanitizes the command lists on the way through", async () => {
		const harness = makeHarness()

		await dispatch(harness, {
			type: "updateSettings",
			updatedSettings: { allowedCommands: ["ls", "  ", 3], deniedCommands: "nope" },
		})

		expect(harness.setValue).toHaveBeenCalledWith("allowedCommands", ["ls"])
		expect(harness.setValue).toHaveBeenCalledWith("deniedCommands", [])
	})

	it("pushes the tts settings into the speaker as well as the store", async () => {
		const harness = makeHarness()

		await dispatch(harness, {
			type: "updateSettings",
			updatedSettings: { ttsEnabled: undefined, ttsSpeed: undefined },
		})

		expect(hoisted.setTtsEnabled).toHaveBeenCalledWith(true)
		expect(hoisted.setTtsSpeed).toHaveBeenCalledWith(1.0)
	})

	it("MERGES an experiments patch over the existing flags and re-fires the context keys", async () => {
		const harness = makeHarness()
		harness.state.experiments = { existingFlag: true }

		await dispatch(harness, { type: "updateSettings", updatedSettings: { experiments: { newFlag: true } } })

		expect(harness.setValue).toHaveBeenCalledWith(
			"experiments",
			expect.objectContaining({ existingFlag: true, newFlag: true }),
		)
	})

	it("skips an empty experiments patch rather than clobbering the flags", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { experiments: undefined } })

		expect(harness.setValue).not.toHaveBeenCalled()
	})

	it("skips an empty customSupportPrompts payload", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { customSupportPrompts: undefined } })

		expect(harness.setValue).not.toHaveBeenCalled()
	})

	it("tells the MCP hub when MCP is toggled, and defaults the flag to ON", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { mcpEnabled: undefined } })

		expect(harness.mcpHub.handleMcpEnabledChange).toHaveBeenCalledWith(true)
		expect(harness.setValue).toHaveBeenCalledWith("mcpEnabled", true)
	})

	it("still persists the MCP flag with no hub to tell", async () => {
		const harness = makeHarness({ noMcpHub: true })

		await dispatch(harness, { type: "updateSettings", updatedSettings: { mcpEnabled: false } })

		expect(harness.setValue).toHaveBeenCalledWith("mcpEnabled", false)
	})

	it("wires the logging settings into the LIVE transport, treating an empty list as 'all'", async () => {
		const harness = makeHarness()

		await dispatch(harness, {
			type: "updateSettings",
			updatedSettings: { logLevel: "warn", logCategories: [] },
		})

		expect(harness.setValue).toHaveBeenCalledWith("logLevel", "warn")
		expect(harness.setValue).toHaveBeenCalledWith("logCategories", [])
	})

	it("accepts a non-empty category whitelist", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { logCategories: ["Mcp"] } })

		expect(harness.setValue).toHaveBeenCalledWith("logCategories", ["Mcp"])
	})

	it("ignores a non-string log level rather than corrupting the transport", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { logLevel: 3 } })

		expect(harness.setValue).toHaveBeenCalledWith("logLevel", 3)
	})

	it.each([
		["terminalShellIntegrationTimeout", 9000],
		["terminalShellIntegrationDisabled", true],
		["terminalCommandDelay", 100],
		["terminalPowershellCounter", true],
		["terminalZshClearEolMark", false],
		["terminalZshOhMy", true],
		["terminalZshP10k", true],
		["terminalZdotdir", true],
		["execaShellPath", "/bin/bash"],
	])("pushes %s into the live Terminal statics and persists it", async (key, value) => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { [key]: value } })

		expect(harness.setValue).toHaveBeenCalledWith(key, value)
	})

	it("skips the live push for an UNDEFINED terminal setting but still persists it", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateSettings", updatedSettings: { terminalCommandDelay: undefined } })

		expect(harness.setValue).toHaveBeenCalledWith("terminalCommandDelay", undefined)
	})
})

describe("api configuration profiles", () => {
	it("saveApiConfiguration writes the profile and refreshes the profile LIST", async () => {
		const harness = makeHarness()

		await dispatch(harness, {
			type: "saveApiConfiguration",
			text: "prod",
			apiConfiguration: { apiProvider: "anthropic" },
		})

		expect(harness.settingsManager.saveConfig).toHaveBeenCalledWith("prod", { apiProvider: "anthropic" })
		expect(harness.setValue).toHaveBeenCalledWith("listApiConfigMeta", [{ id: "1", name: "prod" }])
	})

	it("saveApiConfiguration reports a failure through the notifier", async () => {
		const harness = makeHarness()
		harness.settingsManager.saveConfig.mockRejectedValueOnce(new Error("disk full"))

		await dispatch(harness, { type: "saveApiConfiguration", text: "prod", apiConfiguration: {} })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("saveApiConfiguration ignores a message missing either half", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "saveApiConfiguration", text: "prod" })
		await dispatch(harness, { type: "saveApiConfiguration", apiConfiguration: {} })

		expect(harness.settingsManager.saveConfig).not.toHaveBeenCalled()
	})

	it("upsertApiConfiguration ACTIVATES by default and refuses to when bool is exactly false", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "upsertApiConfiguration", text: "prod", apiConfiguration: {} })
		expect(harness.provider.upsertProviderProfile).toHaveBeenLastCalledWith("prod", {}, true)

		await dispatch(harness, {
			type: "upsertApiConfiguration",
			text: "prod",
			apiConfiguration: {},
			bool: false,
		})
		expect(harness.provider.upsertProviderProfile).toHaveBeenLastCalledWith("prod", {}, false)
	})

	it("renameApiConfiguration PRESERVES the profile id across the rename", async () => {
		const harness = makeHarness()

		await dispatch(harness, {
			type: "renameApiConfiguration",
			values: { oldName: "old", newName: "new" },
			apiConfiguration: { apiProvider: "anthropic" },
		})

		expect(harness.settingsManager.saveConfig).toHaveBeenCalledWith("new", {
			apiProvider: "anthropic",
			id: "profile-id",
		})
		expect(harness.settingsManager.deleteConfig).toHaveBeenCalledWith("old")
		expect(harness.provider.activateProviderProfile).toHaveBeenCalledWith({ name: "new" })
	})

	it("renameApiConfiguration does NOTHING when the name is unchanged", async () => {
		const harness = makeHarness()

		await dispatch(harness, {
			type: "renameApiConfiguration",
			values: { oldName: "same", newName: "same" },
			apiConfiguration: {},
		})

		expect(harness.settingsManager.saveConfig).not.toHaveBeenCalled()
	})

	it("renameApiConfiguration reports a failure rather than half-renaming silently", async () => {
		const harness = makeHarness()
		harness.settingsManager.getProfile.mockRejectedValueOnce(new Error("no such profile"))

		await dispatch(harness, {
			type: "renameApiConfiguration",
			values: { oldName: "old", newName: "new" },
			apiConfiguration: {},
		})

		expect(hoisted.notifier.error).toHaveBeenCalled()
		expect(harness.settingsManager.deleteConfig).not.toHaveBeenCalled()
	})

	it("loadApiConfiguration does NOT retroactively rewrite existing tasks' sticky profiles", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "loadApiConfiguration", text: "prod" })

		expect(harness.provider.activateProviderProfile).toHaveBeenCalledWith(
			{ name: "prod" },
			{ persistTaskHistory: false },
		)
	})

	it("loadApiConfiguration reports a failure", async () => {
		const harness = makeHarness()
		;(harness.provider.activateProviderProfile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"))

		await dispatch(harness, { type: "loadApiConfiguration", text: "prod" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("loadApiConfigurationById activates by ID and reports a failure", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "loadApiConfigurationById", text: "cfg-1" })
		expect(harness.provider.activateProviderProfile).toHaveBeenCalledWith({ id: "cfg-1" })

		const failing = makeHarness()
		;(failing.provider.activateProviderProfile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"))
		await dispatch(failing, { type: "loadApiConfigurationById", text: "cfg-1" })
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("setDefaultApiConfiguration and loadApiConfigurationForEdit delegate", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "setDefaultApiConfiguration", text: "prod" })
		expect(harness.provider.setDefaultApiConfiguration).toHaveBeenCalledWith("prod")

		await dispatch(harness, { type: "loadApiConfigurationForEdit", text: "prod" })
		expect(harness.provider.loadApiConfigurationForEdit).toHaveBeenCalledWith("prod")
	})

	it("loadApiConfigurationForEdit reports a failure", async () => {
		const harness = makeHarness()
		;(harness.provider.loadApiConfigurationForEdit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("gone"),
		)

		await dispatch(harness, { type: "loadApiConfigurationForEdit", text: "prod" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("setTaskApiConfiguration rebinds ONLY the focused task and leaves the global default alone", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "setTaskApiConfiguration", text: "cfg-1" })

		expect(harness.task!.updateApiConfiguration).toHaveBeenCalled()
		expect(harness.task!.setTaskApiConfigName).toHaveBeenCalledWith("prod")
		expect(harness.provider.updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ apiConfigName: "prod" }),
		)
		expect(harness.setValue).not.toHaveBeenCalledWith("currentApiConfigName", expect.anything())
	})

	it("setTaskApiConfiguration is a no-op with no focused task", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "setTaskApiConfiguration", text: "cfg-1" })

		expect(harness.settingsManager.getProfile).not.toHaveBeenCalled()
	})

	it("setTaskApiConfiguration tolerates a brand-new task that is not in history yet", async () => {
		const harness = makeHarness({ task: makeTask() })
		;(harness.provider.getTaskWithId as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("not found"))

		await dispatch(harness, { type: "setTaskApiConfiguration", text: "cfg-1" })

		expect(harness.provider.postInitState).toHaveBeenCalled()
	})

	it("setTaskApiConfiguration reports a profile lookup failure", async () => {
		const harness = makeHarness({ task: makeTask() })
		harness.settingsManager.getProfile.mockRejectedValueOnce(new Error("no such profile"))

		await dispatch(harness, { type: "setTaskApiConfiguration", text: "cfg-1" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("setModeApiConfig writes the per-mode association, and reports a failure", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "setModeApiConfig", mode: "code", text: "cfg-1" })
		expect(harness.provider.setModeApiConfig).toHaveBeenCalledWith("code", "cfg-1")

		const failing = makeHarness()
		;(failing.provider.setModeApiConfig as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nope"))
		await dispatch(failing, { type: "setModeApiConfig", mode: "code", text: "cfg-1" })
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("setModeApiConfig ignores a message missing the mode or the id", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "setModeApiConfig", text: "cfg-1" })
		await dispatch(harness, { type: "setModeApiConfig", mode: "code" })

		expect(harness.provider.setModeApiConfig).not.toHaveBeenCalled()
	})

	it("deleteApiConfiguration CONFIRMS first, and deletes nothing when declined", async () => {
		const harness = makeHarness()
		hoisted.notifier.showChoice.mockResolvedValueOnce(undefined)

		await dispatch(harness, { type: "deleteApiConfiguration", text: "prod" })

		expect(harness.settingsManager.deleteConfig).not.toHaveBeenCalled()
	})

	it("deleteApiConfiguration REFUSES to delete the LAST profile — something must stay active", async () => {
		const harness = makeHarness()
		hoisted.notifier.showChoice.mockResolvedValueOnce("common:answers.yes")
		harness.settingsManager.listConfig.mockResolvedValueOnce([{ id: "1", name: "prod" }])

		await dispatch(harness, { type: "deleteApiConfiguration", text: "prod" })

		expect(harness.settingsManager.deleteConfig).not.toHaveBeenCalled()
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("deleteApiConfiguration deletes and ACTIVATES a survivor", async () => {
		const harness = makeHarness()
		hoisted.notifier.showChoice.mockResolvedValueOnce("common:answers.yes")
		harness.settingsManager.listConfig.mockResolvedValueOnce([
			{ id: "1", name: "prod" },
			{ id: "2", name: "dev" },
		])

		await dispatch(harness, { type: "deleteApiConfiguration", text: "prod" })

		expect(harness.settingsManager.deleteConfig).toHaveBeenCalledWith("prod")
		expect(harness.provider.activateProviderProfile).toHaveBeenCalledWith({ name: "dev" })
	})

	it("deleteApiConfiguration reports a delete failure", async () => {
		const harness = makeHarness()
		hoisted.notifier.showChoice.mockResolvedValueOnce("common:answers.yes")
		harness.settingsManager.listConfig.mockResolvedValueOnce([
			{ id: "1", name: "prod" },
			{ id: "2", name: "dev" },
		])
		harness.settingsManager.deleteConfig.mockRejectedValueOnce(new Error("locked"))

		await dispatch(harness, { type: "deleteApiConfiguration", text: "prod" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("getListApiConfiguration refreshes the cached list and echoes it", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "getListApiConfiguration" })

		expect(harness.setValue).toHaveBeenCalledWith("listApiConfigMeta", [{ id: "1", name: "prod" }])
		expect(postedOfType(harness, "listApiConfig")[0]).toMatchObject({ listApiConfig: [{ id: "1", name: "prod" }] })
	})

	it("getListApiConfiguration reports a failure", async () => {
		const harness = makeHarness()
		harness.settingsManager.listConfig.mockRejectedValueOnce(new Error("corrupt store"))

		await dispatch(harness, { type: "getListApiConfiguration" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})
})

describe("mcp server configuration", () => {
	it("updateMcpTimeout forwards the timeout, and reports a failure", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "updateMcpTimeout", serverName: "srv", timeout: 60, source: "global" })
		expect(harness.mcpHub.updateServerTimeout).toHaveBeenCalledWith("srv", 60, "global")

		harness.mcpHub.updateServerTimeout.mockRejectedValueOnce(new Error("nope"))
		await dispatch(harness, { type: "updateMcpTimeout", serverName: "srv", timeout: 60 })
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("updateMcpTimeout ignores a NON-NUMERIC timeout", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateMcpTimeout", serverName: "srv", timeout: "60" })

		expect(harness.mcpHub.updateServerTimeout).not.toHaveBeenCalled()
	})

	it("setMcpToolGroup passes NULL to clear a group rather than omitting it", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "setMcpToolGroup", serverName: "srv", toolName: "t", source: "project" })

		expect(harness.mcpHub.setToolGroup).toHaveBeenCalledWith("srv", "project", "t", null)
	})

	it("setMcpToolGroup surfaces the underlying error message", async () => {
		const harness = makeHarness()
		harness.mcpHub.setToolGroup.mockRejectedValueOnce(new Error("unknown group"))

		await dispatch(harness, { type: "setMcpToolGroup", serverName: "srv", toolName: "t", toolGroup: "x" })

		expect(hoisted.notifier.error).toHaveBeenCalledWith("unknown group")
	})

	it("updateMcpServerConfig forwards the edited config, and reports a failure", async () => {
		const harness = makeHarness()
		await dispatch(harness, {
			type: "updateMcpServerConfig",
			serverName: "srv",
			serverConfig: { url: "https://x" },
			source: "global",
		})
		expect(harness.mcpHub.updateServerConfigFromUI).toHaveBeenCalledWith("srv", { url: "https://x" }, "global")

		harness.mcpHub.updateServerConfigFromUI.mockRejectedValueOnce(new Error("bad json"))
		await dispatch(harness, { type: "updateMcpServerConfig", serverName: "srv", serverConfig: {} })
		expect(hoisted.notifier.error).toHaveBeenCalledWith("bad json")
	})

	it("all three ignore a message missing its required fields", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateMcpTimeout", timeout: 5 })
		await dispatch(harness, { type: "setMcpToolGroup", serverName: "srv" })
		await dispatch(harness, { type: "updateMcpServerConfig", serverName: "srv" })

		expect(harness.mcpHub.updateServerTimeout).not.toHaveBeenCalled()
		expect(harness.mcpHub.setToolGroup).not.toHaveBeenCalled()
		expect(harness.mcpHub.updateServerConfigFromUI).not.toHaveBeenCalled()
	})
})

describe("message edit/delete confirmations", () => {
	it("deleteMessageConfirm REFUSES without a timestamp", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "deleteMessageConfirm" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("deleteMessageConfirm REFUSES a non-numeric timestamp", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "deleteMessageConfirm", messageTs: "later" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("deleteMessageConfirm reports a message that is not in the transcript", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "deleteMessageConfirm", messageTs: 999 })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("editMessageConfirm ignores a message missing either the timestamp or the text", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "editMessageConfirm", messageTs: 1 })
		await dispatch(harness, { type: "editMessageConfirm", text: "x" })

		expect(hoisted.notifier.error).not.toHaveBeenCalled()
	})
})

describe("custom modes", () => {
	it("updateCustomMode saves, refreshes state, and reports a NEW mode to telemetry", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateCustomMode", modeConfig: { slug: "brand-new", name: "Brand New" } })

		expect(harness.customModesManager.updateCustomMode).toHaveBeenCalledWith("brand-new", {
			slug: "brand-new",
			name: "Brand New",
		})
		expect(harness.setValue).toHaveBeenCalledWith("customModes", expect.any(Array))
		expect(hoisted.captureCustomModeCreated).toHaveBeenCalledWith("brand-new", "Brand New")
	})

	it("updateCustomMode reports the CHANGED FIELD when the mode already existed", async () => {
		const harness = makeHarness()
		harness.customModesManager.getCustomModes.mockResolvedValue([
			{ slug: "code", name: "Code", roleDefinition: "old" },
		])

		await dispatch(harness, {
			type: "updateCustomMode",
			modeConfig: { slug: "code", name: "Code", roleDefinition: "new" },
		})

		expect(hoisted.captureModeSettingChanged).toHaveBeenCalledWith("roleDefinition")
		expect(hoisted.captureCustomModeCreated).not.toHaveBeenCalled()
	})

	it("updateCustomMode reports NOTHING when nothing actually changed", async () => {
		const harness = makeHarness()
		harness.customModesManager.getCustomModes.mockResolvedValue([{ slug: "code", name: "Code" }])

		await dispatch(harness, { type: "updateCustomMode", modeConfig: { slug: "code", name: "Code" } })

		expect(hoisted.captureModeSettingChanged).not.toHaveBeenCalled()
	})

	it("updateCustomMode SKIPS the state update when the save fails — the manager already told the user", async () => {
		const harness = makeHarness()
		harness.customModesManager.updateCustomMode.mockRejectedValueOnce(new Error("invalid yaml"))

		await dispatch(harness, { type: "updateCustomMode", modeConfig: { slug: "x", name: "X" } })

		expect(harness.setValue).not.toHaveBeenCalled()
		expect(harness.provider.postInitState).not.toHaveBeenCalled()
	})

	it("updateCustomMode ignores an empty payload", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "updateCustomMode" })

		expect(harness.customModesManager.updateCustomMode).not.toHaveBeenCalled()
	})

	it("deleteCustomMode does nothing for a slug the manager does not know", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "deleteCustomMode", slug: "ghost" })

		expect(harness.customModesManager.deleteCustomMode).not.toHaveBeenCalled()
	})

	it("deleteCustomMode ignores a message with no slug", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "deleteCustomMode" })

		expect(harness.customModesManager.getCustomModes).not.toHaveBeenCalled()
	})

	it("checkRulesDirectory answers the webview, keyed by slug", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "checkRulesDirectory", slug: "code" })

		expect(postedOfType(harness, "checkRulesDirectoryResult")[0]).toEqual({
			type: "checkRulesDirectoryResult",
			slug: "code",
			hasContent: true,
		})
	})

	it("checkRulesDirectory ignores a message with no slug", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "checkRulesDirectory" })

		expect(harness.posted()).toEqual([])
	})
})

describe("the Telemetry Toggle Ordering Rule", () => {
	it("fires the change event BEFORE disabling, so it is captured under the still-enabled side", async () => {
		const harness = makeHarness()
		harness.state.telemetrySetting = "enabled"
		const order: string[] = []
		hoisted.captureTelemetrySettingsChanged.mockImplementation(() => order.push("captured"))
		hoisted.updateTelemetryState.mockImplementation(() => order.push("state-updated"))

		await dispatch(harness, { type: "telemetrySetting", text: "disabled" })

		expect(order).toEqual(["captured", "state-updated"])
		expect(hoisted.captureTelemetrySettingsChanged).toHaveBeenCalledWith("enabled", "disabled")
	})

	it("fires the change event AFTER enabling, for the same reason", async () => {
		const harness = makeHarness()
		harness.state.telemetrySetting = "disabled"
		const order: string[] = []
		hoisted.captureTelemetrySettingsChanged.mockImplementation(() => order.push("captured"))
		hoisted.updateTelemetryState.mockImplementation(() => order.push("state-updated"))

		await dispatch(harness, { type: "telemetrySetting", text: "enabled" })

		expect(order).toEqual(["state-updated", "captured"])
	})

	it("treats an ABSENT prior setting as opted-in, so enabling fires nothing", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "telemetrySetting", text: "enabled" })

		expect(hoisted.captureTelemetrySettingsChanged).not.toHaveBeenCalled()
		expect(harness.setValue).toHaveBeenCalledWith("telemetrySetting", "enabled")
		expect(harness.provider.postConfigUpdate).toHaveBeenCalledWith("telemetrySetting", "enabled")
	})

	it("debugSetting persists to globalSettings, defaulting to OFF", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "debugSetting" })

		expect(harness.setValue).toHaveBeenCalledWith("debug", false)
		expect(harness.provider.postConfigUpdate).toHaveBeenCalledWith("debug", false)
	})
})

describe("retired cloud surfaces", () => {
	it.each(["shoferCloudSignIn", "cloudLandingPageSignIn"])(
		"%s says so rather than failing silently",
		async (type) => {
			const harness = makeHarness()

			await dispatch(harness, { type })

			expect(hoisted.notifier.error).toHaveBeenCalledWith("Cloud services have been removed.")
		},
	)

	it("shoferCloudSignOut is a no-op", async () => {
		const harness = makeHarness()

		await expect(dispatch(harness, { type: "shoferCloudSignOut" })).resolves.toBeUndefined()
	})

	it("shoferCloudManualUrl REFUSES an empty url", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "shoferCloudManualUrl", text: "  " })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("shoferCloudManualUrl reports a url carrying no query", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "shoferCloudManualUrl", text: "https://example.com" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})
})

describe("walkthrough", () => {
	it("walkthroughOpen asks the workbench for the qualified walkthrough id", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "walkthroughOpen" })

		expect(hoisted.executeCommand).toHaveBeenCalledWith(
			"workbench.action.openWalkthrough",
			expect.stringContaining("#shofer.getStarted"),
			false,
		)
	})
})

describe("prompt enhancement and preview", () => {
	it("enhancePrompt posts the enhanced text back", async () => {
		const harness = makeHarness()
		hoisted.enhanceMessage.mockResolvedValueOnce({ success: true, enhancedText: "a better prompt" })

		await dispatch(harness, { type: "enhancePrompt", text: "do it" })

		expect(postedOfType(harness, "enhancedPrompt")[0]).toEqual({ type: "enhancedPrompt", text: "a better prompt" })
	})

	it("enhancePrompt posts an EMPTY reply on failure, so the webview stops waiting", async () => {
		const harness = makeHarness()
		hoisted.enhanceMessage.mockResolvedValueOnce({ success: false, error: "no api key" })

		await dispatch(harness, { type: "enhancePrompt", text: "do it" })

		expect(postedOfType(harness, "enhancedPrompt")[0]).toEqual({ type: "enhancedPrompt" })
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("enhancePrompt ignores an empty request", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "enhancePrompt" })

		expect(hoisted.enhanceMessage).not.toHaveBeenCalled()
	})

	it("getSystemPrompt returns the assembled prompt, keyed by mode", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "getSystemPrompt", mode: "architect" })

		expect(postedOfType(harness, "systemPrompt")[0]).toEqual({
			type: "systemPrompt",
			text: "SYSTEM PROMPT",
			mode: "architect",
		})
	})

	it("getSystemPrompt reports a failure rather than posting a blank prompt", async () => {
		const harness = makeHarness()
		hoisted.generateSystemPrompt.mockRejectedValueOnce(new Error("no handler"))

		await dispatch(harness, { type: "getSystemPrompt" })

		expect(postedOfType(harness, "systemPrompt")).toEqual([])
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("copySystemPrompt puts it on the CLIPBOARD and confirms", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "copySystemPrompt" })

		expect(hoisted.clipboardWrite).toHaveBeenCalledWith("SYSTEM PROMPT")
		expect(hoisted.notifier.info).toHaveBeenCalled()
	})

	it("copySystemPrompt reports a failure", async () => {
		const harness = makeHarness()
		hoisted.generateSystemPrompt.mockRejectedValueOnce(new Error("no handler"))

		await dispatch(harness, { type: "copySystemPrompt" })

		expect(hoisted.clipboardWrite).not.toHaveBeenCalled()
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})
})

describe("commit search", () => {
	it("posts the commits it found", async () => {
		const harness = makeHarness()
		hoisted.searchCommits.mockResolvedValueOnce([{ hash: "abc", subject: "fix" }])

		await dispatch(harness, { type: "searchCommits", query: "fix" })

		expect(postedOfType(harness, "commitSearchResults")[0]).toMatchObject({
			commits: [{ hash: "abc", subject: "fix" }],
		})
	})

	it("searches with an EMPTY query rather than refusing", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "searchCommits" })

		expect(hoisted.searchCommits).toHaveBeenCalledWith("", "/workspace")
	})

	it("reports a search failure", async () => {
		const harness = makeHarness()
		hoisted.searchCommits.mockRejectedValueOnce(new Error("not a git repo"))

		await dispatch(harness, { type: "searchCommits", query: "x" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})
})

describe("todo list approval", () => {
	it("scopes the edited list to the CURRENT TASK rather than a module global", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "updateTodoList", payload: { todos: [{ id: "1", text: "a" }] } })

		expect(harness.task!.pendingTodoApproval).toEqual([{ id: "1", text: "a" }])
	})

	it("ignores a payload whose todos are not an array", async () => {
		const harness = makeHarness({ task: makeTask() })

		await dispatch(harness, { type: "updateTodoList", payload: { todos: "nope" } })

		expect(harness.task!.pendingTodoApproval).toBeUndefined()
	})

	it("is a no-op with no current task", async () => {
		const harness = makeHarness()

		await expect(dispatch(harness, { type: "updateTodoList", payload: { todos: [] } })).resolves.toBeUndefined()
	})
})

describe("custom tools", () => {
	it("reloads the tool directories and posts the serialized registry", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "refreshCustomTools" })

		expect(postedOfType(harness, "customToolsResult")[0]).toMatchObject({ tools: [] })
	})

	it("answers with an EMPTY registry and the error when a tool file is malformed", async () => {
		const harness = makeHarness()
		hoisted.loadFromDirectories.mockRejectedValueOnce(new Error("bad tool"))

		await dispatch(harness, { type: "refreshCustomTools" })

		expect(postedOfType(harness, "customToolsResult")[0]).toMatchObject({ tools: [], error: "bad tool" })
	})
})

describe("slash commands", () => {
	it("openCommandFile opens the resolved file", async () => {
		const harness = makeHarness()
		hoisted.getSlashCommand.mockResolvedValueOnce({ name: "review", filePath: "/w/.shofer/commands/review.md" })

		await dispatch(harness, { type: "openCommandFile", text: "review" })

		expect(hoisted.openFile).toHaveBeenCalledWith("/w/.shofer/commands/review.md")
	})

	it("openCommandFile reports a command nobody defines", async () => {
		const harness = makeHarness()
		hoisted.getSlashCommand.mockResolvedValueOnce(undefined)

		await dispatch(harness, { type: "openCommandFile", text: "ghost" })

		expect(hoisted.notifier.error).toHaveBeenCalled()
		expect(hoisted.openFile).not.toHaveBeenCalled()
	})

	it("openCommandFile ignores a message with no name, and reports a lookup failure", async () => {
		const harness = makeHarness()
		await dispatch(harness, { type: "openCommandFile" })
		expect(hoisted.getSlashCommand).not.toHaveBeenCalled()

		hoisted.getSlashCommand.mockRejectedValueOnce(new Error("bad glob"))
		await dispatch(harness, { type: "openCommandFile", text: "review" })
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("deleteCommand removes the resolved file", async () => {
		const harness = makeHarness()
		hoisted.getSlashCommand.mockResolvedValueOnce({ name: "review", filePath: "/w/.shofer/commands/review.md" })

		await dispatch(harness, { type: "deleteCommand", text: "review", values: { source: "project" } })

		expect(hoisted.unlink).toHaveBeenCalledWith("/w/.shofer/commands/review.md")
	})

	it("deleteCommand needs BOTH a name and a source", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "deleteCommand", text: "review" })
		await dispatch(harness, { type: "deleteCommand", values: { source: "project" } })

		expect(hoisted.unlink).not.toHaveBeenCalled()
	})

	it("deleteCommand reports a command nobody defines, and a delete failure", async () => {
		const missing = makeHarness()
		hoisted.getSlashCommand.mockResolvedValueOnce(undefined)
		await dispatch(missing, { type: "deleteCommand", text: "ghost", values: { source: "global" } })
		expect(hoisted.notifier.error).toHaveBeenCalled()

		const failing = makeHarness()
		hoisted.getSlashCommand.mockResolvedValueOnce({ name: "review", filePath: "/w/r.md" })
		hoisted.unlink.mockRejectedValueOnce(new Error("EACCES"))
		await dispatch(failing, { type: "deleteCommand", text: "review", values: { source: "global" } })
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("createCommand REFUSES without a source", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "createCommand" })

		expect(hoisted.mkdir).not.toHaveBeenCalled()
		expect(harness.log).toHaveBeenCalledWith("Missing source for createCommand")
	})

	it("createCommand REFUSES a project command with no workspace open", async () => {
		const harness = makeHarness()
		hoisted.workspaceFolders = undefined

		await dispatch(harness, { type: "createCommand", values: { source: "project" } })

		expect(hoisted.notifier.error).toHaveBeenCalled()
		expect(hoisted.mkdir).not.toHaveBeenCalled()
	})

	it("SLUGIFIES the name the user typed, stripping a leading slash and an .md suffix", async () => {
		const harness = makeHarness()
		hoisted.access.mockRejectedValue(new Error("ENOENT"))

		await dispatch(harness, { type: "createCommand", text: "/My Review Command.MD", values: { source: "global" } })

		const [written] = hoisted.writeFile.mock.calls[0] as [string]
		expect(written).toMatch(/my-review-command\.md$/)
	})

	it("falls back to 'new-command' when slugifying leaves nothing", async () => {
		const harness = makeHarness()
		hoisted.access.mockRejectedValue(new Error("ENOENT"))

		await dispatch(harness, { type: "createCommand", text: "!!!", values: { source: "global" } })

		const [written] = hoisted.writeFile.mock.calls[0] as [string]
		expect(written).toMatch(/new-command\.md$/)
	})

	it("REFUSES to overwrite a command that already exists", async () => {
		const harness = makeHarness()
		hoisted.access.mockResolvedValue(undefined)

		await dispatch(harness, { type: "createCommand", text: "review", values: { source: "global" } })

		expect(hoisted.writeFile).not.toHaveBeenCalled()
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("opens the new command and REFRESHES the command list", async () => {
		const harness = makeHarness()
		hoisted.access.mockRejectedValue(new Error("ENOENT"))

		await dispatch(harness, { type: "createCommand", text: "review", values: { source: "project" } })

		expect(hoisted.openFile).toHaveBeenCalled()
		expect(postedOfType(harness, "commands")).toHaveLength(1)
	})

	it("reports a creation failure", async () => {
		const harness = makeHarness()
		hoisted.access.mockRejectedValue(new Error("ENOENT"))
		hoisted.mkdir.mockRejectedValueOnce(new Error("EROFS"))

		await dispatch(harness, { type: "createCommand", values: { source: "global" } })

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})
})

describe("openAI Codex rate limits", () => {
	it("answers with an error when the user is not signed in", async () => {
		const harness = makeHarness()
		hoisted.getAccessToken.mockResolvedValueOnce(null)

		await dispatch(harness, { type: "requestOpenAiCodexRateLimits" })

		expect(postedOfType(harness, "openAiCodexRateLimits")[0]).toMatchObject({
			error: "Not authenticated with OpenAI Codex",
		})
	})

	it("passes the account id through and posts the reading", async () => {
		const harness = makeHarness()
		hoisted.fetchRateLimits.mockResolvedValueOnce({ fetchedAt: 1, primary: { usedPercent: 10 } })

		await dispatch(harness, { type: "requestOpenAiCodexRateLimits" })

		expect(hoisted.fetchRateLimits).toHaveBeenCalledWith("token-1", { accountId: "acct-1" })
		expect(postedOfType(harness, "openAiCodexRateLimits")[0]).toMatchObject({
			values: { fetchedAt: 1, primary: { usedPercent: 10 } },
		})
	})

	it("answers with the failure message rather than a stale reading", async () => {
		const harness = makeHarness()
		hoisted.fetchRateLimits.mockRejectedValueOnce(new Error("upstream down"))

		await dispatch(harness, { type: "requestOpenAiCodexRateLimits" })

		expect(postedOfType(harness, "openAiCodexRateLimits")[0]).toMatchObject({ error: "upstream down" })
	})
})

describe("codex sign in / out", () => {
	it("signIn opens the authorization url in the browser", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openAiCodexSignIn" })

		expect(hoisted.startAuthorizationFlow).toHaveBeenCalled()
		expect(hoisted.openExternal).toHaveBeenCalled()
	})

	it("signIn reports a failure to start the flow", async () => {
		const harness = makeHarness()
		hoisted.startAuthorizationFlow.mockImplementationOnce(() => {
			throw new Error("port in use")
		})

		await dispatch(harness, { type: "openAiCodexSignIn" })

		expect(hoisted.notifier.error).toHaveBeenCalledWith("OpenAI Codex sign in failed.")
	})

	it("signOut clears the credentials and refreshes state", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openAiCodexSignOut" })

		expect(hoisted.clearCredentials).toHaveBeenCalled()
		expect(harness.provider.postInitState).toHaveBeenCalled()
		expect(hoisted.notifier.info).toHaveBeenCalled()
	})

	it("signOut reports a failure", async () => {
		const harness = makeHarness()
		hoisted.clearCredentials.mockRejectedValueOnce(new Error("locked"))

		await dispatch(harness, { type: "openAiCodexSignOut" })

		expect(hoisted.notifier.error).toHaveBeenCalledWith("OpenAI Codex sign out failed.")
	})
})

describe("debug history", () => {
	it("REFUSES without an active task", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "openDebugApiHistory" })

		expect(hoisted.notifier.error).toHaveBeenCalledWith("No active task to view history for")
	})

	it("reports a history file that does not exist, naming it", async () => {
		const harness = makeHarness({ task: makeTask() })
		hoisted.fileExists.mockResolvedValueOnce(false)

		await dispatch(harness, { type: "openDebugUiHistory" })

		expect(hoisted.notifier.error).toHaveBeenCalledWith("File not found: ui_messages.jsonl")
	})

	it("PRETTIFIES the JSONL into an array and opens it as a temp document", async () => {
		const harness = makeHarness({ task: makeTask() })
		hoisted.readFile.mockResolvedValueOnce('{"a":1}\n{"b":2}\n')

		await dispatch(harness, { type: "openDebugApiHistory" })

		const [tmpPath, contents] = hoisted.writeFile.mock.calls[0] as [string, string]
		expect(tmpPath).toMatch(/shofer-debug-api-task-1-\d+\.json$/)
		expect(JSON.parse(contents)).toEqual([{ a: 1 }, { b: 2 }])
		expect(hoisted.showTextDocument).toHaveBeenCalled()
	})

	it("TOLERATES a truncated final line — a live task's log is mid-write", async () => {
		const harness = makeHarness({ task: makeTask() })
		hoisted.readFile.mockResolvedValueOnce('{"a":1}\n{"b":2')

		await dispatch(harness, { type: "openDebugApiHistory" })

		const [, contents] = hoisted.writeFile.mock.calls[0] as [string, string]
		expect(JSON.parse(contents)).toEqual([{ a: 1 }])
	})

	it("REFUSES a file whose corruption is not at the end", async () => {
		const harness = makeHarness({ task: makeTask() })
		hoisted.readFile.mockResolvedValueOnce('{"a":1\n{"b":2}\n')

		await dispatch(harness, { type: "openDebugApiHistory" })

		expect(hoisted.notifier.error).toHaveBeenCalledWith("Failed to parse api_conversation_history.jsonl")
		expect(hoisted.writeFile).not.toHaveBeenCalled()
	})

	it("reports an unexpected failure", async () => {
		const harness = makeHarness({ task: makeTask() })
		hoisted.readFile.mockRejectedValueOnce(new Error("EIO"))

		await dispatch(harness, { type: "openDebugUiHistory" })

		expect(hoisted.notifier.error).toHaveBeenCalledWith(expect.stringContaining("Failed to open debug history"))
	})
})

describe("selectImages", () => {
	it("posts the selected images back to the chat input", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "selectImages" })

		expect(harness.posted().some((m) => JSON.stringify(m).includes("data:image/png"))).toBe(true)
	})
})

describe("provider model catalogs", () => {
	it("requestOllamaModels FLUSHES the cache first, so a newly pulled model appears", async () => {
		const harness = makeHarness()
		hoisted.getModels.mockResolvedValueOnce({ "llama3:latest": {} })

		await dispatch(harness, { type: "requestOllamaModels" })

		expect(hoisted.flushModels).toHaveBeenCalledWith(expect.objectContaining({ provider: "ollama" }), true)
		expect(postedOfType(harness, "ollamaModels")[0]).toMatchObject({ ollamaModels: { "llama3:latest": {} } })
	})

	it("requestOllamaModels posts NOTHING when the catalog is empty — the user has not configured it", async () => {
		const harness = makeHarness()
		hoisted.getModels.mockResolvedValueOnce({})

		await dispatch(harness, { type: "requestOllamaModels" })

		expect(postedOfType(harness, "ollamaModels")).toEqual([])
	})

	it("requestOllamaModels FAILS SILENTLY — an unconfigured provider is not an error", async () => {
		const harness = makeHarness()
		hoisted.getModels.mockRejectedValueOnce(new Error("ECONNREFUSED"))

		await expect(dispatch(harness, { type: "requestOllamaModels" })).resolves.toBeUndefined()
		expect(hoisted.notifier.error).not.toHaveBeenCalled()
	})

	it("requestLmStudioModels behaves the same way", async () => {
		const harness = makeHarness()
		hoisted.getModels.mockResolvedValueOnce({ "local-model": {} })

		await dispatch(harness, { type: "requestLmStudioModels" })

		expect(hoisted.flushModels).toHaveBeenCalledWith(expect.objectContaining({ provider: "lmstudio" }), true)
		expect(postedOfType(harness, "lmStudioModels")[0]).toMatchObject({ lmStudioModels: { "local-model": {} } })
	})

	it("requestLmStudioModels fails silently and posts nothing on an empty catalog", async () => {
		const empty = makeHarness()
		hoisted.getModels.mockResolvedValueOnce({})
		await dispatch(empty, { type: "requestLmStudioModels" })
		expect(postedOfType(empty, "lmStudioModels")).toEqual([])

		const failing = makeHarness()
		hoisted.getModels.mockRejectedValueOnce(new Error("ECONNREFUSED"))
		await expect(dispatch(failing, { type: "requestLmStudioModels" })).resolves.toBeUndefined()
	})

	it("requestRooModels answers SUCCESSFULLY WITH NOTHING — the cloud catalog is retired", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "requestRooModels" })

		expect(postedOfType(harness, "singleRouterModelFetchResponse")[0]).toEqual({
			type: "singleRouterModelFetchResponse",
			success: true,
			values: {},
		})
	})

	it("requestRooCreditBalance answers with an explanation, keyed by request id", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "requestRooCreditBalance", requestId: "r-1" })

		expect(postedOfType(harness, "shoferCreditBalance")[0]).toEqual({
			type: "shoferCreditBalance",
			requestId: "r-1",
			values: { error: "Cloud services removed" },
		})
	})

	it("requestOpenAiModels needs BOTH a base url and a key", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "requestOpenAiModels", values: { baseUrl: "https://x" } })
		await dispatch(harness, { type: "requestOpenAiModels", values: { apiKey: "sk" } })

		expect(hoisted.getOpenAiModels).not.toHaveBeenCalled()
	})

	it("requestOpenAiModels forwards the custom headers", async () => {
		const harness = makeHarness()
		hoisted.getOpenAiModels.mockResolvedValueOnce({ "gpt-5": {} })

		await dispatch(harness, {
			type: "requestOpenAiModels",
			values: { baseUrl: "https://x", apiKey: "sk", openAiHeaders: { "X-Org": "o" } },
		})

		expect(hoisted.getOpenAiModels).toHaveBeenCalledWith("https://x", "sk", { "X-Org": "o" })
		expect(postedOfType(harness, "openAiModels")[0]).toMatchObject({ openAiModels: { "gpt-5": {} } })
	})

	it("requestVsCodeLmModels answers with whatever the editor enumerates", async () => {
		const harness = makeHarness()
		hoisted.getVsCodeLmModels.mockResolvedValueOnce([{ id: "copilot/gpt-4o" }])

		await dispatch(harness, { type: "requestVsCodeLmModels" })

		expect(postedOfType(harness, "vsCodeLmModels")[0]).toMatchObject({
			vsCodeLmModels: [{ id: "copilot/gpt-4o" }],
		})
	})
})

describe("mode export", () => {
	it("ignores a request with no slug", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "exportMode" })

		expect(harness.customModesManager.exportModeWithRules).not.toHaveBeenCalled()
	})

	it("MERGES the user's prompt customizations into the exported document", async () => {
		const harness = makeHarness()
		harness.state.customModePrompts = { code: { roleDefinition: "mine" } }
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/home/u/code-export.yaml" })

		await dispatch(harness, { type: "exportMode", slug: "code" })

		expect(harness.customModesManager.exportModeWithRules).toHaveBeenCalledWith("code", {
			roleDefinition: "mine",
		})
	})

	it("writes the document, REMEMBERS the directory, and reports success", async () => {
		const harness = makeHarness()
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/home/u/code-export.yaml" })

		await dispatch(harness, { type: "exportMode", slug: "code" })

		expect(hoisted.writeFile).toHaveBeenCalledWith("/home/u/code-export.yaml", "slug: code\n", "utf-8")
		expect(harness.setValue).toHaveBeenCalledWith("lastModeExportPath", "/home/u/code-export.yaml")
		expect(postedOfType(harness, "exportModeResult")[0]).toMatchObject({ success: true, slug: "code" })
	})

	it("reports a CANCELLED save as a failure the panel can render", async () => {
		const harness = makeHarness()
		hoisted.showSaveDialog.mockResolvedValueOnce(undefined)

		await dispatch(harness, { type: "exportMode", slug: "code" })

		expect(postedOfType(harness, "exportModeResult")[0]).toMatchObject({
			success: false,
			error: "Export cancelled",
		})
		expect(hoisted.writeFile).not.toHaveBeenCalled()
	})

	it("passes the exporter's OWN error through to the panel", async () => {
		const harness = makeHarness()
		harness.customModesManager.exportModeWithRules.mockResolvedValueOnce({
			success: false,
			error: "mode not found",
		})

		await dispatch(harness, { type: "exportMode", slug: "ghost" })

		expect(postedOfType(harness, "exportModeResult")[0]).toMatchObject({
			success: false,
			error: "mode not found",
			slug: "ghost",
		})
	})

	it("reports an unexpected failure rather than leaving the panel spinning", async () => {
		const harness = makeHarness()
		harness.customModesManager.exportModeWithRules.mockRejectedValueOnce(new Error("disk full"))

		await dispatch(harness, { type: "exportMode", slug: "code" })

		expect(postedOfType(harness, "exportModeResult")[0]).toMatchObject({ success: false, error: "disk full" })
	})
})

/**
 * `webviewDidLaunch` — the one message whose job is a whole SNAPSHOT rather than
 * a decision. Everything the webview needs before it can render is pushed here,
 * and each piece fails as an absence: a missing `parallelTasksUpdated` leaves the
 * TaskSelector empty, missing notifications leave the badge at zero, and a
 * missing `listApiConfig` leaves the profile picker blank — all with a fully
 * working extension behind them.
 */
describe("webviewDidLaunch", () => {
	it("pushes the parallel-task snapshot AND which of them has focus", async () => {
		const harness = makeHarness({
			focusedTaskId: "t-1",
			managedTasks: [
				{
					id: "m-1",
					name: "First",
					taskId: "t-1",
					workspace: "/w",
					createdAt: 1,
					lastActiveAt: 2,
					state: { lifecycle: "running" },
					activeTimeMs: 500,
				},
			],
		})
		await dispatch(harness, { type: "webviewDidLaunch" })

		const [snapshot] = postedOfType(harness, "parallelTasksUpdated")
		expect(snapshot.parallelTasks).toEqual([
			expect.objectContaining({ id: "m-1", taskId: "t-1", activeTimeMs: 500 }),
		])
		expect(snapshot.focusedTaskId).toBe("t-1")
	})

	it("REPLAYS notifications that accumulated before the webview could listen", async () => {
		const harness = makeHarness({
			taskNotifications: [
				{ targetTaskId: "t-1", type: "needs_input", message: "Approve?", timestamp: 7 },
				{ targetTaskId: "t-2", type: "completed", message: "Done", timestamp: 8 },
			],
		})

		await dispatch(harness, { type: "webviewDidLaunch" })

		expect(
			postedOfType(harness, "taskNotification").map((m) => (m.notification as { taskId: string }).taskId),
		).toEqual(["t-1", "t-2"])
	})

	it("sends the theme and the MCP server list", async () => {
		const harness = makeHarness()
		harness.provider.getMcpHub = vi.fn(() => ({ getAllServers: () => [{ name: "srv" }] })) as never

		await dispatch(harness, { type: "webviewDidLaunch" })
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(postedOfType(harness, "theme")[0].text).toContain("dark")
		expect(postedOfType(harness, "mcpServers")[0].mcpServers).toEqual([{ name: "srv" }])
	})

	it("omits the server list entirely when the hub is not up yet", async () => {
		const harness = makeHarness({ noMcpHub: true })

		await dispatch(harness, { type: "webviewDidLaunch" })

		expect(postedOfType(harness, "mcpServers")).toEqual([])
	})

	it("pushes the profile list and records it in state", async () => {
		const harness = makeHarness()
		harness.provider.providerSettingsManager.hasConfig = vi.fn(async () => true) as never
		harness.state.currentApiConfigName = "prod"

		await dispatch(harness, { type: "webviewDidLaunch" })
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(postedOfType(harness, "listApiConfig")[0].listApiConfig).toEqual([{ id: "1", name: "prod" }])
	})

	it("REPAIRS a dangling current-profile name by activating the first real one", async () => {
		const harness = makeHarness()
		harness.provider.providerSettingsManager.hasConfig = vi.fn(async () => false) as never
		harness.state.currentApiConfigName = "deleted-profile"

		await dispatch(harness, { type: "webviewDidLaunch" })
		await new Promise((resolve) => setTimeout(resolve, 0))

		// Otherwise every later read resolves a profile that is not there and the
		// user sees an empty configuration with no explanation.
		expect(harness.provider.activateProviderProfile).toHaveBeenCalledWith({ name: "prod" })
	})

	it("LOGS rather than throwing when the profile list cannot be read", async () => {
		const harness = makeHarness()
		harness.provider.providerSettingsManager.listConfig = vi.fn(async () => {
			throw new Error("secrets locked")
		}) as never

		await dispatch(harness, { type: "webviewDidLaunch" })
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("Error list api configuration"))
	})

	it("marks the view launched, so the provider stops treating pushes as pre-launch", async () => {
		const harness = makeHarness()

		await dispatch(harness, { type: "webviewDidLaunch" })

		expect(harness.provider.isViewLaunched).toBe(true)
	})
})

describe("importMode", () => {
	it("reads the picked file and imports it at the requested scope", async () => {
		const harness = makeHarness()
		hoisted.showOpenDialog.mockResolvedValue([{ fsPath: "/home/u/modes/exported.yaml" }])
		hoisted.readFile.mockResolvedValue("customModes: []\n")

		await dispatch(harness, { type: "importMode", source: "global" })

		expect(harness.provider.customModesManager.importModeWithRules).toHaveBeenCalledWith(
			"customModes: []\n",
			"global",
		)
		expect(postedOfType(harness, "importModeResult")[0]).toMatchObject({ success: true, slug: "imported" })
	})

	it("defaults to the PROJECT scope when the caller named none", async () => {
		const harness = makeHarness()
		hoisted.showOpenDialog.mockResolvedValue([{ fsPath: "/f.yaml" }])

		await dispatch(harness, { type: "importMode" })

		expect(harness.provider.customModesManager.importModeWithRules).toHaveBeenCalledWith(
			expect.anything(),
			"project",
		)
	})

	it("REMEMBERS the directory so the next import opens where the last one did", async () => {
		const harness = makeHarness()
		hoisted.showOpenDialog.mockResolvedValue([{ fsPath: "/home/u/modes/exported.yaml" }])

		await dispatch(harness, { type: "importMode" })

		expect(harness.state.lastModeImportPath).toBe("/home/u/modes/exported.yaml")
	})

	it("answers 'cancelled' rather than nothing when the picker is dismissed", async () => {
		const harness = makeHarness()
		hoisted.showOpenDialog.mockResolvedValue(undefined)

		await dispatch(harness, { type: "importMode" })

		// The webview leaves an "importing…" state on screen forever if this
		// message never arrives.
		expect(postedOfType(harness, "importModeResult")[0]).toMatchObject({ success: false, error: "cancelled" })
	})

	it("reports a REFUSED import back to the webview and to the user", async () => {
		const harness = makeHarness()
		hoisted.showOpenDialog.mockResolvedValue([{ fsPath: "/f.yaml" }])
		harness.provider.customModesManager.importModeWithRules = vi.fn(async () => ({
			success: false,
			error: "not a mode export",
		})) as never

		await dispatch(harness, { type: "importMode" })

		expect(postedOfType(harness, "importModeResult")[0]).toMatchObject({
			success: false,
			error: "not a mode export",
		})
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("reports an unreadable file as a failure instead of throwing out of the dispatcher", async () => {
		const harness = makeHarness()
		hoisted.showOpenDialog.mockResolvedValue([{ fsPath: "/f.yaml" }])
		hoisted.readFile.mockRejectedValueOnce(new Error("EACCES"))

		await expect(dispatch(harness, { type: "importMode" })).resolves.toBeUndefined()

		expect(postedOfType(harness, "importModeResult")[0]).toMatchObject({ success: false, error: "EACCES" })
	})
})
