// TaskObserver end-to-end against scripted seams: the trigger policy, a pass fanning
// out over the enabled detectors (pilot first), the gate wiring, "say it to both"
// delivery (notify + marker with the SAME words), the turn-end report reaching the
// user only, adjudication → suppression, and budget exhaustion degrading to silence.

import type { PluginStorage } from "@shofer/types"

import { FEEDBACK_TOOL_NAME, type DetectorDef, type Observation, type TokenUsage } from "../src/types.js"
import type { ChatMessage, ForkChatResult, ForkClient } from "../src/llm.js"
import type { ToolDispatcher } from "../src/tool-executor.js"
import { LedgerStore } from "../src/ledger.js"
import { TaskObserver, type DeliverySeams, type ObserverTunables } from "../src/task-observer.js"

const T0 = 1_700_000_000_000

class MemoryStorage implements PluginStorage {
	files = new Map<string, string>()
	readonly dir = "/mem"
	async readFile(p: string): Promise<string> {
		const c = this.files.get(p)
		if (c === undefined) throw new Error("ENOENT")
		return c
	}
	async writeFile(p: string, content: string): Promise<void> {
		this.files.set(p, content)
	}
	async exists(p: string): Promise<boolean> {
		return this.files.has(p)
	}
	async delete(p: string): Promise<void> {
		this.files.delete(p)
	}
	async list(prefix?: string): Promise<string[]> {
		return [...this.files.keys()]
			.filter((f) => !prefix || f.startsWith(`${prefix}/`))
			.map((f) => (prefix ? f.slice(prefix.length + 1) : f))
	}
}

function detectors(overrides: Partial<Record<string, Partial<DetectorDef>>> = {}): DetectorDef[] {
	const base: DetectorDef[] = [
		{
			slug: "repeat-failure",
			enabled: true,
			system: "loop watcher",
			tools: [],
			exec: [],
			cadenceNth: 1,
			confidenceFloor: 0.6,
			deadlineS: 0,
			pilot: true,
			structural: false,
		},
		{
			slug: "standard-questions",
			enabled: true,
			system: "checklist",
			tools: [],
			exec: [],
			cadenceNth: 1,
			confidenceFloor: 0.6,
			deadlineS: 0,
			pilot: false,
			structural: false,
		},
	]
	return base.map((d) => ({ ...d, ...(overrides[d.slug] ?? {}) }))
}

interface Script {
	/** detector slug (matched against the tail) → the scripted reply */
	bySlug: Record<string, ForkChatResult>
}

function scriptedClient(
	script: Script,
): ForkClient & { calls: { slug: string; messages: ChatMessage[]; systemPrompt: string; tools: string[] }[] } {
	const calls: { slug: string; messages: ChatMessage[]; systemPrompt: string; tools: string[] }[] = []
	return {
		calls,
		async chat(opts) {
			const text = opts.messages
				.map((m) =>
					typeof m.content === "string"
						? m.content
						: m.content.map((b) => ("text" in b ? b.text : "")).join("\n"),
				)
				.join("\n")
			const slug = Object.keys(script.bySlug).find((s) => text.includes(`"${s}" detector`)) ?? "?"
			calls.push({
				slug,
				messages: opts.messages,
				systemPrompt: opts.systemPrompt,
				tools: opts.tools.map((t) => t.function.name),
			})
			return (
				script.bySlug[slug] ?? {
					text: "",
					toolCalls: [{ id: "f", name: FEEDBACK_TOOL_NAME, arguments: '{"verdict":"silent"}' }],
					tokens: usage(5, 2),
					costUsd: 0,
				}
			)
		},
	}
}

function usage(prompt: number, completion: number, cacheRead = 0, cacheWrite = 0): TokenUsage {
	return { prompt, completion, cacheRead, cacheWrite }
}

const silentReply: ForkChatResult = {
	text: "",
	toolCalls: [{ id: "f", name: FEEDBACK_TOOL_NAME, arguments: '{"verdict":"silent"}' }],
	tokens: usage(5, 2),
	costUsd: 0.0001,
}

function adviseReply(args: Record<string, unknown> = {}): ForkChatResult {
	return {
		text: "",
		toolCalls: [
			{
				id: "f",
				name: FEEDBACK_TOOL_NAME,
				arguments: JSON.stringify({
					verdict: "advise",
					headline: "No test run observed since the first edit",
					body: "Three edits, no test command.",
					evidence: ["write_to_file services/foo/health.go"],
					confidence: 0.8,
					...args,
				}),
			},
		],
		tokens: usage(5, 3),
		costUsd: 0.0002,
	}
}

interface Harness {
	debug: { taskId: string; pass: number; name: string; content: string }[]
	observer: TaskObserver
	notifies: string[]
	queues: string[]
	markers: { kind: string; text: string }[]
	storage: MemoryStorage
	client: ReturnType<typeof scriptedClient>
	tunables: ObserverTunables
}

function makeHarness(script: Script, defs: DetectorDef[] = detectors()): Harness {
	const storage = new MemoryStorage()
	const notifies: string[] = []
	const queues: string[] = []
	const markers: { kind: string; text: string }[] = []
	const debug: { taskId: string; pass: number; name: string; content: string }[] = []
	const client = scriptedClient(script)
	const tunables: ObserverTunables = {
		minIntervalS: 90,
		triggerChars: 100,
		maxIntervalS: 900,
		forkDeadlineS: 5,
		tokensPerTask: 1_000_000,
		tokensPerHour: 1_000_000,
		finishGateEnabled: true,
		finishGateMinIntervalS: 3600,
		turnEndReport: true,
		gate: { ratePerHour: 10, cooldownS: 0, humanFloor: 0.35, adviceTtlS: 900, queueTimeoutS: 1800, muted: false },
	}
	const seams: DeliverySeams = {
		async notifyAgent(text) {
			notifies.push(text)
		},
		async queueAgent(text) {
			queues.push(text)
		},
		async marker(kind, text) {
			markers.push({ kind, text })
		},
		async loadDetectors() {
			return defs
		},
		clientFor() {
			return client
		},
		executor(): ToolDispatcher {
			return {
				async execute() {
					return { content: "n/a", isError: false }
				},
			}
		},
		tunables() {
			return tunables
		},
		async debugCapture(taskId, pass, name, content) {
			debug.push({ taskId, pass, name, content })
		},
		log() {},
	}
	const observer = new TaskObserver("task-1", "/ws", new LedgerStore(storage), seams)
	return { observer, notifies, queues, markers, storage, client, tunables, debug }
}

function feed(observer: TaskObserver, texts: string[], kind: Observation["kind"] = "tool"): void {
	for (const [i, text] of texts.entries()) observer.observe({ at: T0 + i, kind, text })
}

describe("trigger policy", () => {
	it("volume within the clock floor; the floor binds unconditionally", () => {
		const h = makeHarness({ bySlug: {} })
		feed(h.observer, ["x".repeat(200)])
		// Volume met but the clock floor not yet elapsed since construction epoch 0…
		expect(h.observer.dueTrigger(T0 + 1000)).toBe("volume") // first pass: lastPassStartedAt=0 ⇒ floor long passed
	})

	it("nothing pending ⇒ never due", () => {
		const h = makeHarness({ bySlug: {} })
		expect(h.observer.dueTrigger(T0)).toBeUndefined()
	})

	it("turn end is exempt from every limit", async () => {
		const h = makeHarness({ bySlug: {} })
		feed(h.observer, ["small"])
		await h.observer.runPass("manual", () => T0) // consume the pending spool
		feed(h.observer, ["tiny"])
		h.observer.noteTurnEnd(false)
		expect(h.observer.dueTrigger(T0 + 1000)).toBe("turn_end") // floor NOT elapsed, still due
	})
})

describe("a pass", () => {
	it("runs the pilot first, then the rest; all silent ⇒ nothing delivered", async () => {
		const h = makeHarness({ bySlug: { "repeat-failure": silentReply, "standard-questions": silentReply } })
		feed(h.observer, ["execute_command\ngo build ./..."])
		const result = await h.observer.runPass("manual", () => T0)
		expect(result?.verdicts.map((v) => `${v.detector}:${v.verdict}`)).toEqual([
			"repeat-failure:silent",
			"standard-questions:silent",
		])
		expect(h.client.calls[0]!.slug).toBe("repeat-failure") // the pilot went first
		expect(h.notifies).toEqual([])
		expect(h.markers.filter((m) => m.kind === "advisory")).toEqual([])
	})

	it("every fork of a pass gets a BYTE-IDENTICAL systemPrompt (cross-fork cache sharing)", async () => {
		const h = makeHarness({ bySlug: { "repeat-failure": silentReply, "standard-questions": silentReply } })
		feed(h.observer, ["write_to_file a.ts", "execute_command\ngo build ./..."])
		await h.observer.runPass("manual", () => T0)

		const prompts = h.client.calls.map((c) => c.systemPrompt)
		expect(prompts.length).toBe(2)
		// Identical bytes ⇒ the pilot writes the cache entry and the rest read it.
		expect(new Set(prompts).size).toBe(1)
		// The digest rides the system block; nothing per-detector may leak into it.
		expect(prompts[0]).toContain("OBSERVATION DIGEST")
		expect(prompts[0]).toContain("go build ./...")
		expect(prompts[0]).not.toContain("detector of the Second Brain")
		// …and each fork's private tail is the ONLY message it sends.
		expect(h.client.calls[0]!.messages.length).toBe(1)
		expect(String(h.client.calls[0]!.messages[0]!.content)).toContain('"repeat-failure" detector')
	})

	it("each pass EXTENDS the previous pass's systemPrompt (cross-pass cache reads)", async () => {
		const h = makeHarness({ bySlug: { "repeat-failure": silentReply, "standard-questions": silentReply } })
		feed(h.observer, ["first observation"])
		await h.observer.runPass("manual", () => T0)
		const pass1 = h.client.calls[0]!.systemPrompt

		feed(h.observer, ["second observation"])
		await h.observer.runPass("manual", () => T0 + 200_000)
		const pass2 = h.client.calls[h.client.calls.length - 1]!.systemPrompt

		// Strict prefix growth is what lets pass N+1 read pass N's cached entry instead
		// of paying full price for the accumulated digest again.
		expect(pass2.startsWith(pass1)).toBe(true)
		expect(pass2.length).toBeGreaterThan(pass1.length)
		expect(pass2).toContain("second observation")
	})

	it("the tools array is stable across passes even when a cadence-2 detector skips", async () => {
		// Tools lead the cache key: deriving the wire list from the cadence-filtered
		// running set would invalidate the whole prefix on alternating passes.
		const defs = detectors()
		defs.push({
			slug: "git-log",
			enabled: true,
			system: "history",
			tools: ["read_file", "execute_command"],
			exec: ["git status --short"],
			cadenceNth: 2,
			confidenceFloor: 0.65,
			deadlineS: 0,
			pilot: false,
			structural: false,
		})
		const h = makeHarness({ bySlug: { "repeat-failure": silentReply, "standard-questions": silentReply } }, defs)

		feed(h.observer, ["a"])
		await h.observer.runPass("manual", () => T0)
		feed(h.observer, ["b"])
		await h.observer.runPass("manual", () => T0 + 200_000)

		const toolSets = h.client.calls.map((c) => c.tools.join(","))
		expect(new Set(toolSets).size).toBe(1)
		// git-log's grant is offered on every pass, including the ones it sits out.
		expect(h.client.calls[0]!.tools).toContain("execute_command")
	})

	it("an advise says it to BOTH: notify and marker carry the same words", async () => {
		const h = makeHarness({ bySlug: { "repeat-failure": silentReply, "standard-questions": adviseReply() } })
		feed(h.observer, ["write_to_file services/foo/health.go"])
		await h.observer.runPass("manual", () => T0)
		expect(h.notifies.length).toBe(1)
		const advisoryMarkers = h.markers.filter((m) => m.kind === "advisory")
		expect(advisoryMarkers.length).toBe(1)
		// Identical substance, twice-addressed.
		expect(h.notifies[0]).toContain("No test run observed since the first edit")
		expect(advisoryMarkers[0]!.text).toContain("No test run observed since the first edit")
		// The agent copy is framed as data-not-instructions.
		expect(h.notifies[0]).toContain("no user authority")
		// The user copy is attributed with the mute affordance.
		expect(advisoryMarkers[0]!.text).toContain("standard-questions")
		expect(advisoryMarkers[0]!.text).toContain("catalogue.json")
	})

	it("a human-only advisory reaches the marker but never the agent", async () => {
		const h = makeHarness({
			bySlug: { "repeat-failure": silentReply, "standard-questions": adviseReply({ confidence: 0.45 }) },
		})
		feed(h.observer, ["edit"])
		await h.observer.runPass("manual", () => T0)
		expect(h.notifies).toEqual([])
		expect(h.markers.filter((m) => m.kind === "advisory").length).toBe(1)
	})

	it("turn-end verdicts reach the user only, as a report marker", async () => {
		const h = makeHarness({ bySlug: { "repeat-failure": silentReply, "standard-questions": silentReply } })
		feed(h.observer, ["something"])
		h.observer.noteTurnEnd(false)
		await h.observer.runPass("turn_end", () => T0)
		const report = h.markers.find((m) => m.kind === "turn-report")
		expect(report?.text).toContain("not shown to the agent")
		expect(report?.text).toContain("repeat-failure → silent")
		expect(h.notifies).toEqual([])
	})

	it("adjudicated rejection suppresses the key for the task", async () => {
		const script: Script = { bySlug: { "repeat-failure": silentReply, "standard-questions": adviseReply() } }
		const h = makeHarness(script)
		feed(h.observer, ["edit one"])
		await h.observer.runPass("manual", () => T0)
		const advisoryId = h.observer.currentLedger!.advisories[0]!.id

		// Next pass: the detector adjudicates its advisory as rejected, with evidence.
		script.bySlug["standard-questions"] = {
			text: "",
			toolCalls: [
				{
					id: "f",
					name: FEEDBACK_TOOL_NAME,
					arguments: JSON.stringify({
						verdict: "silent",
						outcomes: [{ advice_id: advisoryId, verdict: "rejected", evidence: ["user said no tests"] }],
					}),
				},
			],
			tokens: usage(5, 2),
			costUsd: 0,
		}
		feed(h.observer, ["more work"])
		await h.observer.runPass("manual", () => T0 + 100_000)
		const ledger = h.observer.currentLedger!
		expect(ledger.advisories[0]!.outcome?.verdict).toBe("rejected")
		expect(ledger.suppressed).toContain(ledger.advisories[0]!.dedupKey)
	})

	it("captures the shared digest, a pass summary and every fork's loop for verification", async () => {
		const h = makeHarness({ bySlug: { "repeat-failure": silentReply, "standard-questions": silentReply } })
		feed(h.observer, ["write_to_file services/foo/health.go"])
		await h.observer.runPass("manual", () => T0)

		const names = h.debug.map((d) => d.name).sort()
		expect(names).toEqual(["digest", "pass", "repeat-failure", "standard-questions"])

		// digest.txt is the EXACT block every fork received — that is what makes
		// "diff pass N against pass N+1" a real verification of prefix growth.
		const digest = h.debug.find((d) => d.name === "digest")!.content
		expect(digest).toBe(h.client.calls[0]!.systemPrompt)
		expect(digest).toContain("OBSERVATION DIGEST")
		expect(digest).toContain("services/foo/health.go")

		// pass.json carries the per-detector cache evidence.
		const summary = JSON.parse(h.debug.find((d) => d.name === "pass")!.content) as {
			pass: number
			pilot: string
			systemPromptChars: number
			detectors: Record<string, { tokens: { cacheRead: number; cacheWrite: number } }>
		}
		expect(summary.pass).toBe(1)
		expect(summary.pilot).toBe("repeat-failure")
		expect(summary.systemPromptChars).toBe(digest.length)
		expect(Object.keys(summary.detectors).sort()).toEqual(["repeat-failure", "standard-questions"])

		// Each fork's file holds its own loop: its tail, its verdict, and its usage.
		const fork = h.debug.find((d) => d.name === "standard-questions")!.content
		expect(fork).toContain('"standard-questions" detector')
		expect(fork).toContain("final second_brain_detector_feedback:")
		expect(fork).toMatch(/usage: prompt=\d+ completion=\d+ cacheRead=\d+ cacheWrite=\d+ cost=\$/)
	})

	it("reports provider cache tokens on the ledger, so hit ratios are measurable", async () => {
		const cached: ForkChatResult = {
			...silentReply,
			tokens: usage(120, 8, 4200, 0),
		}
		const writing: ForkChatResult = {
			...silentReply,
			tokens: usage(120, 8, 0, 4200),
		}
		const h = makeHarness({ bySlug: { "repeat-failure": writing, "standard-questions": cached } })
		feed(h.observer, ["some work"])
		await h.observer.runPass("manual", () => T0)

		// The shape the design predicts: the pilot writes the prefix, the rest read it.
		expect(h.observer.stats.tokens).toEqual({ prompt: 240, completion: 16, cacheRead: 4200, cacheWrite: 4200 })
	})

	it("budget exhaustion degrades to silence and says so", async () => {
		const h = makeHarness({ bySlug: { "repeat-failure": silentReply, "standard-questions": silentReply } })
		h.tunables.tokensPerHour = 1 // exhausted after any pass
		feed(h.observer, ["work"])
		await h.observer.runPass("manual", () => T0)
		feed(h.observer, ["more"])
		const second = await h.observer.runPass("manual", () => T0 + 1000)
		expect(second?.verdicts).toEqual([{ detector: "*", verdict: "skipped", note: "(budget exhausted)" }])
		expect(h.client.calls.filter((c) => c.slug !== "?").length).toBe(2) // only the first pass forked
	})

	it("the finish gate queue-wakes a completed task, once, with a visible marker", async () => {
		const h = makeHarness({
			bySlug: {
				"repeat-failure": silentReply,
				"standard-questions": adviseReply({ finish_gate: true, confidence: 0.9 }),
			},
		})
		feed(h.observer, ["version bumped"])
		h.observer.noteTurnEnd(true) // completed
		await h.observer.runPass("turn_end", () => T0)
		expect(h.queues.length).toBe(1)
		expect(h.queues[0]).toContain("No test run observed")
		expect(h.markers.some((m) => m.kind === "finish-gate")).toBe(true)

		// A second completion inside the interval must NOT fire again.
		feed(h.observer, ["still bumped"])
		h.observer.noteTurnEnd(true)
		await h.observer.runPass("turn_end", () => T0 + 60_000)
		expect(h.queues.length).toBe(1)
	})
})
