// npx vitest src/core/config/__tests__/importExport.spec.ts

import * as vscode from "vscode"

const hoisted = vi.hoisted(() => ({
	notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("vscode", () => ({
	window: {
		showSaveDialog: vi.fn(),
		showOpenDialog: vi.fn(),
	},
	Uri: {
		file: vi.fn((p: string) => ({ fsPath: p })),
	},
}))

vi.mock("fs/promises", () => ({
	default: {
		mkdir: vi.fn(async () => undefined),
		access: vi.fn(async () => undefined),
		constants: { F_OK: 0, R_OK: 4 },
	},
	constants: { F_OK: 0, R_OK: 4 },
}))

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({ notifier: hoisted.notifier }),
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	exportScopeArchive: vi.fn(async () => {}),
	importScopeArchive: vi.fn(async () => {}),
}))

vi.mock("../../../utils/export", () => ({
	resolveDefaultSaveUri: vi.fn(() => ({ fsPath: "/home/user/Downloads/shofer-settings.tgz" })),
	saveLastExportPath: vi.fn(async () => {}),
}))

import { exportScopeArchive, importScopeArchive } from "@shofer/core"

import {
	exportSettings,
	exportScopeSettingsArchive,
	importScopeSettingsArchive,
	importSettings,
	importSettingsWithFeedback,
} from "../importExport"

const contextProxy = { refreshLayeredOverlay: vi.fn(async () => []) } as never
const customModesManager = { invalidateCache: vi.fn(), getCustomModes: vi.fn(async () => []) } as never
const provider = { settingsImportedAt: undefined as number | undefined, postInitState: vi.fn(async () => {}) }

describe("importExport (scope archives)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("exportSettings", () => {
		it("does nothing when the save dialog is cancelled", async () => {
			vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(undefined)

			await exportSettings({ contextProxy })

			expect(exportScopeArchive).not.toHaveBeenCalled()
		})

		it("archives the user scope's .shofer to the chosen path", async () => {
			vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({
				fsPath: "/tmp/out/settings.tgz",
			} as vscode.Uri)

			await exportSettings({ contextProxy })

			expect(exportScopeArchive).toHaveBeenCalledWith(
				expect.stringMatching(/\.shofer$/),
				"/tmp/out/settings.tgz",
			)
		})
	})

	describe("exportScopeSettingsArchive / importScopeSettingsArchive", () => {
		it("default to the user scope root", async () => {
			await exportScopeSettingsArchive("/tmp/a.tgz")
			expect(exportScopeArchive).toHaveBeenCalledWith(expect.stringMatching(/\.shofer$/), "/tmp/a.tgz")

			await importScopeSettingsArchive("/tmp/a.tgz")
			expect(importScopeArchive).toHaveBeenCalledWith("/tmp/a.tgz", expect.stringMatching(/\.shofer$/))
		})
	})

	describe("importSettings", () => {
		it("reports cancellation without unpacking", async () => {
			vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined)

			const result = await importSettings({ contextProxy, customModesManager })

			expect(result.success).toBe(false)
			expect(importScopeArchive).not.toHaveBeenCalled()
		})

		it("unpacks the chosen archive and refreshes the live consumers", async () => {
			vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ fsPath: "/tmp/in.tgz" } as vscode.Uri])

			const result = await importSettings({ contextProxy, customModesManager })

			expect(result.success).toBe(true)
			expect(importScopeArchive).toHaveBeenCalledWith("/tmp/in.tgz", expect.stringMatching(/\.shofer$/))
			expect((contextProxy as any).refreshLayeredOverlay).toHaveBeenCalled()
			expect((customModesManager as any).invalidateCache).toHaveBeenCalled()
		})
	})

	describe("importSettingsWithFeedback", () => {
		it("imports a given archive path, refreshes provider state, and notifies", async () => {
			await importSettingsWithFeedback({ contextProxy, customModesManager, provider }, "/tmp/in.tgz")

			expect(importScopeArchive).toHaveBeenCalledWith("/tmp/in.tgz", expect.stringMatching(/\.shofer$/))
			expect(provider.postInitState).toHaveBeenCalled()
			expect(provider.settingsImportedAt).toBeTypeOf("number")
			expect(hoisted.notifier.info).toHaveBeenCalled()
		})

		it("surfaces an unpack failure as an error notification", async () => {
			vi.mocked(importScopeArchive).mockRejectedValueOnce(new Error("corrupt archive"))

			await importSettingsWithFeedback({ contextProxy, customModesManager, provider }, "/tmp/in.tgz")

			expect(hoisted.notifier.error).toHaveBeenCalled()
			expect(hoisted.notifier.info).not.toHaveBeenCalled()
		})

		it("surfaces an unreadable path as an error notification", async () => {
			const fsp = await import("fs/promises")
			vi.mocked(fsp.default.access).mockRejectedValueOnce(new Error("EACCES"))

			await importSettingsWithFeedback({ contextProxy, customModesManager, provider }, "/tmp/in.tgz")

			expect(importScopeArchive).not.toHaveBeenCalled()
			expect(hoisted.notifier.error).toHaveBeenCalled()
		})
	})
})
