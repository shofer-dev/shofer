// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/useExtensionHost.test.tsx

import { EventEmitter } from "events"
import type { ExtensionMessage, WebviewMessage } from "@shofer/types"

import type { ExtensionHostInterface, ExtensionHostOptions } from "@/agent/index.js"

import { useCLIStore } from "../../store.js"
import { useExtensionHost, type UseExtensionHostOptions } from "../useExtensionHost.js"
import { renderHook } from "./helpers/render-hook.js"

/**
 * The extension-host lifecycle: construct the host, subscribe to its message and
 * lifecycle streams, activate it, then take ONE of three starting moves — resume
 * a named session, continue the workspace's most recent one, or run the initial
 * prompt. A failure anywhere in that sequence becomes the store's `error` rather
 * than an unhandled rejection, because there is no other surface to report it on.
 *
 * The host itself is faked: it is a process boundary (a whole VS Code extension
 * bundle), which is exactly what `createExtensionHost` exists to inject.
 */

/** A fake `ExtensionHostInterface` recording everything the hook does to it. */
class FakeHost extends EventEmitter {
	public readonly client = new EventEmitter()
	public readonly sent: WebviewMessage[] = []
	public readonly ranTasks: Array<{ prompt: string; taskId?: string }> = []
	public activated = 0
	public disposed = 0
	public cancelled = 0
	public activateError: Error | null = null
	public runTaskError: Error | null = null

	async activate(): Promise<void> {
		this.activated += 1
		if (this.activateError) {
			throw this.activateError
		}
	}

	sendToExtension(msg: WebviewMessage): void {
		this.sent.push(msg)
	}

	async runTask(prompt: string, taskId?: string): Promise<void> {
		this.ranTasks.push({ prompt, taskId })
		if (this.runTaskError) {
			throw this.runTaskError
		}
	}

	async cancelTask(): Promise<void> {
		this.cancelled += 1
	}

	async dispose(): Promise<void> {
		this.disposed += 1
	}

	/** Push a message down the webview stream, as the real host would. */
	emitWebviewMessage(msg: ExtensionMessage): void {
		this.emit("extensionWebviewMessage", msg)
	}
}

describe("useExtensionHost", () => {
	let host: FakeHost
	let onExtensionMessage: ReturnType<typeof vi.fn>
	let createdWith: ExtensionHostOptions[]

	const baseOptions = {
		mode: "code",
		provider: "mock",
		apiKey: "x",
		model: "mock-model",
		workspacePath: "/work",
		extensionPath: "/ext",
	} as unknown as ExtensionHostOptions

	beforeEach(() => {
		useCLIStore.getState().reset()
		host = new FakeHost()
		onExtensionMessage = vi.fn()
		createdWith = []
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const mount = async (overrides: Partial<UseExtensionHostOptions> = {}) => {
		const hook = renderHook(() =>
			useExtensionHost({
				...baseOptions,
				onExtensionMessage,
				createExtensionHost: (options: ExtensionHostOptions) => {
					createdWith.push(options)
					return host as unknown as ExtensionHostInterface
				},
				...overrides,
			} as UseExtensionHostOptions),
		)
		await hook.actAsync()
		return hook
	}

	it("activates the host with output disabled and asks for the catalogs", async () => {
		const hook = await mount()

		expect(host.activated).toBe(1)
		expect(createdWith[0]).toMatchObject({ workspacePath: "/work", disableOutput: true })
		expect(host.sent).toEqual([{ type: "requestCommands" }, { type: "requestModes" }])
		expect(useCLIStore.getState().isLoading).toBe(false)

		hook.unmount()
	})

	it("forwards every extension message to the consumer", async () => {
		const hook = await mount()

		const message = { type: "action", action: "chatButtonClicked" } as ExtensionMessage
		hook.act(() => host.emitWebviewMessage(message))

		expect(onExtensionMessage).toHaveBeenCalledWith(message)
		hook.unmount()
	})

	it("marks the task complete when the client says so", async () => {
		const hook = await mount()

		useCLIStore.getState().setLoading(true)
		await hook.actAsync(async () => {
			host.client.emit("taskCompleted")
		})

		expect(useCLIStore.getState().isComplete).toBe(true)
		expect(useCLIStore.getState().isLoading).toBe(false)
		hook.unmount()
	})

	it("tears the host down and exits when the run was one-shot", async () => {
		vi.useFakeTimers()
		const processExit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
		const hook = await mount({ exitOnComplete: true })

		await hook.actAsync(async () => {
			host.client.emit("taskCompleted")
		})

		expect(host.disposed).toBe(1)
		hook.act(() => {
			vi.advanceTimersByTime(100)
		})
		expect(processExit).toHaveBeenCalledWith(0)

		hook.unmount()
		vi.useRealTimers()
	})

	it("surfaces a client error into the store", async () => {
		const hook = await mount()

		useCLIStore.getState().setLoading(true)
		hook.act(() => {
			host.client.emit("error", new Error("stream died"))
		})

		expect(useCLIStore.getState().error).toBe("stream died")
		expect(useCLIStore.getState().isLoading).toBe(false)
		hook.unmount()
	})

	it("runs the initial prompt, carrying the caller's task id exactly once", async () => {
		const hook = await mount({ initialPrompt: "do it", initialTaskId: "  task-9  " })

		expect(useCLIStore.getState().hasStartedTask).toBe(true)
		expect(useCLIStore.getState().messages[0]).toMatchObject({ role: "user", content: "do it" })
		expect(host.ranTasks).toEqual([{ prompt: "do it", taskId: "task-9" }])

		// The id is consumed: a later runTask does not re-use it.
		await hook.actAsync(() => hook.current.runTask?.("again"))
		expect(host.ranTasks[1]).toEqual({ prompt: "again", taskId: undefined })

		hook.unmount()
	})

	it("reports a failure to start the initial task rather than rejecting", async () => {
		host.runTaskError = new Error("no credit")
		const hook = await mount({ initialPrompt: "do it" })

		expect(useCLIStore.getState().error).toBe("no credit")
		expect(useCLIStore.getState().isLoading).toBe(false)
		hook.unmount()
	})

	it("reports a non-Error activation failure as a string", async () => {
		host.activateError = "plain string" as unknown as Error
		const hook = await mount()

		expect(useCLIStore.getState().error).toBe("plain string")
		hook.unmount()
	})

	describe("resuming a session", () => {
		const history = [
			{ id: "old", task: "a", ts: 1, createdAt: 1, workspace: "/work" },
			{ id: "recent", task: "b", ts: 2, createdAt: 2, workspace: "/work" },
			{ id: "elsewhere", task: "c", ts: 99, createdAt: 99, workspace: "/other" },
		]

		/** Answer the host's state request with a task-history snapshot. */
		const answerWithHistory = (taskHistory: unknown[]) => {
			host.on("extensionWebviewMessage", () => {})
			queueMicrotask(() => {
				host.emitWebviewMessage({ type: "stateInit", state: { taskHistory } } as unknown as ExtensionMessage)
			})
		}

		it("resumes the session the caller named", async () => {
			answerWithHistory(history)
			const hook = await mount({ initialSessionId: " old " })

			expect(useCLIStore.getState().currentTaskId).toBe("old")
			expect(useCLIStore.getState().isResumingTask).toBe(true)
			expect(useCLIStore.getState().hasStartedTask).toBe(true)
			expect(useCLIStore.getState().isLoading).toBe(true)
			expect(host.sent.at(-1)).toEqual({ type: "showTaskWithId", text: "old" })

			hook.unmount()
		})

		it("refuses a session id that is not in the history", async () => {
			answerWithHistory(history)
			const hook = await mount({ initialSessionId: "ghost" })

			expect(useCLIStore.getState().error).toBe("Session not found in task history: ghost")
			hook.unmount()
		})

		it("continues the most recent task IN THIS WORKSPACE", async () => {
			answerWithHistory(history)
			const hook = await mount({ continueSession: true })

			// "elsewhere" is newer but belongs to another workspace.
			expect(useCLIStore.getState().currentTaskId).toBe("recent")
			hook.unmount()
		})

		it("also accepts the history from a taskHistoryUpdated message", async () => {
			queueMicrotask(() => {
				host.emitWebviewMessage({
					type: "taskHistoryUpdated",
					taskHistory: history,
				} as unknown as ExtensionMessage)
			})
			const hook = await mount({ continueSession: true })

			expect(useCLIStore.getState().currentTaskId).toBe("recent")
			hook.unmount()
		})

		it("refuses to continue when this workspace has no history", async () => {
			answerWithHistory([{ id: "elsewhere", task: "c", ts: 1, workspace: "/other" }])
			const hook = await mount({ continueSession: true })

			expect(useCLIStore.getState().error).toBe("No previous tasks found to continue in this workspace.")
			hook.unmount()
		})
	})

	describe("the stable callbacks", () => {
		it("send, run and cancel reach the host", async () => {
			const hook = await mount()

			hook.act(() => hook.current.sendToExtension?.({ type: "clearTask" }))
			await hook.actAsync(() => hook.current.runTask?.("go"))
			await hook.actAsync(() => hook.current.cancelTask?.())

			expect(host.sent.at(-1)).toEqual({ type: "clearTask" })
			expect(host.ranTasks).toEqual([{ prompt: "go", taskId: undefined }])
			expect(host.cancelled).toBe(1)

			hook.unmount()
		})

		it("refuse once the host is gone, rather than silently doing nothing", async () => {
			const hook = await mount()
			await hook.actAsync(() => hook.current.cleanup())

			expect(host.disposed).toBe(1)
			await expect(hook.current.runTask?.("go")).rejects.toThrow("Extension host not ready")
			await expect(hook.current.cancelTask?.()).rejects.toThrow("Extension host not ready")
			// Sending is best-effort: there is nothing to report it to.
			expect(() => hook.current.sendToExtension?.({ type: "clearTask" })).not.toThrow()

			hook.unmount()
		})

		it("cleanup is idempotent", async () => {
			const hook = await mount()
			await hook.actAsync(() => hook.current.cleanup())
			await hook.actAsync(() => hook.current.cleanup())

			expect(host.disposed).toBe(1)
			hook.unmount()
		})

		it("disposes the host when the app unmounts", async () => {
			const hook = await mount()
			hook.unmount()
			await Promise.resolve()

			expect(host.disposed).toBe(1)
		})
	})
})
