// npx vitest src/utils/__tests__/autoImportSettings.spec.ts

import type { OutputChannelLike } from "@shofer/core"

const hoisted = vi.hoisted(() => ({
	configuredPath: undefined as string | undefined,
	existingFiles: new Set<string>(),
	notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({
		config: { get: (_section: string, _key: string, def: unknown) => hoisted.configuredPath ?? def },
		notifier: hoisted.notifier,
	}),
}))

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return {
		...actual,
		default: { ...actual, homedir: () => "/home/user" },
		homedir: () => "/home/user",
	}
})

vi.mock("../fs", () => ({
	fileExistsAtPath: vi.fn(async (p: string) => hoisted.existingFiles.has(p)),
}))

vi.mock("../../core/config/importExport", () => ({
	importScopeSettingsArchive: vi.fn(async () => {}),
}))

import { autoImportSettings } from "../autoImportSettings"
import { importScopeSettingsArchive } from "../../core/config/importExport"

const outputChannel: OutputChannelLike = { appendLine: vi.fn() } as unknown as OutputChannelLike

const contextProxy = { refreshLayeredOverlay: vi.fn(async () => []) }
const customModesManager = { invalidateCache: vi.fn() }
const options = { contextProxy, customModesManager } as never

describe("autoImportSettings (scope-archive seed)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		hoisted.configuredPath = undefined
		hoisted.existingFiles.clear()
	})

	it("skips when no path is configured", async () => {
		await autoImportSettings(outputChannel, options)
		expect(importScopeSettingsArchive).not.toHaveBeenCalled()
	})

	it("skips when the archive does not exist", async () => {
		hoisted.configuredPath = "/etc/shofer/seed.tgz"

		await autoImportSettings(outputChannel, options)

		expect(importScopeSettingsArchive).not.toHaveBeenCalled()
	})

	it("unpacks the archive into the user scope and refreshes consumers", async () => {
		hoisted.configuredPath = "/etc/shofer/seed.tgz"
		hoisted.existingFiles.add("/etc/shofer/seed.tgz")

		await autoImportSettings(outputChannel, options)

		expect(importScopeSettingsArchive).toHaveBeenCalledWith("/etc/shofer/seed.tgz")
		expect(contextProxy.refreshLayeredOverlay).toHaveBeenCalled()
		expect(customModesManager.invalidateCache).toHaveBeenCalled()
		expect(hoisted.notifier.info).toHaveBeenCalled()
	})

	it("never overwrites an already-materialized user scope", async () => {
		hoisted.configuredPath = "/etc/shofer/seed.tgz"
		hoisted.existingFiles.add("/etc/shofer/seed.tgz")
		hoisted.existingFiles.add("/home/user/.shofer/settings.json")

		await autoImportSettings(outputChannel, options)

		expect(importScopeSettingsArchive).not.toHaveBeenCalled()
	})

	it("expands ~ against the home directory", async () => {
		hoisted.configuredPath = "~/seed.tgz"
		hoisted.existingFiles.add("/home/user/seed.tgz")

		await autoImportSettings(outputChannel, options)

		expect(importScopeSettingsArchive).toHaveBeenCalledWith("/home/user/seed.tgz")
	})

	it("does not throw on an unpack failure (activation must survive)", async () => {
		hoisted.configuredPath = "/etc/shofer/seed.tgz"
		hoisted.existingFiles.add("/etc/shofer/seed.tgz")
		vi.mocked(importScopeSettingsArchive).mockRejectedValueOnce(new Error("corrupt archive"))

		await expect(autoImportSettings(outputChannel, options)).resolves.toBeUndefined()
		expect(hoisted.notifier.info).not.toHaveBeenCalled()
	})
})
