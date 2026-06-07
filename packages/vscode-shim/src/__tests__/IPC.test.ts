/**
 * Unit tests for the IPC interface and vscode API forwarding (Phase 0).
 *
 * These tests verify that:
 * 1. WindowAPI with an IpcDemuxer dispatches expected IPC messages.
 * 2. WindowAPI without IpcDemuxer preserves the existing mock behavior.
 * 3. CommandsAPI with an IpcDemuxer forwards unknown commands through IPC.
 * 4. CommandsAPI without IpcDemuxer preserves the existing mock behavior.
 * 5. IpcDemuxer correctly routes responses by requestId (round-trip tests).
 * 6. Cross-API delivery does NOT produce spurious warnings (shared-port fix).
 * 7. Timeout enforcement cleans up pending entries.
 */

import { describe, it, expect, vi } from "vitest"
import { WindowAPI } from "../api/WindowAPI.js"
import { CommandsAPI } from "../api/CommandsAPI.js"
import { Uri } from "../classes/Uri.js"
import {
	IpcDemuxer,
	generateRequestId,
	isVscodeApiResponse,
	VSCODE_API_IPC_TYPE,
	VSCODE_API_RESULT_TYPE,
} from "../interfaces/ipc.js"
import type { IpcPort, VscodeApiRequest, VscodeApiResponse } from "../interfaces/ipc.js"

/**
 * Creates a mock IpcPort for testing IPC message capture.
 * The returned `simulateResponse` closes the round-trip.
 */
function createMockPort(): {
	port: IpcPort
	getSentMessages: () => unknown[]
	simulateResponse: (requestId: string, result?: unknown, error?: string) => void
	/** Resolve all pending fire-and-forget dispatches with a generic response. */
	settleAll: () => void
} {
	const sentMessages: unknown[] = []
	const listeners: Array<(msg: unknown) => void> = []
	const port: IpcPort = {
		postMessage(value: unknown): void {
			sentMessages.push(value)
		},
		on(_event: "message", listener: (value: unknown) => void): void {
			listeners.push(listener)
		},
	}

	const simulateResponse = (requestId: string, result?: unknown, error?: string) => {
		const response: VscodeApiResponse = { type: VSCODE_API_RESULT_TYPE, requestId, result, error }
		for (const listener of listeners) {
			listener(response)
		}
	}

	const settleAll = () => {
		for (const msg of sentMessages) {
			const req = msg as VscodeApiRequest
			if (req.type === VSCODE_API_IPC_TYPE && typeof req.requestId === "string") {
				simulateResponse(req.requestId, { _settled: true })
			}
		}
	}

	return { port, getSentMessages: () => sentMessages, simulateResponse, settleAll }
}

/**
 * Creates a fresh mock+demuxer pair. Caller MUST call mock.settleAll() before
 * demuxer.dispose() if there are unanswered fire-and-forget requests.
 */
function freshPair() {
	const mock = createMockPort()
	const demuxer = new IpcDemuxer(mock.port)
	return { mock, demuxer }
}

describe("Phase 0: IPC Forwarding", () => {
	describe("IPC message types", () => {
		it("should generate unique request IDs", () => {
			const id1 = generateRequestId()
			const id2 = generateRequestId()
			expect(id1).not.toBe(id2)
			expect(id1).toMatch(/^vscode-api-\d+-\d+$/)
		})

		it("isVscodeApiResponse should detect valid responses", () => {
			expect(isVscodeApiResponse({ type: VSCODE_API_RESULT_TYPE, requestId: "abc", result: "ok" })).toBe(true)
		})

		it("isVscodeApiResponse should reject invalid responses", () => {
			expect(isVscodeApiResponse(null)).toBe(false)
			expect(isVscodeApiResponse({})).toBe(false)
			expect(isVscodeApiResponse({ type: "wrong" })).toBe(false)
			expect(isVscodeApiResponse("string")).toBe(false)
		})
	})

	describe("IpcDemuxer", () => {
		it("should dispatch a request through the port", () => {
			const { mock, demuxer } = freshPair()
			demuxer.dispatchRequest("testMethod", ["arg1"])
			const messages = mock.getSentMessages()
			expect(messages.length).toBe(1)
			const msg = messages[0] as VscodeApiRequest
			expect(msg.type).toBe(VSCODE_API_IPC_TYPE)
			expect(msg.method).toBe("testMethod")
			expect(msg.args).toEqual(["arg1"])
			expect(msg.requestId).toBeDefined()
			mock.settleAll()
			demuxer.dispose()
		})

		it("should resolve when response arrives", async () => {
			const { mock, demuxer } = freshPair()
			const promise = demuxer.dispatchRequest("testMethod", ["arg1"])
			const requestId = (mock.getSentMessages()[0] as VscodeApiRequest).requestId
			mock.simulateResponse(requestId, { success: true })
			const result = await promise
			expect(result).toEqual({ success: true })
			demuxer.dispose()
		})

		it("should reject when response carries an error", async () => {
			const { mock, demuxer } = freshPair()
			const promise = demuxer.dispatchRequest("testMethod", ["arg1"])
			const requestId = (mock.getSentMessages()[0] as VscodeApiRequest).requestId
			mock.simulateResponse(requestId, undefined, "Something failed")
			await expect(promise).rejects.toThrow("Something failed")
			demuxer.dispose()
		})

		it("should reject on timeout", async () => {
			const shortPort = createMockPort()
			const shortDemuxer = new IpcDemuxer(shortPort.port, 50)
			const promise = shortDemuxer.dispatchRequest("slowMethod", [])
			await expect(promise).rejects.toThrow(/timed out after 50ms/)
			shortDemuxer.dispose()
		})

		it("should track pending count", () => {
			const { mock: _mock, demuxer } = freshPair()
			expect(demuxer.pendingCount).toBe(0)
			demuxer.dispatchRequest("m1", [])
			expect(demuxer.pendingCount).toBe(1)
			demuxer.dispatchRequest("m2", [])
			expect(demuxer.pendingCount).toBe(2)
			_mock.settleAll()
			demuxer.dispose()
		})

		it("should clean up pending count after response", async () => {
			const { mock, demuxer } = freshPair()
			demuxer.dispatchRequest("m1", [])
			expect(demuxer.pendingCount).toBe(1)
			const requestId = (mock.getSentMessages()[0] as VscodeApiRequest).requestId
			mock.simulateResponse(requestId, "ok")
			expect(demuxer.pendingCount).toBe(0)
			demuxer.dispose()
		})

		it("should dispose pending requests", async () => {
			const { mock: _mock, demuxer } = freshPair()
			const promise = demuxer.dispatchRequest("m1", [])
			expect(demuxer.pendingCount).toBe(1)
			demuxer.dispose()
			expect(demuxer.pendingCount).toBe(0)
			await expect(promise).rejects.toThrow("IpcDemuxer disposed")
		})

		it("should NOT warn on cross-API delivery (unknown requestId)", () => {
			const { mock, demuxer } = freshPair()
			expect(() => mock.simulateResponse("non-existent-id", "unexpected")).not.toThrow()
			expect(demuxer.pendingCount).toBe(0)
			demuxer.dispose()
		})
	})

	describe("WindowAPI IPC forwarding", () => {
		it("should not have parentPort without a demuxer", () => {
			expect(new WindowAPI().hasParentPort).toBe(false)
		})

		it("should have parentPort with a demuxer", () => {
			const { demuxer } = freshPair()
			expect(new WindowAPI(demuxer).hasParentPort).toBe(true)
			demuxer.dispose()
		})

		it("createTerminal dispatches IPC request when demuxer is wired", () => {
			const { mock, demuxer } = freshPair()
			const window = new WindowAPI(demuxer)
			window.createTerminal({ name: "TestTerminal" })

			const messages = mock.getSentMessages()
			expect(messages.length).toBe(1)
			const msg = messages[0] as VscodeApiRequest
			expect(msg.type).toBe(VSCODE_API_IPC_TYPE)
			expect(msg.method).toBe("createTerminal")
			expect(msg.args).toEqual([{ name: "TestTerminal" }])

			mock.settleAll()
			demuxer.dispose()
		})

		it("createTerminal returns mock terminal alongside IPC dispatch", () => {
			const { mock, demuxer } = freshPair()
			const window = new WindowAPI(demuxer)
			const terminal = window.createTerminal({ name: "TestTerminal" })
			expect(terminal.name).toBe("TestTerminal")
			expect(typeof terminal.sendText).toBe("function")
			expect(mock.getSentMessages().length).toBe(1)

			mock.settleAll()
			demuxer.dispose()
		})

		it("createTerminal uses mock behavior without demuxer", () => {
			const terminal = new WindowAPI().createTerminal({ name: "TestTerminal" })
			expect(terminal.name).toBe("TestTerminal")
		})

		it("showTextDocument dispatches through IPC when demuxer is wired", () => {
			const { mock, demuxer } = freshPair()
			const window = new WindowAPI(demuxer)
			window.showTextDocument(Uri.file("/test/file.txt"))
			expect(mock.getSentMessages().length).toBe(1)

			mock.settleAll()
			demuxer.dispose()
		})

		it("IPC response clears pending count", async () => {
			const { mock, demuxer } = freshPair()
			const window = new WindowAPI(demuxer)
			window.createTerminal({ name: "Test" })

			expect(demuxer.pendingCount).toBe(1)
			const requestId = (mock.getSentMessages()[0] as VscodeApiRequest).requestId
			mock.simulateResponse(requestId, { terminalId: "t1" })
			expect(demuxer.pendingCount).toBe(0)

			demuxer.dispose()
		})
	})

	describe("CommandsAPI IPC forwarding", () => {
		it("should not have parentPort without a demuxer", () => {
			expect(new CommandsAPI().hasParentPort).toBe(false)
		})

		it("should have parentPort with a demuxer", () => {
			const { demuxer } = freshPair()
			expect(new CommandsAPI(demuxer).hasParentPort).toBe(true)
			demuxer.dispose()
		})

		it("registered commands run locally even with demuxer", async () => {
			const { mock, demuxer } = freshPair()
			const commands = new CommandsAPI(demuxer)
			const callback = vi.fn().mockReturnValue("local-result")
			commands.registerCommand("test.local", callback)

			const result = await commands.executeCommand("test.local", "arg1")
			expect(result).toBe("local-result")
			expect(callback).toHaveBeenCalledWith("arg1")
			expect(mock.getSentMessages().length).toBe(0)

			demuxer.dispose()
		})

		it("unknown commands dispatch through IPC when demuxer is wired", async () => {
			const { mock, demuxer } = freshPair()
			const commands = new CommandsAPI(demuxer)

			const promise = commands.executeCommand("unknown.command", "arg1", "arg2")
			const messages = mock.getSentMessages()
			expect(messages.length).toBe(1)
			const msg = messages[0] as VscodeApiRequest
			expect(msg.type).toBe(VSCODE_API_IPC_TYPE)
			expect(msg.method).toBe("executeCommand")
			expect(msg.args).toEqual(["unknown.command", "arg1", "arg2"])

			mock.simulateResponse(msg.requestId, "remote-result")
			expect(await promise).toBe("remote-result")
			demuxer.dispose()
		})

		it("unknown commands use built-in handling without demuxer", async () => {
			expect(await new CommandsAPI().executeCommand("workbench.action.files.saveFiles")).toBeUndefined()
		})
	})

	describe("Cross-API shared-port safety", () => {
		it("WindowAPI and CommandsAPI share one demuxer without spurious warnings", () => {
			const { mock, demuxer } = freshPair()
			const window = new WindowAPI(demuxer)
			const commands = new CommandsAPI(demuxer)

			window.createTerminal({ name: "T" })
			commands.executeCommand("cmd.x")

			expect(mock.getSentMessages().length).toBe(2)
			mock.settleAll()
			demuxer.dispose()
		})
	})

	describe("Backward compatibility (no demuxer)", () => {
		it("WindowAPI.createTerminal behaves identically without demuxer", () => {
			const terminal = new WindowAPI().createTerminal({ name: "MyTerminal" })
			expect(terminal.name).toBe("MyTerminal")
			expect(terminal.processId).toBeInstanceOf(Promise)
		})

		it("CommandsAPI handles built-in commands without demuxer", async () => {
			expect(await new CommandsAPI().executeCommand("workbench.action.closeWindow")).toBeUndefined()
		})

		it("CommandsAPI returns undefined for unknown commands without demuxer", async () => {
			expect(await new CommandsAPI().executeCommand("totally.unknown.command")).toBeUndefined()
		})
	})
})
