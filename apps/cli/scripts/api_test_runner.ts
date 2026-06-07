/**
 * ShoferAPI library functional tests (test_cli.md scenarios 15-19).
 *
 * Exercises the in-process ShoferAPI surface against the hermetic `mock`
 * provider — no real LLM, no network. Each scenario relies on the mock's
 * built-in substring matches (API_OK, TASK_ONE, EXPORT_TEST, …) so the agent
 * loop runs to a real `attempt_completion`.
 *
 * Emits one `Test NN: PASS|FAIL` line per scenario and a final `DONE`, so the
 * functional shell suite (todos/cli-tests/test_cli.sh) can parse the result.
 *
 * Run: pnpm --filter @shofer/cli exec tsx scripts/api_test_runner.ts
 */

import { fileURLToPath } from "url"
import path from "path"

import { ShoferEventName } from "@shofer/types"

import { ExtensionHost } from "../src/agent/extension-host.js"
import { getDefaultExtensionPath } from "../src/lib/utils/extension.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extPath = path.resolve(getDefaultExtensionPath(__dirname))

/**
 * Write a line directly to the real stdout stream.
 *
 * `ExtensionHost.activate()` monkey-patches `console.*` to route extension
 * chatter into its output manager, and only restores it in `dispose()`. Any
 * `console.log` issued between those points is swallowed, so the
 * shell-suite-parsed `Test NN: PASS|FAIL` markers MUST bypass `console` and go
 * straight to the underlying stream (which the host does not intercept).
 */
function out(line: string): void {
	process.stdout.write(line + "\n")
}

async function main() {
	const host = new ExtensionHost({
		mode: "code",
		provider: "mock",
		apiKey: "mock",
		model: "mock-model",
		workspacePath: process.cwd(),
		extensionPath: extPath,
		user: null,
		ephemeral: false,
		debug: false,
		exitOnComplete: true,
		nonInteractive: true,
		disableOutput: false,
	})
	await host.activate()
	const api = host.api

	// Capture the authoritative completion signal. `TaskManager.setState`
	// persists `HistoryItem.taskState` through a fire-and-forget async chain
	// that is silently dropped when the history item is not yet on disk (the
	// case for ultra-fast mock tasks), so the persisted lifecycle is lossy. The
	// ShoferAPI `TaskCompleted` event — the same signal `waitForTaskCompletion`
	// resolves on — is the reliable indicator that a top-level task completed.
	const completedTaskIds = new Set<string>()
	api.on(
		ShoferEventName.TaskCompleted,
		(id: string, _tok: unknown, _tools: unknown, info: { isSubtask?: boolean } | undefined) => {
			if (!info?.isSubtask) {
				completedTaskIds.add(id)
			}
		},
	)

	// Test 15: start a task and confirm it reaches the completed lifecycle and
	// lands in history.
	const tid = await api.startNewTask({ text: "Reply with exactly: API_OK", configuration: {} })
	await host.waitForTaskCompletion()
	const inHistory15 = api.getTaskHistoryItems().some((x) => x.id === tid)
	out("Test 15: " + (completedTaskIds.has(tid) && inHistory15 ? "PASS" : "FAIL"))

	// Test 16: two sequential tasks land in history and are deletable.
	const id1 = await api.startNewTask({ text: "Reply with: TASK_ONE" })
	await host.waitForTaskCompletion()
	const id2 = await api.startNewTask({ text: "Reply with: TASK_TWO" })
	await host.waitForTaskCompletion()
	const id1InHistory = await api.isTaskInHistory(id1)
	const countBeforeDelete = api.getTaskHistoryItems().length
	await api.deleteTask(id1)
	await api.deleteTask(id2)
	out("Test 16: " + (id1InHistory && countBeforeDelete >= 2 ? "PASS" : "FAIL"))

	// Test 17: markdown + JSON export of a completed task. The JSON export is a
	// task summary (taskId, calls, token/cost totals) — verify both surfaces
	// return non-empty content per test_cli.md scenario 17.
	const etid = await api.startNewTask({ text: "Reply with: EXPORT_TEST" })
	await host.waitForTaskCompletion()
	const md = await api.getTaskMarkdownExport(etid)
	const je = await api.getTaskJsonExport(etid)
	out("Test 17: " + (md.length > 0 && je && Object.keys(je).length > 0 ? "PASS" : "FAIL"))

	// Test 18: configuration export/import round-trip.
	const orig = api.getConfiguration()
	const exp = api.exportConfiguration()
	await api.importConfiguration(exp)
	const rest = api.getConfiguration()
	out("Test 18: " + (orig.apiProvider === rest.apiProvider ? "PASS" : "FAIL"))

	// Test 19: profile create + delete.
	const pn = "test-profile-" + Date.now()
	await api.createProfile(pn, { apiProvider: "mock", apiModelId: "mock-model" })
	const created = api.getProfiles().includes(pn)
	await api.deleteProfile(pn)
	const deleted = !api.getProfiles().includes(pn)
	out("Test 19: " + (created && deleted ? "PASS" : "FAIL"))

	await host.dispose()
	out("DONE")
}

main()
	.then(() => {
		// The embedded extension host leaves lingering handles (timers, IPC,
		// watchers) that keep the Node event loop alive even after dispose(),
		// so force a clean exit once all scenarios have reported.
		process.exit(0)
	})
	.catch((e) => {
		console.error(e)
		process.exit(1)
	})
