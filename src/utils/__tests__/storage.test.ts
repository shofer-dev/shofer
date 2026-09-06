// npx vitest src/utils/__tests__/storage.test.ts

/**
 * `utils/storage.ts` is the VS Code half of core's custom-storage-path seam: it
 * READS the setting and it PROMPTS for a new one. The prompt is the interesting
 * half — its `validateInput` is what stops a relative path reaching core's
 * base-path logic, and the write-back has three outcomes (a usable directory, a
 * directory that exists but cannot be written, and clearing the override) that a
 * user can only tell apart by which notification lands.
 */

const hoisted = vi.hoisted(() => ({
	notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	mkdir: vi.fn(async () => undefined),
	access: vi.fn(async () => undefined),
}))

vi.mock("vscode", () => {
	const get = vi.fn((_key: string, def: unknown) => def)
	const update = vi.fn(async () => undefined)
	return {
		workspace: { getConfiguration: vi.fn(() => ({ get, update })) },
		window: { showInputBox: vi.fn(async () => undefined) },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	}
})

vi.mock("fs/promises", () => ({
	default: { mkdir: hoisted.mkdir, access: hoisted.access },
	mkdir: hoisted.mkdir,
	access: hoisted.access,
}))

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({ notifier: hoisted.notifier }),
}))

import * as vscode from "vscode"

import { getConfiguredCustomStoragePath, promptForCustomStoragePath } from "../storage"

type Validator = (input: string) => string | null

function inputBox() {
	return vi.mocked(vscode.window.showInputBox)
}

function configuration() {
	return vi.mocked(vscode.workspace.getConfiguration).mock.results.at(-1)!.value as {
		get: ReturnType<typeof vi.fn>
		update: ReturnType<typeof vi.fn>
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.mkdir.mockResolvedValue(undefined)
	hoisted.access.mockResolvedValue(undefined)
})

describe("getConfiguredCustomStoragePath", () => {
	it("returns the configured value", async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
			get: vi.fn(() => "/custom/storage"),
		} as never)

		await expect(getConfiguredCustomStoragePath()).resolves.toBe("/custom/storage")
	})

	it("defaults to the empty string, which is core's 'use the default' signal", async () => {
		await expect(getConfiguredCustomStoragePath()).resolves.toBe("")
	})
})

describe("promptForCustomStoragePath validateInput", () => {
	async function captureValidator(): Promise<Validator> {
		inputBox().mockResolvedValueOnce(undefined)
		await promptForCustomStoragePath()
		return inputBox().mock.calls[0][0]!.validateInput as unknown as Validator
	}

	it("accepts an empty value — clearing the override is legal, not an error", async () => {
		expect((await captureValidator())("")).toBeNull()
	})

	it("accepts an absolute path", async () => {
		expect((await captureValidator())("/var/lib/shofer")).toBeNull()
	})

	it("refuses a RELATIVE path with a message rather than silently accepting it", async () => {
		const message = (await captureValidator())("relative/dir")
		expect(message).toBeTruthy()
		expect(message).not.toBeNull()
	})
})

describe("promptForCustomStoragePath write-back", () => {
	it("does nothing at all when the user cancels (undefined, not empty string)", async () => {
		inputBox().mockResolvedValueOnce(undefined)

		await promptForCustomStoragePath()

		expect(configuration().update).not.toHaveBeenCalled()
		expect(hoisted.notifier.info).not.toHaveBeenCalled()
		expect(hoisted.notifier.error).not.toHaveBeenCalled()
	})

	it("persists to the GLOBAL target and confirms once the directory is usable", async () => {
		inputBox().mockResolvedValueOnce("/var/lib/shofer")

		await promptForCustomStoragePath()

		expect(configuration().update).toHaveBeenCalledWith(
			"customStoragePath",
			"/var/lib/shofer",
			vscode.ConfigurationTarget.Global,
		)
		expect(hoisted.mkdir).toHaveBeenCalledWith("/var/lib/shofer", { recursive: true })
		expect(hoisted.access).toHaveBeenCalled()
		expect(hoisted.notifier.info).toHaveBeenCalled()
		expect(hoisted.notifier.error).not.toHaveBeenCalled()
	})

	it("reports an unusable directory as an ERROR, and still leaves the setting written", async () => {
		inputBox().mockResolvedValueOnce("/root/forbidden")
		hoisted.access.mockRejectedValueOnce(new Error("EACCES"))

		await promptForCustomStoragePath()

		expect(configuration().update).toHaveBeenCalled()
		expect(hoisted.notifier.error).toHaveBeenCalled()
		expect(hoisted.notifier.info).not.toHaveBeenCalled()
	})

	it("survives a non-Error rejection from the filesystem", async () => {
		inputBox().mockResolvedValueOnce("/root/forbidden")
		hoisted.mkdir.mockRejectedValueOnce("boom")

		await promptForCustomStoragePath()

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it("an EMPTY answer clears the override and says the default is back — it never touches the fs", async () => {
		inputBox().mockResolvedValueOnce("")

		await promptForCustomStoragePath()

		expect(configuration().update).toHaveBeenCalledWith("customStoragePath", "", vscode.ConfigurationTarget.Global)
		expect(hoisted.mkdir).not.toHaveBeenCalled()
		expect(hoisted.notifier.info).toHaveBeenCalled()
	})

	it("swallows a configuration-update failure instead of throwing at the command", async () => {
		inputBox().mockResolvedValueOnce("/var/lib/shofer")
		const readOnly = {
			get: vi.fn(() => ""),
			update: vi.fn(async () => {
				throw new Error("settings.json is read-only")
			}),
		} as never
		// Two reads: the one that seeds the input box, then the write-back's own.
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce(readOnly).mockReturnValueOnce(readOnly)

		await expect(promptForCustomStoragePath()).resolves.toBeUndefined()
		expect(hoisted.notifier.info).not.toHaveBeenCalled()
	})

	it("aborts before prompting when the configuration cannot be read at all", async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockImplementationOnce(() => {
			throw new Error("no configuration service")
		})

		await promptForCustomStoragePath()

		expect(inputBox()).not.toHaveBeenCalled()
	})

	it("seeds the input box with the currently configured path", async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
			get: vi.fn(() => "/previous/path"),
		} as never)
		inputBox().mockResolvedValueOnce(undefined)

		await promptForCustomStoragePath()

		expect(inputBox().mock.calls[0][0]!.value).toBe("/previous/path")
	})
})
