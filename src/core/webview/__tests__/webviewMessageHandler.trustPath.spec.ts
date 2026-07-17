// npx vitest core/webview/__tests__/webviewMessageHandler.trustPath.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", async (importOriginal) => {
	const actual: any = await importOriginal()
	return {
		...actual,
		window: { ...actual.window, showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
		workspace: { ...actual.workspace, workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }] },
	}
})

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	// resolveIncomingImages() (a local helper in the handler) delegates to this;
	// echo the payload straight back so text/images pass through untouched.
	resolveImageMentions: vi.fn(async ({ text, images }: { text?: string; images?: string[] }) => ({
		text,
		images: [...(images ?? [])],
	})),
	t: vi.fn((key: string) => key),
}))

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ShoferProvider } from "../ShoferProvider"

function makeHarness(initial: { allowedReadPaths?: string[]; allowedWritePaths?: string[] } = {}) {
	const store: Record<string, unknown> = {
		allowedReadPaths: initial.allowedReadPaths,
		allowedWritePaths: initial.allowedWritePaths,
	}
	const task = {
		trustOutsideWorkspacePath: vi.fn(),
		handleWebviewAskResponse: vi.fn(),
	}
	const provider = {
		contextProxy: {
			getValue: vi.fn((key: string) => store[key]),
			setValue: vi.fn(async (key: string, value: unknown) => {
				store[key] = value
			}),
		},
		postInitState: vi.fn().mockResolvedValue(undefined),
		getState: vi.fn().mockResolvedValue({}),
		getCurrentTask: vi.fn().mockReturnValue(task),
		taskManager: { getManagedTaskInstance: vi.fn().mockReturnValue(task) },
		log: vi.fn(),
	} as unknown as ShoferProvider
	return { provider, task, store }
}

describe("webviewMessageHandler - trustOutsideWorkspacePath", () => {
	beforeEach(() => vi.clearAllMocks())

	it("task-scoped (persist=false): trusts via the task, never touches settings", async () => {
		const { provider, task } = makeHarness()

		await webviewMessageHandler(provider, {
			type: "trustOutsideWorkspacePath",
			outsideWorkspacePath: "/data/reference",
			outsideWorkspaceAccess: "read",
			outsideWorkspacePersist: false,
		} as any)

		expect(task.trustOutsideWorkspacePath).toHaveBeenCalledWith("/data/reference", "read")
		expect(provider.contextProxy.setValue).not.toHaveBeenCalled()
		expect(provider.postInitState).not.toHaveBeenCalled()
		expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("yesButtonClicked", "", [], undefined)
	})

	it("persist + write: appends to allowedWritePaths and refreshes the UI", async () => {
		const { provider, task, store } = makeHarness({ allowedWritePaths: ["/existing"] })

		await webviewMessageHandler(provider, {
			type: "trustOutsideWorkspacePath",
			outsideWorkspacePath: "/data/out",
			outsideWorkspaceAccess: "write",
			outsideWorkspacePersist: true,
		} as any)

		expect(provider.contextProxy.setValue).toHaveBeenCalledWith("allowedWritePaths", ["/existing", "/data/out"])
		expect(store.allowedWritePaths).toEqual(["/existing", "/data/out"])
		expect(task.trustOutsideWorkspacePath).not.toHaveBeenCalled()
		expect(provider.postInitState).toHaveBeenCalledTimes(1)
		expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("yesButtonClicked", "", [], undefined)
	})

	it("persist + read: appends to allowedReadPaths (empty list start)", async () => {
		const { provider } = makeHarness()

		await webviewMessageHandler(provider, {
			type: "trustOutsideWorkspacePath",
			outsideWorkspacePath: "/data/ref",
			outsideWorkspaceAccess: "read",
			outsideWorkspacePersist: true,
		} as any)

		expect(provider.contextProxy.setValue).toHaveBeenCalledWith("allowedReadPaths", ["/data/ref"])
	})

	it("persist is idempotent: an already-trusted dir is not re-appended and the UI isn't re-posted", async () => {
		const { provider, task } = makeHarness({ allowedWritePaths: ["/data/out"] })

		await webviewMessageHandler(provider, {
			type: "trustOutsideWorkspacePath",
			outsideWorkspacePath: "/data/out",
			outsideWorkspaceAccess: "write",
			outsideWorkspacePersist: true,
		} as any)

		expect(provider.contextProxy.setValue).not.toHaveBeenCalled()
		expect(provider.postInitState).not.toHaveBeenCalled()
		// still approves the ask
		expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("yesButtonClicked", "", [], undefined)
	})
})
