// Mock dependencies
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	TreeItem: class {},
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: class {
		constructor(_id: string) {}
	},
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
	},
}))

vi.mock("fs/promises", () => ({
	__esModule: true,
	default: {
		readFile: vi.fn(),
	},
	readFile: vi.fn(),
}))

vi.mock("path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("path")>()
	return {
		...actual,
		default: {
			...actual,
			join: vi.fn((...args: string[]) => args.join("/")),
			isAbsolute: vi.fn((p: string) => p.startsWith("/")),
			basename: vi.fn((p: string) => p.split("/").pop() || ""),
		},
		join: vi.fn((...args: string[]) => args.join("/")),
		isAbsolute: vi.fn((p: string) => p.startsWith("/")),
		basename: vi.fn((p: string) => p.split("/").pop() || ""),
	}
})

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return {
		...actual,
		default: {
			...actual,
			homedir: vi.fn(() => "/home/user"),
		},
		homedir: vi.fn(() => "/home/user"),
	}
})

vi.mock("../fs", () => ({
	fileExistsAtPath: vi.fn(),
}))

vi.mock("../../core/config/ProviderSettingsManager", () => ({
	ProviderSettingsManager: vi.fn().mockImplementation(() => ({
		export: vi.fn().mockResolvedValue({
			apiConfigs: {},
			modeApiConfigs: {},
			currentApiConfigName: "default",
		}),
		import: vi.fn().mockResolvedValue({ success: true }),
		listConfig: vi.fn().mockResolvedValue([]),
	})),
}))

vi.mock("../../core/config/ContextProxy", () => ({
	ContextProxy: {
		getInstance: vi.fn(() => ({
			getValue: vi.fn(),
		})),
	},
}))

vi.mock("../../core/config/CustomModesManager", () => ({
	CustomModesManager: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../extension", () => ({}))

vi.mock("../logging/subsystems", () => ({
	configLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock("../../shared/package", () => ({
	Package: { name: "arkware" },
}))

vi.mock("../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

vi.mock("../../core/config/importExport", () => ({
	importSettingsFromPath: vi.fn().mockResolvedValue({ success: true }),
}))

import { autoImportSettings } from "../autoImportSettings"
import * as vscode from "vscode"
import fsPromises from "fs/promises"
import { fileExistsAtPath } from "../fs"
import { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"
import { ContextProxy } from "../../core/config/ContextProxy"
import { CustomModesManager } from "../../core/config/CustomModesManager"
import { importSettingsFromPath } from "../../core/config/importExport"

describe("autoImportSettings", () => {
	let mockOutputChannel: any
	let mockProviderSettingsManager: any
	let mockContextProxy: any
	let mockCustomModesManager: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}
		mockProviderSettingsManager = new (vi.mocked(ProviderSettingsManager) as any)()
		mockContextProxy = (vi.mocked(ContextProxy) as any).getInstance()
		mockCustomModesManager = (vi.mocked(CustomModesManager) as any).getInstance()
	})

	it("should skip when no settings path is configured", async () => {
		const getConfigMock = vi.mocked(vscode.workspace.getConfiguration)
		getConfigMock.mockReturnValue({
			get: vi.fn().mockReturnValue(""),
		} as any)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("No auto-import settings path specified"),
		)
	})

	it("should skip when settings file does not exist", async () => {
		const getConfigMock = vi.mocked(vscode.workspace.getConfiguration)
		getConfigMock.mockReturnValue({
			get: vi.fn().mockReturnValue("/some/path/to/settings.json"),
		} as any)
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Settings file not found"))
	})

	it("should import settings when file exists and contains valid JSON", async () => {
		const getConfigMock = vi.mocked(vscode.workspace.getConfiguration)
		getConfigMock.mockReturnValue({
			get: vi.fn().mockReturnValue("/some/path/to/settings.json"),
		} as any)
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(importSettingsFromPath).mockResolvedValue({ success: true } as any)

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(importSettingsFromPath).toHaveBeenCalled()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Successfully imported settings"),
		)
	})

	it("should show warning when import fails", async () => {
		const getConfigMock = vi.mocked(vscode.workspace.getConfiguration)
		getConfigMock.mockReturnValue({
			get: vi.fn().mockReturnValue("/some/path/to/settings.json"),
		} as any)
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(importSettingsFromPath).mockResolvedValue({ success: false, error: "Import failed" })

		await autoImportSettings(mockOutputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})

		expect(vscode.window.showWarningMessage).toHaveBeenCalled()
	})
})
