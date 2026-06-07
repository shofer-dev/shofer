/**
 * Agent Worker bootstrap — loads the full extension bundle in a worker_thread.
 *
 * This is the entry point for an Agent Worker. When spawned as a worker_thread
 * it receives `workerData` containing:
 *   - `taskId`        — the task this worker is running.
 *   - `cwd`           — the workspace directory.
 *   - `extensionPath` — path to the directory containing `dist/extension.js`.
 *   - `settings`      — snapshot of current settings at spawn time.
 *   - `serverPort`    — transferred `MessagePort` from the Server Worker's `MessageChannel`.
 *
 * The bootstrap:
 *   1. Intercepts `require("vscode")` to return the vscode-shim.
 *   2. Creates the vscode-shim with `parentPort` for IPC and `WorkerExtensionHost` for UI.
 *   3. Loads `dist/extension.js` via `require()`.
 *   4. Calls `activate(context)`.
 *
 * Phase 1: This module is compiled and import-tested, not spawned yet.
 * Zero production traffic flows through it.
 */

import { parentPort, workerData } from "worker_threads"
import { createRequire } from "module"
import path from "path"
import fs from "fs"

import { createVSCodeAPIMock } from "@shofer/vscode-shim"
import { isMainThread } from "worker_threads"
import { WorkerExtensionHost } from "./worker-extension-host.js"

/** Shape of `workerData` passed by the main thread when spawning this worker. */
export interface AgentWorkerData {
	/** Unique task ID for this worker. */
	taskId: string
	/** Workspace root directory. */
	cwd: string
	/** Path to the directory containing `dist/extension.js` (extension root). */
	extensionPath: string
	/** Snapshot of current settings at spawn time. */
	settings: Record<string, unknown>
}

/**
 * Result returned by `bootstrapAgentWorker()` after successful activation.
 */
export interface AgentWorkerBootstrapResult {
	/** The task ID from `workerData`. */
	taskId: string
	/** The `activate()` return value (the `ShoferAPI` control plane). */
	api: unknown
}

/**
 * Bootstrap the Agent Worker. Loads the extension bundle and calls `activate()`.
 *
 * In a real worker, `workerData` comes from the spawning thread. In tests,
 * it can be injected directly.
 *
 * @returns the task ID and the activated ShoferAPI.
 */
export async function bootstrapAgentWorker(data: AgentWorkerData): Promise<AgentWorkerBootstrapResult> {
	// ── Step 1: Wire the WorkerExtensionHost ──────────────────────────
	// In a real worker the serverPort is transferred via workerData.
	// In tests we accept a null/undefined serverPort (UI traffic is no-op'd).
	const serverPort = null // Will be a MessagePort transferred at spawn time (Phase 2).

	const extensionHost = new WorkerExtensionHost(
		serverPort ?? {
			postMessage: () => {},
			on: () => {},
		},
		parentPort,
	)

	// ── Step 2: Create the vscode-shim ──────────────────────────────────
	// parentPort is forwarded for IPC (vscode API calls → main thread).
	const vscode = createVSCodeAPIMock(data.extensionPath, data.cwd, undefined, {
		parentPort: parentPort ?? undefined,
		extensionHost,
	})

	// Set globals as the CLI does — required by the extension bundle.
	;(global as Record<string, unknown>).vscode = vscode
	;(global as Record<string, unknown>).__extensionHost = extensionHost

	// ── Step 3: Intercept require("vscode") ─────────────────────────────
	// Workers use CJS resolution; `Module._resolveFilename` works reliably
	// here unlike the ESM issues the CLI hit with tsx.
	const require_ = createRequire(import.meta.url)
	const Module = require_("module") as {
		_resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string
	}
	const originalResolve = Module._resolveFilename

	Module._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown) {
		if (request === "vscode") {
			// Return a path that forces Node to use the global mock.
			// We use a simple approach: write a minimal on-disk mock file
			// to the workspace's temp directory (same pattern as the CLI).
			const mockDir = path.join(data.cwd, ".shofer", "tmp")
			fs.mkdirSync(mockDir, { recursive: true })
			const mockFilePath = path.join(mockDir, "vscode-mock.js")
			if (!fs.existsSync(mockFilePath)) {
				fs.writeFileSync(
					mockFilePath,
					[
						`"use strict";`,
						`var g = globalThis;`,
						`if (!g.vscode) { throw new Error("global.vscode not set before vscode-mock load"); }`,
						`module.exports = g.vscode;`,
						``,
					].join("\n"),
					"utf-8",
				)
			}
			return mockFilePath
		}
		return originalResolve.call(Module, request, parent, isMain, options)
	}

	// ── Step 4: Load the extension bundle ──────────────────────────────
	const bundlePath = path.join(data.extensionPath, "dist", "extension.js")
	let extensionModule: { activate: (context: unknown) => Promise<unknown>; deactivate?: () => Promise<void> }

	try {
		extensionModule = require_(bundlePath) as typeof extensionModule
	} catch (error) {
		Module._resolveFilename = originalResolve
		throw new Error(
			`[agent-worker ${data.taskId}] Failed to load extension bundle: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	// Restore resolution immediately.
	Module._resolveFilename = originalResolve

	// ── Step 5: Activate ────────────────────────────────────────────────
	let api: unknown
	try {
		api = await extensionModule.activate(vscode.context)
	} catch (error) {
		throw new Error(
			`[agent-worker ${data.taskId}] Failed to activate extension: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	// ── Step 6: Mark webview ready ──────────────────────────────────────
	// This mirrors the CLI's `markWebviewReady()` which triggers the
	// `webviewDidLaunch` flow inside the extension.
	extensionHost.markWebviewReady()

	return { taskId: data.taskId, api }
}

/**
 * Auto-bootstrap when this module is loaded as a worker_thread entry point.
 * In tests this is skipped because `isMainThread` is true.
 */
if (!isMainThread && workerData) {
	bootstrapAgentWorker(workerData as AgentWorkerData).catch((err) => {
		console.error("[agent-worker] Bootstrap failed:", err)
	})
}
