// pnpm --filter @shofer/cli test src/agent/__tests__/extension-host.test.ts

import { EventEmitter } from "events"
import fs from "fs"
import fsp from "fs/promises"
import os from "os"
import path from "path"

import type { ExtensionMessage, WebviewMessage, ShoferExtensionApi } from "@shofer/types"

import { DEFAULT_FLAGS } from "@/types/index.js"

import { type ExtensionHostOptions, ExtensionHost } from "../extension-host.js"
import { ExtensionClient } from "../extension-client.js"
import { AgentLoopState } from "../agent-state.js"

vi.mock("@shofer/vscode-shim", () => ({
	createVSCodeAPI: vi.fn(() => ({
		context: { extensionPath: "/test/extension" },
	})),
	setRuntimeConfigValues: vi.fn(),
}))

vi.mock("@/lib/storage/index.js", () => ({
	createEphemeralStorageDir: vi.fn(() => Promise.resolve("/tmp/shofer-cli-test-ephemeral")),
}))

/**
 * Create a mock ShoferExtensionApi for testing.
 */
function createMockShoferAPI(): ShoferExtensionApi {
	const emitter = new EventEmitter() as ShoferExtensionApi
	const createTask = vi.fn().mockResolvedValue({ taskId: "test-task-id" })
	const resumeTask = vi.fn().mockResolvedValue(undefined)

	return Object.assign(emitter, {
		createTask,
		resumeTask,
		cancelTask: vi.fn().mockResolvedValue(undefined),
		clearCurrentTask: vi.fn().mockResolvedValue(undefined),
		sendMessage: vi.fn().mockResolvedValue(undefined),
		respondToAsk: vi.fn().mockResolvedValue(undefined),
		deleteQueuedMessage: vi.fn(),
		isReady: vi.fn().mockReturnValue(true),
		isTaskInHistory: vi.fn().mockResolvedValue(false),
		// The CLI surface is current-task-shaped and resolves the id from the stack
		// before calling the task-addressed API.
		getCurrentTaskStack: vi.fn().mockReturnValue(["test-task-id"]),
		getConfiguration: vi.fn().mockReturnValue({}),
		setConfiguration: vi.fn().mockResolvedValue(undefined),
		getProfiles: vi.fn().mockReturnValue([]),
		getProfileEntry: vi.fn().mockReturnValue(undefined),
		createProfile: vi.fn().mockResolvedValue("profile-id"),
		updateProfile: vi.fn().mockResolvedValue("profile-id"),
		upsertProfile: vi.fn().mockResolvedValue("profile-id"),
		deleteProfile: vi.fn().mockResolvedValue(undefined),
		getActiveProfile: vi.fn().mockReturnValue(undefined),
		setActiveProfile: vi.fn().mockResolvedValue(undefined),
	})
}

/**
 * Set the private extensionAPI field on an ExtensionHost.
 */
function setExtensionAPI(host: ExtensionHost, api: ShoferExtensionApi): void {
	;(host as unknown as Record<string, unknown>)["extensionAPI"] = api
}

/**
 * Create a test ExtensionHost with default options.
 */
function createTestHost({
	mode = "code",
	provider = "openrouter",
	model = "test-model",
	...options
}: Partial<ExtensionHostOptions> = {}): ExtensionHost {
	const host = new ExtensionHost({
		mode,
		user: null,
		provider,
		model,
		workspacePath: "/test/workspace",
		extensionPath: "/test/extension",
		ephemeral: false,
		debug: false,
		exitOnComplete: false,
		...options,
	})
	// Inject a mock ShoferExtensionApi so runTask/resumeTask don't throw.
	setExtensionAPI(host, createMockShoferAPI())
	return host
}

// Type for accessing private members
type PrivateHost = Record<string, unknown>

/**
 * Helper to access private members for testing
 */
function getPrivate<T>(host: ExtensionHost, key: string): T {
	return (host as unknown as PrivateHost)[key] as T
}

/**
 * Helper to set private members for testing
 */
function setPrivate(host: ExtensionHost, key: string, value: unknown): void {
	;(host as unknown as PrivateHost)[key] = value
}

/**
 * Helper to call private methods for testing
 * This uses a more permissive type to avoid TypeScript errors with private methods
 */
function callPrivate<T>(host: ExtensionHost, method: string, ...args: unknown[]): T {
	const fn = (host as unknown as PrivateHost)[method] as ((...a: unknown[]) => T) | undefined
	if (!fn) throw new Error(`Method ${method} not found`)
	return fn.apply(host, args)
}

/**
 * Helper to spy on private methods
 * This uses a more permissive type to avoid TypeScript errors with vi.spyOn on private methods
 */
function spyOnPrivate(host: ExtensionHost, method: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return vi.spyOn(host as any, method)
}

describe("ExtensionHost", () => {
	const initialShoferCliRuntimeEnv = process.env.SHOFER_CLI_RUNTIME

	beforeEach(() => {
		vi.resetAllMocks()
		if (initialShoferCliRuntimeEnv === undefined) {
			delete process.env.SHOFER_CLI_RUNTIME
		} else {
			process.env.SHOFER_CLI_RUNTIME = initialShoferCliRuntimeEnv
		}
		// Clean up globals
		delete (global as Record<string, unknown>).vscode
		delete (global as Record<string, unknown>).__extensionHost
	})

	afterAll(() => {
		if (initialShoferCliRuntimeEnv === undefined) {
			delete process.env.SHOFER_CLI_RUNTIME
		} else {
			process.env.SHOFER_CLI_RUNTIME = initialShoferCliRuntimeEnv
		}
	})

	describe("constructor", () => {
		it("should store options correctly", () => {
			const options: ExtensionHostOptions = {
				mode: "code",
				workspacePath: "/my/workspace",
				extensionPath: "/my/extension",
				user: null,
				apiKey: "test-key",
				provider: "openrouter",
				model: "test-model",
				ephemeral: false,
				debug: false,
				exitOnComplete: false,
				integrationTest: true, // Set explicitly for testing
			}

			const host = new ExtensionHost(options)

			// Options are stored as-is
			const storedOptions = getPrivate<ExtensionHostOptions>(host, "options")
			expect(storedOptions.mode).toBe(options.mode)
			expect(storedOptions.workspacePath).toBe(options.workspacePath)
			expect(storedOptions.extensionPath).toBe(options.extensionPath)
			expect(storedOptions.integrationTest).toBe(true)
		})

		it("should be an EventEmitter instance", () => {
			const host = createTestHost()
			expect(host).toBeInstanceOf(EventEmitter)
		})

		it("should initialize with default state values", () => {
			const host = createTestHost()

			expect(getPrivate(host, "_isReady")).toBe(false)
			expect(getPrivate(host, "vscode")).toBeNull()
			expect(getPrivate(host, "extensionModule")).toBeNull()
		})

		it("should initialize managers", () => {
			const host = createTestHost()

			// Should have client, outputManager, promptManager, and askDispatcher
			expect(getPrivate(host, "client")).toBeDefined()
			expect(getPrivate(host, "outputManager")).toBeDefined()
			expect(getPrivate(host, "promptManager")).toBeDefined()
			expect(getPrivate(host, "askDispatcher")).toBeDefined()
		})

		it("should mark process as CLI runtime", () => {
			delete process.env.SHOFER_CLI_RUNTIME
			createTestHost()
			expect(process.env.SHOFER_CLI_RUNTIME).toBe("1")
		})

		it("should set execaShellPath in initialSettings when terminalShell is provided", () => {
			const host = createTestHost({ terminalShell: "/bin/bash" })
			const emitSpy = vi.spyOn(host, "emit")
			host.markWebviewReady()
			const updateSettingsCall = emitSpy.mock.calls.find(
				(call) =>
					call[0] === "webviewMessage" &&
					typeof call[1] === "object" &&
					call[1] !== null &&
					(call[1] as WebviewMessage).type === "updateSettings",
			)
			expect(updateSettingsCall).toBeDefined()
			const payload = updateSettingsCall?.[1] as WebviewMessage
			expect(payload.updatedSettings?.execaShellPath).toBe("/bin/bash")
		})
	})

	describe("webview provider registration", () => {
		it("should register webview provider without throwing", () => {
			const host = createTestHost()
			const mockProvider = { resolveWebviewView: vi.fn() }

			// registerWebviewProvider is now a no-op, just ensure it doesn't throw
			expect(() => {
				host.registerWebviewProvider("test-view", mockProvider)
			}).not.toThrow()
		})

		it("should unregister webview provider without throwing", () => {
			const host = createTestHost()
			const mockProvider = { resolveWebviewView: vi.fn() }

			host.registerWebviewProvider("test-view", mockProvider)

			// unregisterWebviewProvider is now a no-op, just ensure it doesn't throw
			expect(() => {
				host.unregisterWebviewProvider("test-view")
			}).not.toThrow()
		})

		it("should handle unregistering non-existent provider gracefully", () => {
			const host = createTestHost()

			expect(() => {
				host.unregisterWebviewProvider("non-existent")
			}).not.toThrow()
		})
	})

	describe("webview ready state", () => {
		describe("isInInitialSetup", () => {
			it("should return true before webview is ready", () => {
				const host = createTestHost()
				expect(host.isInInitialSetup()).toBe(true)
			})

			it("should return false after markWebviewReady is called", () => {
				const host = createTestHost()
				host.markWebviewReady()
				expect(host.isInInitialSetup()).toBe(false)
			})
		})

		describe("markWebviewReady", () => {
			it("should set isReady to true", () => {
				const host = createTestHost()
				host.markWebviewReady()
				expect(getPrivate(host, "_isReady")).toBe(true)
			})

			it("should send webviewDidLaunch message", () => {
				const host = createTestHost()
				const emitSpy = vi.spyOn(host, "emit")

				host.markWebviewReady()

				expect(emitSpy).toHaveBeenCalledWith("webviewMessage", { type: "webviewDidLaunch" })
			})

			it("should send updateSettings message", () => {
				const host = createTestHost()
				const emitSpy = vi.spyOn(host, "emit")

				host.markWebviewReady()

				// Check that updateSettings was called
				const updateSettingsCall = emitSpy.mock.calls.find(
					(call) =>
						call[0] === "webviewMessage" &&
						typeof call[1] === "object" &&
						call[1] !== null &&
						(call[1] as WebviewMessage).type === "updateSettings",
				)
				expect(updateSettingsCall).toBeDefined()
			})

			/**
			 * Approval posture on the wire. `markWebviewReady` is the single place the
			 * host's seed reaches the extension, so these assertions are what actually
			 * pin a served node's behaviour — not the seed object in isolation.
			 */
			describe("approval posture", () => {
				/** The `updateSettings` payload emitted by `markWebviewReady`. */
				function capturedSettings(host: ExtensionHost): Record<string, unknown> {
					const emitSpy = vi.spyOn(host, "emit")
					host.markWebviewReady()
					const call = emitSpy.mock.calls.find(
						(c) =>
							c[0] === "webviewMessage" &&
							typeof c[1] === "object" &&
							c[1] !== null &&
							(c[1] as WebviewMessage).type === "updateSettings",
					)
					expect(call).toBeDefined()
					return ((call?.[1] as WebviewMessage).updatedSettings ?? {}) as Record<string, unknown>
				}

				it("non-interactive still auto-approves everything when config says nothing", () => {
					const settings = capturedSettings(createTestHost({ nonInteractive: true }))

					expect(settings).toMatchObject({
						autoApprovalEnabled: true,
						alwaysAllowReadOnly: true,
						alwaysAllowReadOnlyOutsideWorkspace: true,
						alwaysAllowWrite: true,
						alwaysAllowWriteOutsideWorkspace: true,
						alwaysAllowWriteProtected: true,
						alwaysAllowMcp: true,
						alwaysAllowModeSwitch: true,
						alwaysAllowSubtasks: true,
						alwaysAllowExecute: true,
						allowedCommands: ["*"],
					})
				})

				it("interactive still surfaces everything when config says nothing", () => {
					const settings = capturedSettings(createTestHost({ nonInteractive: false }))

					expect(settings.autoApprovalEnabled).toBe(false)
					expect(settings).not.toHaveProperty("alwaysAllowExecute")
					expect(settings).not.toHaveProperty("allowedCommands")
				})

				it("drops a config-supplied posture key from the seed rather than overriding it", async () => {
					const globalScope = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "shofer-host-")), ".shofer")
					await fsp.mkdir(globalScope, { recursive: true })
					await fsp.writeFile(
						path.join(globalScope, "settings.json"),
						JSON.stringify({ autoApprovalEnabled: false, alwaysAllowExecute: false }),
						"utf8",
					)

					const previousGlobalDir = process.env.SHOFER_GLOBAL_DIR
					process.env.SHOFER_GLOBAL_DIR = globalScope
					const homedirSpy = vi
						.spyOn(os, "homedir")
						.mockReturnValue(await fsp.mkdtemp(path.join(os.tmpdir(), "shofer-home-")))

					try {
						const host = createTestHost({ nonInteractive: true })
						await callPrivate<Promise<void>>(host, "applyApprovalPostureFromConfig")

						const settings = capturedSettings(host)

						// Not sent at all: the layered overlay already wins in
						// ContextProxy.getValue, and sending them would write the host's
						// default through into the operator's own settings.json.
						expect(settings).not.toHaveProperty("autoApprovalEnabled")
						expect(settings).not.toHaveProperty("alwaysAllowExecute")
						// Keys the config says nothing about keep the seed's value.
						expect(settings.alwaysAllowWrite).toBe(true)
						expect(settings.allowedCommands).toEqual(["*"])

						expect(host.approvalPosture.configuredKeys).toEqual([
							"autoApprovalEnabled",
							"alwaysAllowExecute",
						])
						expect(host.approvalPosture.summary).toContain("from config")
					} finally {
						homedirSpy.mockRestore()
						if (previousGlobalDir === undefined) {
							delete process.env.SHOFER_GLOBAL_DIR
						} else {
							process.env.SHOFER_GLOBAL_DIR = previousGlobalDir
						}
					}
				})

				it("reports the default posture before any config is read", () => {
					expect(createTestHost({ nonInteractive: true }).approvalPosture.summary).toBe(
						"auto-approve (default)",
					)
					expect(createTestHost({ nonInteractive: false }).approvalPosture.summary).toBe(
						"interactive, brokered to controller (default)",
					)
				})
			})

			it("should force terminalShellIntegrationDisabled when terminalShell is provided", () => {
				const host = createTestHost({ terminalShell: "/bin/bash" })
				const emitSpy = vi.spyOn(host, "emit")

				host.markWebviewReady()

				const updateSettingsCall = emitSpy.mock.calls.find(
					(call) =>
						call[0] === "webviewMessage" &&
						typeof call[1] === "object" &&
						call[1] !== null &&
						(call[1] as WebviewMessage).type === "updateSettings",
				)

				expect(updateSettingsCall).toBeDefined()
				const payload = updateSettingsCall?.[1] as WebviewMessage
				expect(payload.type).toBe("updateSettings")
				expect(payload.updatedSettings?.terminalShellIntegrationDisabled).toBe(true)
			})
		})
	})

	describe("sendToExtension", () => {
		it("should throw error when extension not ready", () => {
			const host = createTestHost()
			const message: WebviewMessage = { type: "requestModes" }

			expect(() => {
				host.sendToExtension(message)
			}).toThrow("You cannot send messages to the extension before it is ready")
		})

		it("should emit webviewMessage event when webview is ready", () => {
			const host = createTestHost()
			const emitSpy = vi.spyOn(host, "emit")
			const message: WebviewMessage = { type: "requestModes" }

			host.markWebviewReady()
			emitSpy.mockClear() // Clear the markWebviewReady calls
			host.sendToExtension(message)

			expect(emitSpy).toHaveBeenCalledWith("webviewMessage", message)
		})

		it("should not throw when webview is ready", () => {
			const host = createTestHost()

			host.markWebviewReady()

			expect(() => {
				host.sendToExtension({ type: "requestModes" })
			}).not.toThrow()
		})
	})

	describe("message handling via client", () => {
		it("should forward extension messages to the client", () => {
			const host = createTestHost()
			const client = getPrivate(host, "client") as ExtensionClient

			// Simulate extension message.
			host.emit("extensionWebviewMessage", {
				type: "stateInit",
				state: { shoferMessages: [] },
			} as unknown as ExtensionMessage)

			// Message listener is set up in activate(), which we can't easily call in unit tests.
			// But we can verify the client exists and has the handleMessage method.
			expect(typeof client.handleMessage).toBe("function")
		})
	})

	describe("public agent state API", () => {
		it("should return agent state from getAgentState()", () => {
			const host = createTestHost()
			const state = host.getAgentState()

			expect(state).toBeDefined()
			expect(state.state).toBeDefined()
			expect(state.isWaitingForInput).toBeDefined()
			expect(state.isRunning).toBeDefined()
		})

		it("should return isWaitingForInput() status", () => {
			const host = createTestHost()
			expect(typeof host.isWaitingForInput()).toBe("boolean")
		})
	})

	describe("quiet mode", () => {
		describe("setupQuietMode", () => {
			it("should not modify console when integrationTest is true", () => {
				// By default, constructor sets integrationTest = true
				const host = createTestHost()
				const originalLog = console.log

				callPrivate(host, "setupQuietMode")

				// Console should not be modified since integrationTest is true
				expect(console.log).toBe(originalLog)
			})

			it("should suppress console when integrationTest is false", () => {
				// Capture the real console.log before any host is created
				const originalLog = console.log

				// Create host with integrationTest: true to prevent constructor from suppressing
				const host = createTestHost({ integrationTest: true })

				// Override integrationTest to false to test suppression
				const options = getPrivate<ExtensionHostOptions>(host, "options")
				options.integrationTest = false

				callPrivate(host, "setupQuietMode")

				// Console should be modified (suppressed)
				expect(console.log).not.toBe(originalLog)

				// Restore for other tests
				callPrivate(host, "restoreConsole")
			})

			it("should preserve console.error even when suppressing", () => {
				const host = createTestHost()
				const originalError = console.error

				// Override integrationTest to false
				const options = getPrivate<ExtensionHostOptions>(host, "options")
				options.integrationTest = false

				callPrivate(host, "setupQuietMode")

				expect(console.error).toBe(originalError)

				callPrivate(host, "restoreConsole")
			})
		})

		describe("restoreConsole", () => {
			it("should restore original console methods when suppressed", () => {
				// Capture the real console.log before any host is created
				const originalLog = console.log

				// Create host with integrationTest: true to prevent constructor from suppressing
				const host = createTestHost({ integrationTest: true })

				// Override integrationTest to false to actually suppress
				const options = getPrivate<ExtensionHostOptions>(host, "options")
				options.integrationTest = false

				callPrivate(host, "setupQuietMode")
				callPrivate(host, "restoreConsole")

				expect(console.log).toBe(originalLog)
			})

			it("should handle case where console was not suppressed", () => {
				const host = createTestHost()

				expect(() => {
					callPrivate(host, "restoreConsole")
				}).not.toThrow()
			})
		})
	})

	describe("dispose", () => {
		let host: ExtensionHost

		beforeEach(() => {
			host = createTestHost()
		})

		it("should remove message listener", async () => {
			const listener = vi.fn()
			setPrivate(host, "messageListener", listener)
			host.on("extensionWebviewMessage", listener)

			await host.dispose()

			expect(getPrivate(host, "messageListener")).toBeNull()
		})

		it("should call extension deactivate if available", async () => {
			const deactivateMock = vi.fn()
			setPrivate(host, "extensionModule", {
				deactivate: deactivateMock,
			})

			await host.dispose()

			expect(deactivateMock).toHaveBeenCalled()
		})

		it("should clear vscode reference", async () => {
			setPrivate(host, "vscode", { context: {} })

			await host.dispose()

			expect(getPrivate(host, "vscode")).toBeNull()
		})

		it("should clear extensionModule reference", async () => {
			setPrivate(host, "extensionModule", {})

			await host.dispose()

			expect(getPrivate(host, "extensionModule")).toBeNull()
		})

		it("should delete global vscode", async () => {
			;(global as Record<string, unknown>).vscode = {}

			await host.dispose()

			expect((global as Record<string, unknown>).vscode).toBeUndefined()
		})

		it("should delete global __extensionHost", async () => {
			;(global as Record<string, unknown>).__extensionHost = {}

			await host.dispose()

			expect((global as Record<string, unknown>).__extensionHost).toBeUndefined()
		})

		it("should call restoreConsole", async () => {
			const restoreConsoleSpy = spyOnPrivate(host, "restoreConsole")

			await host.dispose()

			expect(restoreConsoleSpy).toHaveBeenCalled()
		})

		it("should clear SHOFER_CLI_RUNTIME on dispose when it was previously unset", async () => {
			delete process.env.SHOFER_CLI_RUNTIME
			host = createTestHost()
			expect(process.env.SHOFER_CLI_RUNTIME).toBe("1")

			await host.dispose()

			expect(process.env.SHOFER_CLI_RUNTIME).toBeUndefined()
		})

		it("should restore prior SHOFER_CLI_RUNTIME value on dispose", async () => {
			process.env.SHOFER_CLI_RUNTIME = "preexisting-value"
			host = createTestHost()
			expect(process.env.SHOFER_CLI_RUNTIME).toBe("1")

			await host.dispose()

			expect(process.env.SHOFER_CLI_RUNTIME).toBe("preexisting-value")
		})
	})

	describe("runTask", () => {
		it("should call extensionAPI.createTask with prompt and configuration", async () => {
			const host = createTestHost()
			host.markWebviewReady()

			const api = getPrivate(host, "extensionAPI") as ShoferExtensionApi
			const client = getPrivate(host, "client") as ExtensionClient

			// Start the task (will hang waiting for completion)
			const taskPromise = host.runTask("test prompt")

			// Emit completion to resolve the promise via the client's emitter
			const taskCompletedEvent = {
				success: true,
				stateInfo: {
					state: AgentLoopState.IDLE,
					isWaitingForInput: false,
					isRunning: false,
					isStreaming: false,
					requiredAction: "start_task" as const,
					description: "Task completed",
				},
			}
			setTimeout(() => client.getEmitter().emit("taskCompleted", taskCompletedEvent), 10)

			await taskPromise

			expect(api.createTask).toHaveBeenCalledWith({
				configuration: undefined,
				prompt: "test prompt",
				images: undefined,
				taskId: undefined,
			})
		})

		it("should pass configuration to extensionAPI.createTask", async () => {
			const host = createTestHost()
			host.markWebviewReady()

			const api = getPrivate(host, "extensionAPI") as ShoferExtensionApi
			const client = getPrivate(host, "client") as ExtensionClient

			const config = { customInstructions: "test instructions" }
			const taskPromise = host.runTask("test prompt", undefined, config)

			const taskCompletedEvent = {
				success: true,
				stateInfo: {
					state: AgentLoopState.IDLE,
					isWaitingForInput: false,
					isRunning: false,
					isStreaming: false,
					requiredAction: "start_task" as const,
					description: "Task completed",
				},
			}
			setTimeout(() => client.getEmitter().emit("taskCompleted", taskCompletedEvent), 10)

			await taskPromise

			expect(api.createTask).toHaveBeenCalledWith({
				configuration: config,
				prompt: "test prompt",
				images: undefined,
				taskId: undefined,
			})
		})

		it("should resolve when taskCompleted is emitted on client", async () => {
			const host = createTestHost()
			host.markWebviewReady()

			const client = getPrivate(host, "client") as ExtensionClient
			const taskPromise = host.runTask("test prompt")

			// Emit completion after a short delay via the client's emitter
			const taskCompletedEvent = {
				success: true,
				stateInfo: {
					state: AgentLoopState.IDLE,
					isWaitingForInput: false,
					isRunning: false,
					isStreaming: false,
					requiredAction: "start_task" as const,
					description: "Task completed",
				},
			}
			setTimeout(() => client.getEmitter().emit("taskCompleted", taskCompletedEvent), 10)

			await expect(taskPromise).resolves.toBeUndefined()
		})

		it("should call extensionAPI.resumeTask for resumeTask and resolve on completion", async () => {
			const host = createTestHost()
			host.markWebviewReady()

			const api = getPrivate(host, "extensionAPI") as ShoferExtensionApi
			const client = getPrivate(host, "client") as ExtensionClient

			const taskPromise = host.resumeTask("task-abc")

			const taskCompletedEvent = {
				success: true,
				stateInfo: {
					state: AgentLoopState.IDLE,
					isWaitingForInput: false,
					isRunning: false,
					isStreaming: false,
					requiredAction: "start_task" as const,
					description: "Task completed",
				},
			}
			setTimeout(() => client.getEmitter().emit("taskCompleted", taskCompletedEvent), 10)

			await taskPromise

			expect(api.resumeTask).toHaveBeenCalledWith("task-abc")
		})
	})

	describe("cancelTask", () => {
		it("should call extensionAPI.cancelTask for the current task", async () => {
			const host = createTestHost()
			host.markWebviewReady()

			const api = getPrivate(host, "extensionAPI") as ShoferExtensionApi
			await host.cancelTask()

			expect(api.cancelTask).toHaveBeenCalledWith("test-task-id")
		})
	})

	describe("sendMessage", () => {
		it("should call extensionAPI.sendMessage with text and images", async () => {
			const host = createTestHost()
			host.markWebviewReady()

			const api = getPrivate(host, "extensionAPI") as ShoferExtensionApi
			await host.sendMessage("hello", ["img1"])

			expect(api.sendMessage).toHaveBeenCalledWith("test-task-id", "hello", ["img1"])
		})

		it("should call extensionAPI.sendMessage with just text", async () => {
			const host = createTestHost()
			host.markWebviewReady()

			const api = getPrivate(host, "extensionAPI") as ShoferExtensionApi
			await host.sendMessage("hello")

			expect(api.sendMessage).toHaveBeenCalledWith("test-task-id", "hello", undefined)
		})
	})

	describe("approveAction / rejectAction", () => {
		// approve/reject answer the task's outstanding ask directly — the old
		// press*Button pair simulated a webview click on whatever task was current.
		it("should answer the ask affirmatively for approveAction", async () => {
			const host = createTestHost()
			host.markWebviewReady()

			const api = getPrivate(host, "extensionAPI") as ShoferExtensionApi
			await host.approveAction()

			expect(api.respondToAsk).toHaveBeenCalledWith("test-task-id", { askResponse: "yesButtonClicked" })
		})

		it("should answer the ask negatively for rejectAction", async () => {
			const host = createTestHost()
			host.markWebviewReady()

			const api = getPrivate(host, "extensionAPI") as ShoferExtensionApi
			await host.rejectAction()

			expect(api.respondToAsk).toHaveBeenCalledWith("test-task-id", { askResponse: "noButtonClicked" })
		})
	})

	describe("initial settings", () => {
		it("should set mode from options", () => {
			const host = createTestHost({ mode: "architect" })

			const initialSettings = getPrivate<Record<string, unknown>>(host, "initialSettings")
			expect(initialSettings.mode).toBe("architect")
		})

		it("should use default consecutiveMistakeLimit when not provided", () => {
			const host = createTestHost()

			const initialSettings = getPrivate<Record<string, unknown>>(host, "initialSettings")
			expect(initialSettings.consecutiveMistakeLimit).toBe(DEFAULT_FLAGS.consecutiveMistakeLimit)
		})

		it("should set consecutiveMistakeLimit from options", () => {
			const host = createTestHost({ consecutiveMistakeLimit: 8 })

			const initialSettings = getPrivate<Record<string, unknown>>(host, "initialSettings")
			expect(initialSettings.consecutiveMistakeLimit).toBe(8)
		})

		it("should enable auto-approval in non-interactive mode", () => {
			const host = createTestHost({ nonInteractive: true })

			const initialSettings = getPrivate<Record<string, unknown>>(host, "initialSettings")
			expect(initialSettings.autoApprovalEnabled).toBe(true)
			expect(initialSettings.alwaysAllowReadOnly).toBe(true)
			expect(initialSettings.alwaysAllowWrite).toBe(true)
			expect(initialSettings.alwaysAllowExecute).toBe(true)
		})

		it("should disable auto-approval in interactive mode", () => {
			const host = createTestHost({ nonInteractive: false })

			const initialSettings = getPrivate<Record<string, unknown>>(host, "initialSettings")
			expect(initialSettings.autoApprovalEnabled).toBe(false)
		})

		it("should set reasoning effort when specified", () => {
			const host = createTestHost({ reasoningEffort: "high" })

			const initialSettings = getPrivate<Record<string, unknown>>(host, "initialSettings")
			expect(initialSettings.enableReasoningEffort).toBe(true)
			expect(initialSettings.reasoningEffort).toBe("high")
		})

		it("should disable reasoning effort when set to disabled", () => {
			const host = createTestHost({ reasoningEffort: "disabled" })

			const initialSettings = getPrivate<Record<string, unknown>>(host, "initialSettings")
			expect(initialSettings.enableReasoningEffort).toBe(false)
		})

		it("should not set reasoning effort when unspecified", () => {
			const host = createTestHost({ reasoningEffort: "unspecified" })

			const initialSettings = getPrivate<Record<string, unknown>>(host, "initialSettings")
			expect(initialSettings.enableReasoningEffort).toBeUndefined()
			expect(initialSettings.reasoningEffort).toBeUndefined()
		})
	})

	describe("ephemeral mode", () => {
		it("should store ephemeral option correctly", () => {
			const host = createTestHost({ ephemeral: true })

			const options = getPrivate<ExtensionHostOptions>(host, "options")
			expect(options.ephemeral).toBe(true)
		})

		it("should default ephemeralStorageDir to null", () => {
			const host = createTestHost()

			expect(getPrivate(host, "ephemeralStorageDir")).toBeNull()
		})

		it("should clean up ephemeral storage directory on dispose", async () => {
			const host = createTestHost({ ephemeral: true })

			// Set up a mock ephemeral storage directory
			const mockEphemeralDir = "/tmp/shofer-cli-test-ephemeral-cleanup"
			setPrivate(host, "ephemeralStorageDir", mockEphemeralDir)

			// Mock fs.promises.rm
			const rmMock = vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined)

			await host.dispose()

			expect(rmMock).toHaveBeenCalledWith(mockEphemeralDir, { recursive: true, force: true })
			expect(getPrivate(host, "ephemeralStorageDir")).toBeNull()

			rmMock.mockRestore()
		})

		it("should not clean up when ephemeralStorageDir is null", async () => {
			const host = createTestHost()

			// ephemeralStorageDir is null by default
			expect(getPrivate(host, "ephemeralStorageDir")).toBeNull()

			const rmMock = vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined)

			await host.dispose()

			// rm should not be called when there's no ephemeral storage
			expect(rmMock).not.toHaveBeenCalled()

			rmMock.mockRestore()
		})

		it("should handle ephemeral storage cleanup errors gracefully", async () => {
			const host = createTestHost({ ephemeral: true })

			// Set up a mock ephemeral storage directory
			setPrivate(host, "ephemeralStorageDir", "/tmp/shofer-cli-test-ephemeral-error")

			// Mock fs.promises.rm to throw an error
			const rmMock = vi.spyOn(fs.promises, "rm").mockRejectedValue(new Error("Cleanup failed"))

			// dispose should not throw even if cleanup fails
			await expect(host.dispose()).resolves.toBeUndefined()

			rmMock.mockRestore()
		})

		it("should not affect normal mode when ephemeral is false", () => {
			const host = createTestHost({ ephemeral: false })

			const options = getPrivate<ExtensionHostOptions>(host, "options")
			expect(options.ephemeral).toBe(false)
			expect(getPrivate(host, "ephemeralStorageDir")).toBeNull()
		})
	})
})
