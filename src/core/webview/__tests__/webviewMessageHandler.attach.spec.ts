// npx vitest core/webview/__tests__/webviewMessageHandler.attach.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", async (importOriginal) => {
	const actual: any = await importOriginal()
	return {
		...actual,
		workspace: { ...actual.workspace, workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }] },
	}
})

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	resolveImageMentions: vi.fn(async ({ text, images }: { text?: string; images?: string[] }) => ({
		text,
		images: [...(images ?? [])],
	})),
	t: vi.fn((key: string) => key),
}))

import { pluginRegistry } from "@shofer/core"
import { getHost } from "@shofer/types"

import { webviewMessageHandler } from "../webviewMessageHandler"
import { TaskAttachmentManager } from "../../attach/TaskAttachmentManager"
import type { ShoferProvider } from "../ShoferProvider"

/**
 * How the two Phase-2 seams meet the webview: a view rendering an ATTACHED task
 * drives that task's host rather than this one, and task creation asks the placement
 * question before falling through to the in-process path.
 */

function makeProvider() {
	const task = { handleWebviewAskResponse: vi.fn(), messageQueueService: { addMessage: vi.fn() }, abort: false }
	const provider = {
		cwd: "/mock/workspace",
		createManagedTask: vi.fn().mockResolvedValue("local-1"),
		cancelTask: vi.fn().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postInitState: vi.fn().mockResolvedValue(undefined),
		getState: vi.fn().mockResolvedValue({}),
		getCurrentTask: vi.fn().mockReturnValue(task),
		taskManager: { getManagedTaskInstance: vi.fn().mockReturnValue(task) },
		log: vi.fn(),
	} as unknown as ShoferProvider
	return { provider, task }
}

/** Answer the two placement broadcasts core makes at task creation. */
function mockBroadcasts(placement: unknown[] = []) {
	return vi.spyOn(pluginRegistry, "requestAll").mockImplementation(async (method: string) => {
		if (method === "resolve-task-placement") return placement
		return [] // resolve-task-cwd: nobody places the directory
	})
}

describe("webviewMessageHandler — attached tasks", () => {
	beforeEach(() => vi.restoreAllMocks())

	const attach = async (provider: ShoferProvider, taskId: string) => {
		const client = {
			getTaskSnapshot: vi.fn(async () => ({ taskId, messages: [] })),
			subscribeTask: vi.fn(() => () => {}),
			sendMessage: vi.fn(async () => {}),
			cancelTask: vi.fn(async () => {}),
			respondToAsk: vi.fn(async () => {}),
		}
		vi.spyOn(
			TaskAttachmentManager.getInstance() as unknown as { createClient: unknown },
			"createClient" as never,
		).mockReturnValue(client as never)
		await TaskAttachmentManager.getInstance().attach(provider, { address: "http://host:1", taskId })
		return client
	}

	it("routes an ask answer to the owning host, not the local task", async () => {
		const { provider, task } = makeProvider()
		const client = await attach(provider, "remote-1")

		await webviewMessageHandler(provider, {
			type: "askResponse",
			askResponse: "yesButtonClicked",
			askId: "a1",
			taskId: "remote-1",
		} as never)

		expect(client.respondToAsk).toHaveBeenCalledWith(
			"remote-1",
			expect.objectContaining({ askResponse: "yesButtonClicked", askId: "a1" }),
		)
		expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
		TaskAttachmentManager.getInstance().detach(provider, { silent: true })
	})

	it("sends a typed follow-up to the owning host instead of the local queue", async () => {
		const { provider, task } = makeProvider()
		const client = await attach(provider, "remote-1")

		await webviewMessageHandler(provider, { type: "queueMessage", text: "carry on" } as never)

		expect(client.sendMessage).toHaveBeenCalledWith("remote-1", "carry on")
		expect(task.messageQueueService.addMessage).not.toHaveBeenCalled()
		TaskAttachmentManager.getInstance().detach(provider, { silent: true })
	})

	it("cancels the attached task on its own host", async () => {
		const { provider } = makeProvider()
		const client = await attach(provider, "remote-1")

		await webviewMessageHandler(provider, { type: "cancelTask" } as never)

		expect(client.cancelTask).toHaveBeenCalledWith("remote-1")
		expect(provider.cancelTask).not.toHaveBeenCalled()
		TaskAttachmentManager.getInstance().detach(provider, { silent: true })
	})
})

describe("webviewMessageHandler — newTask placement", () => {
	beforeEach(() => vi.restoreAllMocks())

	it("runs the in-process path unchanged when no plugin claims the task", async () => {
		const { provider } = makeProvider()
		mockBroadcasts([])

		await webviewMessageHandler(provider, { type: "newTask", text: "do it", mode: "code" } as never)

		expect(provider.createManagedTask).toHaveBeenCalledWith(undefined, "do it", [], undefined, {
			mode: "code",
			apiConfigName: undefined,
		})
	})

	it("attaches to a claimed task and creates no local one", async () => {
		const { provider } = makeProvider()
		mockBroadcasts([{ dispatched: { taskId: "remote-9", address: "http://worker:30099", token: "k" } }])
		const attachSpy = vi.spyOn(TaskAttachmentManager.getInstance(), "attach").mockResolvedValue({} as never)

		await webviewMessageHandler(provider, { type: "newTask", text: "do it", mode: "code" } as never)

		expect(attachSpy).toHaveBeenCalledWith(provider, {
			address: "http://worker:30099",
			taskId: "remote-9",
			token: "k",
		})
		expect(provider.createManagedTask).not.toHaveBeenCalled()
	})

	it("aborts creation and surfaces the error when a dispatcher fails", async () => {
		const { provider } = makeProvider()
		mockBroadcasts([{ error: "no worker is polling queue 'gpu'" }])
		const notify = vi.spyOn(getHost().notifier, "error").mockImplementation(() => undefined as never)

		await webviewMessageHandler(provider, { type: "newTask", text: "do it", mode: "code" } as never)

		expect(provider.createManagedTask).not.toHaveBeenCalled()
		expect(notify).toHaveBeenCalledWith("no worker is polling queue 'gpu'")
	})
})
