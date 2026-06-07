/**
 * Workflow conformance integration test (test_workflows.md scenarios).
 *
 * Discovers every `_`-prefixed `.slang` workflow, runs each one against the
 * configured provider via ShoferAPI/ExtensionHost, auto-answers human
 * escalations / `ask_followup_question` asks from a per-flow canned-reply
 * queue, and asserts the expected `flowState.status` persisted in history.
 *
 * Child tasks spawned by each workflow are tracked live (via TaskSpawned
 * events) and their output is collected alongside the root workflow's messages.
 * The full transcript (root + each child) is printed on failure so regressions
 * can be diagnosed without a debugger.
 *
 * ## Mock-provider compatibility
 *
 * The Slang interpreter drives all flow control (commit, converge, budget,
 * deadlock) in TypeScript — the LLM subtasks only call `attempt_completion`.
 * The mock's built-in scenario table handles every stake, including structured
 * JSON output contracts, multi-turn `ask_followup_question`, and peer messaging.
 *
 * NOTE: the harness has only been validated against single-task flows so far.
 * Multi-agent WorkflowTask orchestration (spawned background agent tasks
 * reaching a terminal lifecycle) is not yet wired through the harness — those
 * flows currently hang. Gated behind SHOFER_INTEGRATION=1 in test_cli.sh.
 *
 * Run from extensions/shofer/apps/cli:
 *   pnpm --filter @shofer/cli exec tsx scripts/integration/cases/workflow-conformance.ts
 *
 * Environment variables:
 *   PROVIDER      provider name    (default: "mock" — hermetic, no network)
 *   API_KEY       api key          (default: "x" — mock ignores it)
 *   BASE_URL      llm-router base  (only relevant when PROVIDER != mock)
 *   MODEL         model id         (default: "mock-model")
 *   WORKSPACE     workspace path   (default: monorepo root)
 *   MATCH         run only flows whose name contains this substring
 *   TIMEOUT_MS    per-flow timeout (default: 180000)
 */

import fs from "node:fs/promises"
import path from "path"
import { fileURLToPath } from "url"

import { createApiHarness } from "../lib/api-harness.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Write a line to real stdout — the host monkey-patches `console.*`. */
const out = (line: string) => process.stdout.write(line + "\n")

// ─────────────────────────────────────────────────────────────────────────────
// Expectation matrix (mirrors test_workflows.md)
// ─────────────────────────────────────────────────────────────────────────────

type FlowStatus = "converged" | "budget_exceeded" | "deadlock" | "error"

interface FlowExpectation {
	/** Flow params passed to createWorkflow. */
	params: Record<string, unknown>
	/** Expected terminal flowState.status. */
	expected: FlowStatus
	/**
	 * FIFO canned replies for any `followup` ask (escalate @Human,
	 * await <- @Human, agent ask_followup_question relayed from a child task).
	 */
	humanReplies?: string[]
}

const EXPECTATIONS: Record<string, FlowExpectation> = {
	"_await-any": { params: { topic: "test" }, expected: "converged" },
	"_await-human": { params: { topic: "test" }, expected: "converged", humanReplies: ["ACK"] },
	"_budget-rounds": { params: { task: "test" }, expected: "budget_exceeded" },
	"_budget-tokens": { params: { task: "test" }, expected: "budget_exceeded" },
	"_commit-if": { params: { flag: true }, expected: "converged" },
	"_converge-agent": { params: { task: "test" }, expected: "converged" },
	"_converge-all": { params: { task: "test" }, expected: "converged" },
	"_converge-count": { params: { task: "test" }, expected: "converged" },
	_deadlock: { params: { topic: "test" }, expected: "deadlock" },
	"_escalate-if": { params: { limit: 10 }, expected: "converged", humanReplies: ["OK"] },
	"_escalate-only": { params: { question: "What is your name?" }, expected: "converged", humanReplies: ["Tester"] },
	_expressions: { params: { val: 5, text: "ok" }, expected: "converged" },
	"_if-condition": { params: { flag: true }, expected: "converged" },
	"_let-set": { params: { initial_count: 0 }, expected: "converged" },
	"_list-arg": { params: { topic: "t", query: "q" }, expected: "converged" },
	"_named-args": { params: { topic: "t", num_value: 5 }, expected: "converged" },
	// Mock returns JSON matching the output contract ("- summary: string" built-in scenario).
	"_output-schema": { params: { topic: "test" }, expected: "converged" },
	// Mock skips send_message_to_task (optional per the role) and completes
	// directly — flow still converges via the mailbox path.
	"_peer-messaging": { params: { topic: "Rust" }, expected: "converged" },
	// Mock emits ask_followup_question on the Researcher task; the harness
	// auto-answers from humanReplies, then the mock emits attempt_completion.
	"_question-relay": { params: { topic: "Rust" }, expected: "converged", humanReplies: ["Focus on basics"] },
	"_repeat-until": { params: { topic: "test" }, expected: "converged" },
	"_stake-all": { params: { message: "hello" }, expected: "converged" },
	"_tools-meta": { params: { topic: "test" }, expected: "converged" },
	"_when-otherwise": { params: { text: "DONE" }, expected: "converged" },
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format the per-message text for one task into a compact transcript block.
 * Only `say:text` messages are printed; other say/ask types are annotated.
 */
function formatTranscript(
	taskId: string,
	messages: { type?: string; say?: string; ask?: string; text?: string }[],
): string {
	if (messages.length === 0) return `  [${taskId}] (no messages)\n`
	const lines = [`  [${taskId}]`]
	for (const m of messages) {
		if (m.type === "say" && m.say === "text") {
			lines.push(`    · ${(m.text ?? "").slice(0, 200)}`)
		} else {
			lines.push(`    <${m.type}:${m.say ?? m.ask ?? "?"}> ${(m.text ?? "").slice(0, 80)}`)
		}
	}
	return lines.join("\n") + "\n"
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const provider = process.env.PROVIDER ?? "mock"
	const apiKey = process.env.API_KEY ?? "x"
	const baseUrl = process.env.BASE_URL ?? "http://localhost:30081/v1"
	const model = process.env.MODEL ?? "mock-model"
	const workspace = process.env.WORKSPACE ?? path.resolve(__dirname, "../../../../../..")
	const matchFilter = process.env.MATCH
	const timeoutMs = Number(process.env.TIMEOUT_MS ?? 180_000)

	out(`[workflow-conformance] provider=${provider} model=${model} workspace=${workspace}`)

	const harness = await createApiHarness({ provider, apiKey, baseUrl, model, workspacePath: workspace })
	const api = harness.host.api

	// Load conformance fixtures from the co-located fixtures/ directory.
	// These are test-only flows and live with the harness, not in the workspace.
	const fixturesDir = path.resolve(__dirname, "../fixtures")
	const allFlows = new Map<string, string>()
	for (const entry of await fs.readdir(fixturesDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".slang") && entry.name.startsWith("_")) {
			const source = await fs.readFile(path.join(fixturesDir, entry.name), "utf-8")
			allFlows.set(entry.name.replace(/\.slang$/, ""), source)
		}
	}
	let names = [...allFlows.keys()].sort()

	if (matchFilter) {
		names = names.filter((n) => n.includes(matchFilter))
	}

	out(
		`[workflow-conformance] discovered ${names.length} _-prefixed workflows${matchFilter ? ` (filter: "${matchFilter}")` : ""}`,
	)

	type Result = {
		name: string
		ok: boolean
		got: string
		want: string
		childCount: number
		durationMs: number
		failureTranscript?: string
	}

	const results: Result[] = []

	for (const name of names) {
		const exp = EXPECTATIONS[name]

		if (!exp) {
			out(`[workflow-conformance] SKIP ${name} — no expectation registered`)
			results.push({ name, ok: false, got: "NO_EXPECTATION", want: "?", childCount: 0, durationMs: 0 })
			continue
		}

		const source = allFlows.get(name)!
		out(`\n[workflow-conformance] ▶ ${name}  params=${JSON.stringify(exp.params)}`)

		// taskIdRef is a mutable box so traceFor() can be called before the
		// createWorkflow promise resolves (which is the required usage order).
		const taskIdRef: { taskId: string | undefined } = { taskId: undefined }
		const trace = harness.traceFor(taskIdRef, exp.humanReplies)

		const startMs = Date.now()

		try {
			taskIdRef.taskId = await api.createWorkflow(source, exp.params)
			await trace.waitForCompletion(timeoutMs)
		} catch (e) {
			const durationMs = Date.now() - startMs
			const msg = e instanceof Error ? e.message : String(e)
			out(`[workflow-conformance] ✗ ${name}: ${msg}`)
			results.push({ name, ok: false, got: "TIMEOUT", want: exp.expected, childCount: 0, durationMs })
			continue
		}

		const durationMs = Date.now() - startMs

		// Read the authoritative terminal status from persisted flowState.
		// flowState.status is set by WorkflowTask.getHistoryExtension() and
		// persisted before the TaskCompleted event fires.
		const item = trace.historyItem()
		const status = (item?.flowState as { status?: string } | undefined)?.status ?? "UNKNOWN"
		const ok = status === exp.expected
		const childCount = trace.childIds.size

		out(
			`[workflow-conformance] ${ok ? "✅" : "✗"} ${name}: status=${status} want=${exp.expected} children=${childCount} (${durationMs}ms)`,
		)

		let failureTranscript: string | undefined
		if (!ok) {
			// Build a transcript of root + all direct children for diagnosis.
			const parts: string[] = [`\n  ── ${name} transcript ──`]
			parts.push(formatTranscript(trace.taskId, trace.rootMessages()))
			for (const childId of trace.childIds) {
				parts.push(formatTranscript(childId, trace.childMessages(childId)))
			}
			// Also fetch the markdown export for the root task.
			try {
				const md = await trace.getMarkdown()
				parts.push(`  ── root markdown export (${md.length} chars) ──\n${md.slice(0, 2000)}`)
			} catch {
				// export may fail if the task was not persisted cleanly
			}
			failureTranscript = parts.join("\n")
			out(failureTranscript)
		}

		results.push({ name, ok, got: status, want: exp.expected, childCount, durationMs, failureTranscript })
	}

	await harness.dispose()

	// ── Summary ────────────────────────────────────────────────────────────────
	const passed = results.filter((r) => r.ok).length
	const failed = results.filter((r) => !r.ok).length
	const skipped = results.filter((r) => r.got === "NO_EXPECTATION").length

	out(`\n═══ Workflow conformance: ${passed}/${results.length} passed ═══`)
	out(`    passed=${passed}  failed=${failed}  skipped=${skipped}`)

	for (const r of results) {
		const icon = r.ok ? "✅" : r.got === "NO_EXPECTATION" ? "⚠️ " : "✗ "
		out(`  ${icon} ${r.name.padEnd(20)} got=${r.got.padEnd(16)} want=${r.want.padEnd(16)} children=${r.childCount}`)
	}

	// Non-zero exit when any non-skipped test failed.
	if (failed > skipped) {
		process.exit(1)
	}
}

main().catch((err) => {
	process.stderr.write(`[workflow-conformance] fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
	process.exit(1)
})
