// npx vitest src/core/config/__tests__/importExport.spec.ts

import fs from "fs/promises"
import * as path from "path"

import * as vscode from "vscode"
import { installVsCodeForwardingHost } from "../../../host/__tests__/forwarding-host"

import type { ProviderName } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { importSettings, importSettingsFromFile, importSettingsWithFeedback, exportSettings } from "../importExport"
import { ProviderSettingsManager } from "../ProviderSettingsManager"
import { ContextProxy } from "../ContextProxy"
import { CustomModesManager } from "../CustomModesManager"
import { safeWriteJson } from "@shofer/core"

import type { Mock } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn(),
		}),
	},
	window: {
		showOpenDialog: vi.fn(),
		showSaveDialog: vi.fn(),
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	Uri: {
		file: vi.fn((filePath) => ({ fsPath: filePath })),
	},
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(),
		mkdir: vi.fn(),
		writeFile: vi.fn(),
		access: vi.fn(),
		constants: {
			F_OK: 0,
			R_OK: 4,
		},
	},
	readFile: vi.fn(),
	mkdir: vi.fn(),
	writeFile: vi.fn(),
	access: vi.fn(),
	constants: {
		F_OK: 0,
		R_OK: 4,
	},
	rename: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("os", () => ({
	default: {
		homedir: vi.fn(() => "/mock/home"),
	},
	homedir: vi.fn(() => "/mock/home"),
}))

// safeWriteJson and buildApiHandler are now exported from @shofer/core; partially mock them there.
// buildApiHandler is mocked to avoid issues with provider instantiation in tests.
vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	safeWriteJson: vi.fn(),
	buildApiHandler: vi.fn().mockImplementation((config) => {
		// Return different model info based on the provider and model
		const getModelInfo = () => {
			if (config.apiProvider === "anthropic" && config.apiModelId === "claude-3-5-sonnet-20241022") {
				return {
					id: "claude-3-5-sonnet-20241022",
					info: {
						supportsReasoningBudget: true,
						requiredReasoningBudget: true,
					},
				}
			}
			// Default fallback
			return {
				id: config.apiModelId || "claude-sonnet-4-5",
				info: {
					supportsReasoningBudget: false,
					requiredReasoningBudget: false,
				},
			}
		}

		return {
			getModel: vi.fn().mockReturnValue(getModelInfo()),
		}
	}),
}))

describe("importExport", () => {
	let mockProviderSettingsManager: ReturnType<typeof vi.mocked<ProviderSettingsManager>>
	let mockContextProxy: ReturnType<typeof vi.mocked<ContextProxy>>
	let mockExtensionContext: ReturnType<typeof vi.mocked<vscode.ExtensionContext>>
	let mockCustomModesManager: ReturnType<typeof vi.mocked<CustomModesManager>>

	beforeEach(() => {
		vi.clearAllMocks()
		installVsCodeForwardingHost()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		mockProviderSettingsManager = {
			export: vi.fn(),
			import: vi.fn(),
			listConfig: vi.fn(),
		} as unknown as ReturnType<typeof vi.mocked<ProviderSettingsManager>>

		mockContextProxy = {
			setValues: vi.fn(),
			setValue: vi.fn(),
			export: vi.fn().mockImplementation(() => Promise.resolve({})),
			setProviderSettings: vi.fn(),
			getValue: vi.fn(),
		} as unknown as ReturnType<typeof vi.mocked<ContextProxy>>

		mockCustomModesManager = { updateCustomMode: vi.fn() } as unknown as ReturnType<
			typeof vi.mocked<CustomModesManager>
		>

		const map = new Map<string, string>()

		mockExtensionContext = {
			secrets: {
				get: vi.fn().mockImplementation((key: string) => map.get(key)),
				store: vi.fn().mockImplementation((key: string, value: string) => map.set(key, value)),
			},
		} as unknown as ReturnType<typeof vi.mocked<vscode.ExtensionContext>>
	})

	describe("importSettings", () => {
		it("should return success: false when user cancels file selection", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue(undefined)

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result).toEqual({ success: false, error: "User cancelled file selection" })

			expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({
				filters: { JSON: ["json"] },
				canSelectMany: false,
				defaultUri: expect.anything(), // Defaults to Downloads or last export path
			})

			expect(fs.readFile).not.toHaveBeenCalled()
			expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			expect(mockContextProxy.setValues).not.toHaveBeenCalled()
		})

		it("should import settings successfully from a valid file", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const mockFileContent = JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "test",
					apiConfigs: { test: { apiProvider: "openai" as ProviderName, apiKey: "test-key", id: "test-id" } },
				},
				globalSettings: { mode: "code", autoApprovalEnabled: true },
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			const previousProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
			}

			mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)

			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "test", id: "test-id", apiProvider: "openai" as ProviderName },
				{ name: "default", id: "default-id", apiProvider: "anthropic" as ProviderName },
			])

			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()

			expect(mockProviderSettingsManager.import).toHaveBeenCalledWith({
				currentApiConfigName: "test",
				apiConfigs: {
					default: { apiProvider: "anthropic" as ProviderName, id: "default-id" },
					test: { apiProvider: "openai" as ProviderName, apiKey: "test-key", id: "test-id" },
				},
				modeApiConfigs: {},
			})

			expect(mockContextProxy.setValues).toHaveBeenCalledWith({ mode: "code", autoApprovalEnabled: true })
			expect(mockContextProxy.setValue).toHaveBeenCalledWith("currentApiConfigName", "test")

			expect(mockContextProxy.setValue).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test", id: "test-id", apiProvider: "openai" as ProviderName },
				{ name: "default", id: "default-id", apiProvider: "anthropic" as ProviderName },
			])
		})

		it("should return success: false when file content is invalid", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			// Invalid content (missing required fields).
			const mockInvalidContent = JSON.stringify({
				providerProfiles: { apiConfigs: {} },
				globalSettings: {},
			})

			;(fs.readFile as Mock).mockResolvedValue(mockInvalidContent)

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result).toEqual({ success: false, error: "[providerProfiles.currentApiConfigName]: Required" })
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			expect(mockContextProxy.setValues).not.toHaveBeenCalled()
		})

		it("should import settings successfully when globalSettings key is missing", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const mockFileContent = JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "test",
					apiConfigs: { test: { apiProvider: "openai" as ProviderName, apiKey: "test-key", id: "test-id" } },
				},
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			const previousProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
			}

			mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)

			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "test", id: "test-id", apiProvider: "openai" as ProviderName },
				{ name: "default", id: "default-id", apiProvider: "anthropic" as ProviderName },
			])

			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()
			expect(mockProviderSettingsManager.import).toHaveBeenCalledWith({
				currentApiConfigName: "test",
				apiConfigs: {
					default: { apiProvider: "anthropic" as ProviderName, id: "default-id" },
					test: { apiProvider: "openai" as ProviderName, apiKey: "test-key", id: "test-id" },
				},
				modeApiConfigs: {},
			})

			// Should call setValues with an empty object since globalSettings is missing.
			expect(mockContextProxy.setValues).toHaveBeenCalledWith({})
			expect(mockContextProxy.setValue).toHaveBeenCalledWith("currentApiConfigName", "test")
			expect(mockContextProxy.setValue).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test", id: "test-id", apiProvider: "openai" as ProviderName },
				{ name: "default", id: "default-id", apiProvider: "anthropic" as ProviderName },
			])
		})

		it("should return success: false when file content is not valid JSON", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])
			const mockInvalidJson = "{ this is not valid JSON }"
			;(fs.readFile as Mock).mockResolvedValue(mockInvalidJson)

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(false)
			expect(result.error).toMatch(/^Expected property name or '}' in JSON at position 2/)
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			expect(mockContextProxy.setValues).not.toHaveBeenCalled()
		})

		it("should return success: false when reading file fails", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])
			;(fs.readFile as Mock).mockRejectedValue(new Error("File read error"))

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result).toEqual({ success: false, error: "File read error" })
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			expect(mockContextProxy.setValues).not.toHaveBeenCalled()
		})

		it("should not clobber existing api configs", async () => {
			const providerSettingsManager = new ProviderSettingsManager(mockExtensionContext)
			await providerSettingsManager.saveConfig("openai", { apiProvider: "openai", id: "openai" })

			const configs = await providerSettingsManager.listConfig()
			expect(configs[0].name).toBe("default")
			expect(configs[1].name).toBe("openai")
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const mockFileContent = JSON.stringify({
				globalSettings: { mode: "code" },
				providerProfiles: {
					currentApiConfigName: "anthropic",
					apiConfigs: { default: { apiProvider: "anthropic" as const, id: "anthropic" } },
				},
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettings({
				providerSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			if (result.success && "providerProfiles" in result) {
				expect(result.providerProfiles?.apiConfigs["openai"]).toBeDefined()
				expect(result.providerProfiles?.apiConfigs["default"]).toBeDefined()
				expect(result.providerProfiles?.apiConfigs["default"].apiProvider).toBe("anthropic")
			}
		})

		it("should call updateCustomMode for each custom mode in config", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const customModes = [
				{ slug: "mode1", name: "Mode One", roleDefinition: "Custom role one", tools: [] },
				{ slug: "mode2", name: "Mode Two", roleDefinition: "Custom role two", tools: [] },
			]

			const mockFileContent = JSON.stringify({
				providerProfiles: { currentApiConfigName: "test", apiConfigs: {} },
				globalSettings: { mode: "code", customModes },
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			mockProviderSettingsManager.export.mockResolvedValue({
				currentApiConfigName: "test",
				apiConfigs: {},
			})

			mockProviderSettingsManager.listConfig.mockResolvedValue([])

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			expect(mockCustomModesManager.updateCustomMode).toHaveBeenCalledTimes(customModes.length)

			customModes.forEach((mode) => {
				expect(mockCustomModesManager.updateCustomMode).toHaveBeenCalledWith(mode.slug, mode)
			})
		})

		it("should import settings from provided file path without showing dialog", async () => {
			const filePath = "/mock/path/settings.json"
			const mockFileContent = JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "test",
					apiConfigs: { test: { apiProvider: "openai" as ProviderName, apiKey: "test-key", id: "test-id" } },
				},
				globalSettings: { mode: "code", autoApprovalEnabled: true },
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
			;(fs.access as Mock).mockResolvedValue(undefined) // File exists and is readable

			const previousProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
			}

			mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)
			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "test", id: "test-id", apiProvider: "openai" as ProviderName },
				{ name: "default", id: "default-id", apiProvider: "anthropic" as ProviderName },
			])
			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettingsFromFile(
				{
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				},
				vscode.Uri.file(filePath),
			)

			expect(vscode.window.showOpenDialog).not.toHaveBeenCalled()
			expect(fs.readFile).toHaveBeenCalledWith(filePath, "utf-8")
			expect(result.success).toBe(true)
			expect(mockProviderSettingsManager.import).toHaveBeenCalledWith({
				currentApiConfigName: "test",
				apiConfigs: {
					default: { apiProvider: "anthropic" as ProviderName, id: "default-id" },
					test: { apiProvider: "openai" as ProviderName, apiKey: "test-key", id: "test-id" },
				},
				modeApiConfigs: {},
			})
			expect(mockContextProxy.setValues).toHaveBeenCalledWith({ mode: "code", autoApprovalEnabled: true })
		})

		it("should return error when provided file path does not exist", async () => {
			const filePath = "/nonexistent/path/settings.json"
			const accessError = new Error("ENOENT: no such file or directory")

			;(fs.access as Mock).mockRejectedValue(accessError)

			// Create a mock provider for the test
			const mockProvider = {
				settingsImportedAt: 0,
				postInitState: vi.fn().mockResolvedValue(undefined),
			}

			// Mock the showErrorMessage to capture the error
			const showErrorMessageSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)

			await importSettingsWithFeedback(
				{
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
					provider: mockProvider,
				},
				filePath,
			)

			expect(vscode.window.showOpenDialog).not.toHaveBeenCalled()
			expect(fs.access).toHaveBeenCalledWith(filePath, fs.constants.F_OK | fs.constants.R_OK)
			expect(fs.readFile).not.toHaveBeenCalled()
			expect(showErrorMessageSpy).toHaveBeenCalledWith(expect.stringContaining("errors.settings_import_failed"))

			showErrorMessageSpy.mockRestore()
		})

		it("should handle import when reasoning budget fields are missing from config", async () => {
			// This test verifies that import works correctly when reasoning budget fields are not present

			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const mockFileContent = JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "openai-provider",
					apiConfigs: {
						"openai-provider": {
							apiProvider: "openai" as ProviderName,
							apiModelId: "gpt-4",
							id: "openai-id",
							apiKey: "test-key",
							// No modelMaxTokens or modelMaxThinkingTokens fields
						},
					},
				},
				globalSettings: { mode: "code", autoApprovalEnabled: true },
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			const previousProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
			}

			mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)
			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "openai-provider", id: "openai-id", apiProvider: "openai" as ProviderName },
				{ name: "default", id: "default-id", apiProvider: "anthropic" as ProviderName },
			])

			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()

			expect(mockProviderSettingsManager.import).toHaveBeenCalledWith({
				currentApiConfigName: "openai-provider",
				apiConfigs: {
					default: { apiProvider: "anthropic" as ProviderName, id: "default-id" },
					"openai-provider": {
						apiProvider: "openai" as ProviderName,
						apiModelId: "gpt-4",
						apiKey: "test-key",
						id: "openai-id",
					},
				},
				modeApiConfigs: {},
			})

			expect(mockContextProxy.setValues).toHaveBeenCalledWith({ mode: "code", autoApprovalEnabled: true })
			expect(mockContextProxy.setValue).toHaveBeenCalledWith("currentApiConfigName", "openai-provider")
		})

		describe("lenient import with invalid providers", () => {
			it("should sanitize profiles with invalid apiProvider and return warnings", async () => {
				// Test importing a profile with a removed/invalid provider like "claude-code"
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: "openai" as ProviderName,
								apiKey: "test-key",
								id: "valid-id",
							},
							"invalid-profile": {
								apiProvider: "claude-code", // Invalid/removed provider
								apiKey: "some-key",
								id: "invalid-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: "openai" as ProviderName },
					{ name: "default", id: "default-id", apiProvider: "anthropic" as ProviderName },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should succeed
				expect(result.success).toBe(true)

				// Should have warnings about the sanitized profile
				expect(result).toHaveProperty("warnings")
				expect((result as { warnings?: string[] }).warnings).toBeDefined()
				expect((result as { warnings?: string[] }).warnings!.length).toBeGreaterThan(0)
				expect((result as { warnings?: string[] }).warnings![0]).toContain("invalid-profile")
				expect((result as { warnings?: string[] }).warnings![0]).toContain("claude-code")

				// The valid profile should be imported
				expect(mockProviderSettingsManager.import).toHaveBeenCalled()
				const importedProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				expect(importedProfiles.apiConfigs["valid-profile"]).toBeDefined()
				expect(importedProfiles.apiConfigs["valid-profile"].apiProvider).toBe("openai")

				// The invalid profile should still be imported but without apiProvider
				expect(importedProfiles.apiConfigs["invalid-profile"]).toBeDefined()
				expect(importedProfiles.apiConfigs["invalid-profile"].apiProvider).toBeUndefined()
			})

			it("should skip completely invalid profiles and return warnings", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: "openai" as ProviderName,
								apiKey: "test-key",
								id: "valid-id",
							},
							"type-invalid": {
								// Invalid type - modelTemperature should be a number, not a string
								modelTemperature: "not-a-number",
								id: "type-invalid-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: "openai" as ProviderName },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should succeed (valid profile was imported)
				expect(result.success).toBe(true)

				// Should have warnings about the skipped profile
				expect((result as { warnings?: string[] }).warnings).toBeDefined()
				expect((result as { warnings?: string[] }).warnings!.some((w) => w.includes("type-invalid"))).toBe(true)
				expect((result as { warnings?: string[] }).warnings!.some((w) => w.includes("skipped"))).toBe(true)

				// The valid profile should be imported
				const importedProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				expect(importedProfiles.apiConfigs["valid-profile"]).toBeDefined()

				// The type-invalid profile should NOT be imported
				expect(importedProfiles.apiConfigs["type-invalid"]).toBeUndefined()
			})

			it("should fail when NO valid profiles can be imported", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "invalid-profile",
						apiConfigs: {
							"invalid-profile-1": {
								// Invalid type - rateLimitSeconds should be number
								rateLimitSeconds: "not-a-number",
								id: "invalid-1",
							},
							"invalid-profile-2": {
								// Invalid type - modelTemperature should be number
								modelTemperature: { invalid: "object" },
								id: "invalid-2",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
				})

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should fail since all profiles have schema validation errors
				expect(result.success).toBe(false)
				expect(result.error).toContain("No valid profiles could be imported")

				// Should NOT have called import since there were no valid profiles
				expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			})

			it("should show warning notification when importing with warnings via importSettingsWithFeedback", async () => {
				const filePath = "/mock/path/settings.json"
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: "openai" as ProviderName,
								apiKey: "test-key",
								id: "valid-id",
							},
							"problematic-profile": {
								apiProvider: "removed-provider", // Invalid provider
								apiKey: "some-key",
								id: "problematic-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
				;(fs.access as Mock).mockResolvedValue(undefined)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: "openai" as ProviderName },
				])

				const mockProvider = {
					settingsImportedAt: 0,
					postInitState: vi.fn().mockResolvedValue(undefined),
				}

				const showWarningMessageSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
				const showInfoMessageSpy = vi
					.spyOn(vscode.window, "showInformationMessage")
					.mockResolvedValue(undefined)

				await importSettingsWithFeedback(
					{
						providerSettingsManager: mockProviderSettingsManager,
						contextProxy: mockContextProxy,
						customModesManager: mockCustomModesManager,
						provider: mockProvider,
					},
					filePath,
				)

				// Should show warning message with short summary (not full details)
				expect(showWarningMessageSpy).toHaveBeenCalledWith(
					expect.stringContaining("1 profile had issues during import."),
				)
				expect(showWarningMessageSpy).toHaveBeenCalledWith(
					expect.stringContaining("See Developer Tools console for details."),
				)
				expect(showInfoMessageSpy).not.toHaveBeenCalled()

				// Provider state should still be updated
				expect(mockProvider.settingsImportedAt).toBeGreaterThan(0)
				expect(mockProvider.postInitState).toHaveBeenCalled()

				showWarningMessageSpy.mockRestore()
				showInfoMessageSpy.mockRestore()
			})

			it("should handle multiple profiles with mixed valid and invalid providers", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "anthropic-profile",
						apiConfigs: {
							"anthropic-profile": {
								apiProvider: "anthropic" as ProviderName,
								anthropicApiKey: "key-1",
								id: "anthropic-id",
							},
							"openai-profile": {
								apiProvider: "openai" as ProviderName,
								apiKey: "key-2",
								id: "openai-id",
							},
							"old-claude-profile": {
								apiProvider: "claude-code", // Removed provider
								apiKey: "key-3",
								id: "claude-id",
							},
							"another-invalid": {
								apiProvider: "some-old-provider", // Another removed provider
								apiKey: "key-4",
								id: "another-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "anthropic-profile", id: "anthropic-id", apiProvider: "anthropic" as ProviderName },
					{ name: "openai-profile", id: "openai-id", apiProvider: "openai" as ProviderName },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should succeed
				expect(result.success).toBe(true)

				// Should have multiple warnings
				const warnings = (result as { warnings?: string[] }).warnings!
				expect(warnings.length).toBe(2) // Two profiles had invalid providers
				expect(warnings.some((w) => w.includes("old-claude-profile"))).toBe(true)
				expect(warnings.some((w) => w.includes("another-invalid"))).toBe(true)

				// Valid profiles should be imported correctly
				const importedProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				expect(importedProfiles.apiConfigs["anthropic-profile"].apiProvider).toBe("anthropic")
				expect(importedProfiles.apiConfigs["openai-profile"].apiProvider).toBe("openai")

				// Invalid provider profiles should have apiProvider removed
				expect(importedProfiles.apiConfigs["old-claude-profile"].apiProvider).toBeUndefined()
				expect(importedProfiles.apiConfigs["another-invalid"].apiProvider).toBeUndefined()
			})

			it("should fallback currentApiConfigName when the imported current profile was skipped", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				// Import file where currentApiConfigName points to an invalid profile that gets skipped
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "invalid-current-profile", // This profile is completely invalid
						apiConfigs: {
							"invalid-current-profile": {
								// Invalid type - rateLimitSeconds should be number
								rateLimitSeconds: "not-a-number",
								id: "invalid-current-id",
							},
							"valid-fallback-profile": {
								apiProvider: "openai" as ProviderName,
								apiKey: "test-key",
								id: "fallback-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-fallback-profile", id: "fallback-id", apiProvider: "openai" as ProviderName },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should succeed
				expect(result.success).toBe(true)

				// Should have warnings about the skipped profile AND the fallback
				const warnings = (result as { warnings?: string[] }).warnings!
				expect(warnings).toBeDefined()
				expect(warnings.some((w) => w.includes("invalid-current-profile") && w.includes("skipped"))).toBe(true)
				expect(
					warnings.some(
						(w) =>
							w.includes("invalid-current-profile") &&
							w.includes("not available") &&
							w.includes("valid-fallback-profile"),
					),
				).toBe(true)

				// The currentApiConfigName should be set to the valid fallback profile, not the invalid one
				const importedProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				expect(importedProfiles.currentApiConfigName).toBe("valid-fallback-profile")

				// contextProxy should also be set with the fallback profile name
				expect(mockContextProxy.setValue).toHaveBeenCalledWith("currentApiConfigName", "valid-fallback-profile")

				// The invalid profile should NOT be imported
				expect(importedProfiles.apiConfigs["invalid-current-profile"]).toBeUndefined()
				// The valid fallback profile should be imported
				expect(importedProfiles.apiConfigs["valid-fallback-profile"]).toBeDefined()
			})

			it("should keep previous currentApiConfigName when all imported profiles are invalid", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				// All profiles in the import are invalid, but we have existing profiles
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "invalid-profile",
						apiConfigs: {
							"invalid-profile": {
								rateLimitSeconds: "not-a-number",
								id: "invalid-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "existing-profile",
					apiConfigs: {
						"existing-profile": { apiProvider: "anthropic" as ProviderName, id: "existing-id" },
					},
				})

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should fail because no valid profiles could be imported
				expect(result.success).toBe(false)
				expect(result.error).toContain("No valid profiles could be imported")
			})

			it("should show plural summary for multiple profile warnings via importSettingsWithFeedback", async () => {
				const filePath = "/mock/path/settings.json"
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: "openai" as ProviderName,
								apiKey: "test-key",
								id: "valid-id",
							},
							"problematic-profile-1": {
								apiProvider: "removed-provider-1",
								apiKey: "key-1",
								id: "problematic-id-1",
							},
							"problematic-profile-2": {
								apiProvider: "removed-provider-2",
								apiKey: "key-2",
								id: "problematic-id-2",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
				;(fs.access as Mock).mockResolvedValue(undefined)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: "anthropic" as ProviderName, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: "openai" as ProviderName },
				])

				const mockProvider = {
					settingsImportedAt: 0,
					postInitState: vi.fn().mockResolvedValue(undefined),
				}

				const showWarningMessageSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)

				await importSettingsWithFeedback(
					{
						providerSettingsManager: mockProviderSettingsManager,
						contextProxy: mockContextProxy,
						customModesManager: mockCustomModesManager,
						provider: mockProvider,
					},
					filePath,
				)

				// Should show warning message with plural summary for multiple warnings
				expect(showWarningMessageSpy).toHaveBeenCalledWith(
					expect.stringContaining("2 profiles had issues during import."),
				)
				showWarningMessageSpy.mockRestore()
			})
		})
	})

	describe("exportSettings", () => {
		it("should not export settings when user cancels file selection", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue(undefined)

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalledWith({
				filters: { JSON: ["json"] },
				defaultUri: expect.anything(),
			})

			expect(mockProviderSettingsManager.export).not.toHaveBeenCalled()
			expect(mockContextProxy.export).not.toHaveBeenCalled()
			expect(fs.writeFile).not.toHaveBeenCalled()
		})

		it("should export settings to the selected file location", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/shofer-code-settings.json",
			})

			const mockProviderProfiles = {
				currentApiConfigName: "test",
				apiConfigs: { test: { apiProvider: "openai" as ProviderName, id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			}

			mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
			const mockGlobalSettings = { mode: "code", autoApprovalEnabled: true }
			mockContextProxy.export.mockResolvedValue(mockGlobalSettings)

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalledWith({
				filters: { JSON: ["json"] },
				defaultUri: expect.anything(),
			})

			expect(mockProviderSettingsManager.export).toHaveBeenCalled()
			expect(mockContextProxy.export).toHaveBeenCalled()
			expect(fs.mkdir).toHaveBeenCalledWith("/mock/path", { recursive: true })

			expect(safeWriteJson).toHaveBeenCalledWith("/mock/path/shofer-code-settings.json", {
				providerProfiles: mockProviderProfiles,
				globalSettings: mockGlobalSettings,
			})
		})

		it("should include globalSettings when allowedMaxRequests is null", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/shofer-code-settings.json",
			})

			const mockProviderProfiles = {
				currentApiConfigName: "test",
				apiConfigs: { test: { apiProvider: "openai" as ProviderName, id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			}

			mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)

			const mockGlobalSettings = {
				mode: "code",
				autoApprovalEnabled: true,
				allowedMaxRequests: null,
			}

			mockContextProxy.export.mockResolvedValue(mockGlobalSettings)

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(safeWriteJson).toHaveBeenCalledWith("/mock/path/shofer-code-settings.json", {
				providerProfiles: mockProviderProfiles,
				globalSettings: mockGlobalSettings,
			})
		})

		it("should handle errors during the export process", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/shofer-code-settings.json",
			})

			mockProviderSettingsManager.export.mockResolvedValue({
				currentApiConfigName: "test",
				apiConfigs: { test: { apiProvider: "openai" as ProviderName, id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			})

			mockContextProxy.export.mockResolvedValue({ mode: "code" })
			// Simulate an error during the safeWriteJson operation
			;(safeWriteJson as Mock).mockRejectedValueOnce(new Error("Safe write error"))

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalled()
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()
			expect(mockContextProxy.export).toHaveBeenCalled()
			expect(fs.mkdir).toHaveBeenCalledWith("/mock/path", { recursive: true })
			expect(safeWriteJson).toHaveBeenCalled() // safeWriteJson is called, but it will throw
			// The error is caught and the function exits silently.
			// Optionally, ensure no error message was shown if that's part of "silent"
			// expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
		})

		it("should handle errors during directory creation", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/shofer-code-settings.json",
			})

			mockProviderSettingsManager.export.mockResolvedValue({
				currentApiConfigName: "test",
				apiConfigs: { test: { apiProvider: "openai" as ProviderName, id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			})

			mockContextProxy.export.mockResolvedValue({ mode: "code" })
			;(fs.mkdir as Mock).mockRejectedValue(new Error("Directory creation error"))

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalled()
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()
			expect(mockContextProxy.export).toHaveBeenCalled()
			expect(fs.mkdir).toHaveBeenCalled()
			expect(safeWriteJson).not.toHaveBeenCalled() // Should not be called since mkdir failed.
		})

		it("should use the correct default save location", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue(undefined)

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalledWith({
				filters: { JSON: ["json"] },
				defaultUri: expect.anything(),
			})

			expect(vscode.Uri.file).toHaveBeenCalledWith(
				path.join("/mock/home", "Downloads", "shofer-code-settings.json"),
			)
		})

		it.each([
			{
				testCase: "supportsReasoningBudget is false",
				providerName: "deepseek-provider",
				modelId: "deepseek-chat",
				providerId: "deepseek-id",
			},
			{
				testCase: "requiredReasoningBudget is false",
				providerName: "deepseek-provider-2",
				modelId: "deepseek-coder",
				providerId: "deepseek-id-2",
			},
			{
				testCase: "both supportsReasoningBudget and requiredReasoningBudget are false",
				providerName: "deepseek-provider-3",
				modelId: "deepseek-reasoner",
				providerId: "deepseek-id-3",
			},
		])(
			"should exclude modelMaxTokens and modelMaxThinkingTokens when $testCase",
			async ({ providerName, modelId, providerId }) => {
				// This test verifies that token fields are excluded when model doesn't support reasoning budget
				// Using deepseek provider which uses apiModelId and has supportsReasoningBudget: false

				;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
					fsPath: "/mock/path/shofer-code-settings.json",
				})

				// Use a real ProviderSettingsManager instance to test the actual filtering logic
				const realProviderSettingsManager = new ProviderSettingsManager(mockExtensionContext)

				// Wait for initialization to complete
				await realProviderSettingsManager.initialize()

				// Save a deepseek provider config with token fields
				await realProviderSettingsManager.saveConfig(providerName, {
					apiProvider: "deepseek" as ProviderName,
					apiModelId: modelId,
					id: providerId,
					deepSeekApiKey: "test-key",
					modelMaxTokens: 4096, // This should be removed during export
					modelMaxThinkingTokens: 2048, // This should be removed during export
				})

				// Set this as the current provider
				await realProviderSettingsManager.activateProfile({ name: providerName })

				const mockGlobalSettings = {
					mode: "code",
					autoApprovalEnabled: true,
				}

				mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
				;(fs.mkdir as Mock).mockResolvedValue(undefined)

				await exportSettings({
					providerSettingsManager: realProviderSettingsManager,
					contextProxy: mockContextProxy,
				})

				// Get the exported data
				const exportedData = (safeWriteJson as Mock).mock.calls[0][1]

				// Verify that token fields were excluded because reasoning budget is not supported/required
				const provider = exportedData.providerProfiles.apiConfigs[providerName]
				expect(provider).toBeDefined()
				expect(provider.apiModelId).toBe(modelId)
				expect("modelMaxTokens" in provider).toBe(false) // Should be excluded
				expect("modelMaxThinkingTokens" in provider).toBe(false) // Should be excluded
			},
		)
	})
})
