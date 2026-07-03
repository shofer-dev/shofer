// npx vitest run src/task/__tests__/Task.sticky-profile-race.spec.ts

import { describe, it, expect, vi } from "vitest"

import type { ProviderSettings, TaskProviderLike } from "@shofer/types"
import { setHost, createInMemoryHost } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

// Task and its deps live in @shofer/core and call each other via intra-package
// RELATIVE imports, so a barrel `vi.mock("@shofer/core")` cannot intercept them.
// Stub Task's concrete relative-imported deps instead.

// Noop ignore controller so constructing a Task doesn't spin up the real file watcher.
vi.mock("../../ignore/ShoferIgnoreController.js", () => ({
	ShoferIgnoreController: class {
		validateAccess() {
			return true
		}
		validateCommand() {
			return undefined
		}
		filterPaths(paths: string[]) {
			return paths
		}
		getInstructions() {
			return undefined
		}
		async initialize() {}
		dispose() {}
	},
}))

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

import { Task } from "@shofer/core"

setHost(createInMemoryHost())
if (!TelemetryService.hasInstance()) {
	TelemetryService.createInstance([])
}

describe("Task - sticky provider profile init race", () => {
	it("does not overwrite task apiConfigName if set during async initialization", async () => {
		const apiConfig: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		} as any

		let resolveGetState: ((v: any) => void) | undefined
		const getStatePromise = new Promise((resolve) => {
			resolveGetState = resolve
		})

		const mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			getState: vi.fn().mockImplementation(() => getStatePromise),
			log: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as TaskProviderLike

		const task = new Task({
			provider: mockProvider as any,
			apiConfiguration: apiConfig,
			task: "test task",
			startTask: false,
		})

		// Simulate a profile switch happening before provider.getState resolves.
		task.setTaskApiConfigName("new-profile")

		resolveGetState?.({ currentApiConfigName: "old-profile" })
		await task.waitForApiConfigInitialization()

		expect(task.taskApiConfigName).toBe("new-profile")
	})

	it("seeds task mode and apiConfigName from initialMode/initialApiConfigName without consulting global state", async () => {
		const apiConfig: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		} as any

		const getState = vi.fn().mockResolvedValue({ currentApiConfigName: "global-profile", mode: "code" })

		const mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			getState,
			log: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as TaskProviderLike

		const task = new Task({
			provider: mockProvider as any,
			apiConfiguration: apiConfig,
			task: "test task",
			startTask: false,
			initialMode: "architect",
			initialApiConfigName: "my-profile",
		})

		await task.waitForApiConfigInitialization()

		expect(task.taskApiConfigName).toBe("my-profile")
		await expect(task.getTaskMode()).resolves.toBe("architect")
		// Explicit seeds must NOT fall back to the global defaults.
		expect(getState).not.toHaveBeenCalled()
	})
})
