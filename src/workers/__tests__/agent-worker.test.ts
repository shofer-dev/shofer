/**
 * Unit tests for Agent Worker bootstrap (Phase 1).
 *
 * Phase 1 scope: the agent-worker module is compiled and import-tested,
 * not spawned as an actual worker_thread yet. These tests verify:
 * 1. The AgentWorkerData and AgentWorkerBootstrapResult type shapes.
 * 2. Module type-check (compile-time verification).
 *
 * Full module import (which requires @shofer/vscode-shim, tiktoken,
 * tree-sitter WASM, and the extension bundle) is not attempted —
 * that belongs in Phase 2 integration tests.
 */

import { describe, it, expect } from "vitest"
import type { AgentWorkerData, AgentWorkerBootstrapResult } from "../agent-worker.js"

describe("Agent Worker", () => {
	describe("AgentWorkerData type", () => {
		it("accepts valid worker data", () => {
			const data: AgentWorkerData = {
				taskId: "task-123",
				cwd: "/workspace",
				extensionPath: "/path/to/extension",
				settings: { mode: "code" },
			}
			expect(data.taskId).toBe("task-123")
			expect(data.cwd).toBe("/workspace")
			expect(data.extensionPath).toBe("/path/to/extension")
			expect(data.settings.mode).toBe("code")
		})

		it("accepts empty settings", () => {
			const data: AgentWorkerData = {
				taskId: "task-empty",
				cwd: "/workspace",
				extensionPath: "/path/to/extension",
				settings: {},
			}
			expect(data.settings).toEqual({})
		})
	})

	describe("AgentWorkerBootstrapResult type", () => {
		it("has expected shape", () => {
			const result: AgentWorkerBootstrapResult = {
				taskId: "task-1",
				api: { someMethod: () => {} },
			}
			expect(result.taskId).toBe("task-1")
			expect(result.api).toBeDefined()
		})
	})
})
