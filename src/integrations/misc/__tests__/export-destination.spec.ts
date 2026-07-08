import { afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import { isWebHost, pickExportDestination } from "../export-destination"

describe("export-destination", () => {
	afterEach(() => {
		// Restore the default desktop host so tests don't leak state.
		;(vscode.env as { uiKind: number }).uiKind = vscode.UIKind.Desktop
		vi.restoreAllMocks()
	})

	describe("isWebHost", () => {
		it("is false on a desktop host", () => {
			;(vscode.env as { uiKind: number }).uiKind = vscode.UIKind.Desktop
			expect(isWebHost()).toBe(false)
		})

		it("is true on a web host (code-server / vscode.dev)", () => {
			;(vscode.env as { uiKind: number }).uiKind = vscode.UIKind.Web
			expect(isWebHost()).toBe(true)
		})
	})

	describe("pickExportDestination", () => {
		it("saves to the remote host without prompting on desktop", async () => {
			;(vscode.env as { uiKind: number }).uiKind = vscode.UIKind.Desktop
			const quickPick = vi.spyOn(vscode.window, "showQuickPick")

			await expect(pickExportDestination()).resolves.toBe("remote")
			expect(quickPick).not.toHaveBeenCalled()
		})

		it("prompts on a web host and returns the chosen destination", async () => {
			;(vscode.env as { uiKind: number }).uiKind = vscode.UIKind.Web
			vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ value: "browser" } as never)

			await expect(pickExportDestination()).resolves.toBe("browser")
		})

		it("returns the remote option when the user picks it on a web host", async () => {
			;(vscode.env as { uiKind: number }).uiKind = vscode.UIKind.Web
			vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ value: "remote" } as never)

			await expect(pickExportDestination()).resolves.toBe("remote")
		})

		it("returns undefined when the user dismisses the picker on a web host", async () => {
			;(vscode.env as { uiKind: number }).uiKind = vscode.UIKind.Web
			vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined as never)

			await expect(pickExportDestination()).resolves.toBeUndefined()
		})
	})
})
