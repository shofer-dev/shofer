// npx vitest src/core/webview/__tests__/diagnosticsHandler.spec.ts

import * as path from "path"

// Mock vscode first
vi.mock("vscode", () => {
	const showErrorMessage = vi.fn()
	const openTextDocument = vi.fn().mockResolvedValue({})
	const showTextDocument = vi.fn().mockResolvedValue(undefined)

	return {
		window: {
			showErrorMessage,
			showTextDocument,
		},
		workspace: {
			openTextDocument,
		},
	}
})

// Mock storage utilities
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(async () => "/mock/task-dir"),
}))

// Mock fs/promises (only writeFile is exercised directly; readApiMessages handles reads)
vi.mock("fs/promises", () => {
	const mockWriteFile = vi.fn().mockResolvedValue(undefined)
	return {
		default: { writeFile: mockWriteFile },
		writeFile: mockWriteFile,
	}
})

// Mock the JSONL API messages reader used by diagnosticsHandler.
const readApiMessagesMock = vi.fn()
vi.mock("../../task-persistence/apiMessages", () => ({
	readApiMessages: readApiMessagesMock,
}))

import * as vscode from "vscode"
import * as fs from "fs/promises"
import { generateErrorDiagnostics } from "../diagnosticsHandler"

describe("generateErrorDiagnostics", () => {
	const mockLog = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		readApiMessagesMock.mockReset()
	})

	it("generates a diagnostics file with error metadata and history", async () => {
		readApiMessagesMock.mockResolvedValue([{ role: "user", content: "test" }])

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.2.3",
				provider: "test-provider",
				model: "test-model",
				details: "Sample error details",
			},
			log: mockLog,
		})

		expect(result.success).toBe(true)
		expect(result.filePath).toContain("shofer-diagnostics-")

		expect(readApiMessagesMock).toHaveBeenCalledWith({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
		})

		expect(fs.writeFile).toHaveBeenCalledTimes(1)
		const [writtenPath, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0]
		expect(String(writtenPath)).toContain("shofer-diagnostics-test-tas")
		expect(String(writtenContent)).toContain(
			"// Please share this file with Shofer Support (support@shofer.dev) to diagnose the issue faster",
		)
		expect(String(writtenContent)).toContain('"error":')
		expect(String(writtenContent)).toContain('"history":')
		expect(String(writtenContent)).toContain('"version": "1.2.3"')

		expect(vscode.workspace.openTextDocument).toHaveBeenCalledTimes(1)
		expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1)
	})

	it("uses empty history when API history is empty", async () => {
		readApiMessagesMock.mockResolvedValue([])

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.0.0",
				provider: "test",
				model: "test",
				details: "error",
			},
			log: mockLog,
		})

		expect(result.success).toBe(true)
		const [, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0]
		expect(String(writtenContent)).toContain('"history": []')
	})

	it("uses default values when values are not provided", async () => {
		readApiMessagesMock.mockResolvedValue([])

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			log: mockLog,
		})

		expect(result.success).toBe(true)
		const [, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0]
		expect(String(writtenContent)).toContain('"version": ""')
		expect(String(writtenContent)).toContain('"provider": ""')
		expect(String(writtenContent)).toContain('"model": ""')
		expect(String(writtenContent)).toContain('"details": ""')
	})

	it("handles a read error gracefully by surfacing a UI error and producing empty history", async () => {
		readApiMessagesMock.mockRejectedValue(new Error("boom"))

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.0.0",
				provider: "test",
				model: "test",
				details: "error",
			},
			log: mockLog,
		})

		expect(result.success).toBe(true)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to read api_conversation_history.jsonl")
		const [, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0]
		expect(String(writtenContent)).toContain('"history": []')
	})

	it("returns error result when file write fails", async () => {
		readApiMessagesMock.mockResolvedValue([])
		vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error("Write failed"))

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			log: mockLog,
		})

		expect(result.success).toBe(false)
		expect(result.error).toBe("Write failed")
		expect(mockLog).toHaveBeenCalledWith("Error generating diagnostics: Write failed")
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to generate diagnostics: Write failed")
	})
})

// Silence unused-import warning for `path` if any future test wants it.
void path
