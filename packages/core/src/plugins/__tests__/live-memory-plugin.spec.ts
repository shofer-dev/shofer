import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

import { createInMemoryHost, type HostBridge, type HostFileSystem } from "@shofer/types"
import type { Anthropic } from "@anthropic-ai/sdk"

import { PluginManager, type PluginAiConsentStore, type PluginStateStore } from "../plugin-manager.js"
import { createNodePluginFs } from "../plugin-manager.js"
import { pluginRegistry } from "../plugin-registry.js"
import { createNodePluginCodeLoader } from "../plugin-loader.js"
import { packPluginToFile, unpackPlugin, PLUGIN_ARCHIVE_EXTENSION } from "../plugin-pack.js"
import type { PluginAiProvider } from "../plugin-ai.js"
import type { ApiHandler } from "../../api/api-handler-types.js"

/**
 * Dogfood test for the first-party **Live Memory plugin** (`<repo>/plugins/live-memory`).
 *
 * It loads the *real* plugin off disk through the *real* {@link PluginManager} + the
 * esbuild code loader (P2) with the P6 host capabilities wired (`ctx.storage`,
 * `ctx.ai`, `ctx.host`, `ctx.registerService`), then exercises every extension point
 * the plugin uses — proving the plugin architecture end-to-end:
 *
 *  - `afterToolCall` accumulates memory from Shofer's own file activity,
 *  - `transformSystemPrompt` injects a live "LIVE MEMORY" section reading that memory,
 *  - `ask_live_memory` (registerTools) answers from the accumulated memory via `ctx.ai`,
 *  - `ctx.ai` is gated on the billed-AI **consent** (denying stub when not consented).
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../plugins/live-memory")
const PLUGINS_PARENT = path.dirname(PLUGIN_DIR)

/** A fake host `ApiHandler` that echoes the files it finds in the accumulated memory. */
function makeEchoHandler(): ApiHandler {
	async function* stream(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
	): AsyncGenerator<{ type: string; text?: string; inputTokens?: number; outputTokens?: number }> {
		const files = [...systemPrompt.matchAll(/edit: (\S+)/g)].map((m) => m[1])
		const last = messages[messages.length - 1]
		const question = typeof last?.content === "string" ? last.content : "(structured)"
		yield {
			type: "text",
			text: `Memory-grounded answer to "${question}". Files edited: ${files.length ? files.join(", ") : "none"}.`,
		}
		yield { type: "usage", inputTokens: 11, outputTokens: 7 }
	}
	return {
		createMessage: (systemPrompt: string, messages: Anthropic.Messages.MessageParam[]) =>
			stream(systemPrompt, messages),
		getModel: () => ({ id: "echo-model", info: {} }),
		countTokens: async () => 0,
	} as unknown as ApiHandler
}

const aiProvider: PluginAiProvider = {
	buildHandler: async () => makeEchoHandler(),
	embed: async (texts: string[]) => texts.map(() => [0]),
}

class MemoryStateStore implements PluginStateStore {
	constructor(public names: string[] = []) {}
	getEnabledPlugins(): string[] {
		return [...this.names]
	}
	setEnabledPlugins(names: string[]): void {
		this.names = [...names]
	}
}

class MemoryConsentStore implements PluginAiConsentStore {
	constructor(public names: string[] = []) {}
	getAiConsentedPlugins(): string[] {
		return [...this.names]
	}
	setAiConsentedPlugins(names: string[]): void {
		this.names = [...names]
	}
}

/** An inspectable in-memory `HostFileSystem` (exposes the backing map for assertions). */
class RecordingFs implements HostFileSystem {
	readonly files = new Map<string, string>()
	private readonly dirs = new Set<string>()
	async readFile(p: string): Promise<string> {
		const c = this.files.get(p)
		if (c === undefined) throw new Error(`ENOENT: ${p}`)
		return c
	}
	async writeFile(p: string, content: string): Promise<void> {
		this.files.set(p, content)
	}
	async exists(p: string): Promise<boolean> {
		return this.files.has(p) || this.dirs.has(p)
	}
	async mkdir(p: string): Promise<void> {
		this.dirs.add(p)
	}
	async delete(p: string): Promise<void> {
		this.files.delete(p)
		this.dirs.delete(p)
	}
	async findFiles(): Promise<string[]> {
		return []
	}
}

interface Harness {
	manager: PluginManager
	host: HostBridge
	recordingFs: RecordingFs
	workspace: string
}

let cacheDir: string
let seq = 0

async function buildHarness(opts: { consented: boolean }): Promise<Harness> {
	const recordingFs = new RecordingFs()
	const host: HostBridge = { ...createInMemoryHost(), fs: recordingFs }
	const workspace = `/ws/live-memory-${seq++}`
	const manager = new PluginManager({
		fs: createNodePluginFs(),
		pluginDirs: [{ dir: PLUGINS_PARENT, scope: "global" }],
		stateStore: new MemoryStateStore(["live-memory"]),
		codeLoader: createNodePluginCodeLoader({ cacheDir }),
		host,
		aiProvider,
		aiConsentStore: new MemoryConsentStore(opts.consented ? ["live-memory"] : []),
		storageBaseDir: `/mem-storage-${seq}`,
		workspacePath: workspace,
	})
	await manager.discover()
	await manager.activateCodePlugins()
	return { manager, host, recordingFs, workspace }
}

describe("Live Memory plugin (P1–P6 dogfood)", () => {
	beforeAll(() => {
		cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-memory-plugin-cache-"))
	})
	afterAll(() => {
		fs.rmSync(cacheDir, { recursive: true, force: true })
	})
	beforeEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})
	afterEach(() => {
		for (const name of pluginRegistry.list()) pluginRegistry.unregister(name)
	})

	// This is the only test in the file that pays for a COLD esbuild bundle of the real
	// on-disk plugin — `cacheDir` is a fresh mkdtemp per run, so the first buildHarness()
	// bundles main.ts from scratch (~2.3s idle) and the rest hit the warm cache (~10ms
	// each). Against vitest's 5s default that is barely a 2x margin, so under full-suite
	// parallelism it times out while every other test in the file passes. Give it the same
	// explicit budget the other real-esbuild suite uses (custom-tool-registry.spec.ts).
	it("discovers, loads (esbuild), and registers the on-disk plugin with a tool", async () => {
		expect(fs.existsSync(path.join(PLUGIN_DIR, "plugin.json"))).toBe(true)
		await buildHarness({ consented: true })
		expect(pluginRegistry.has("live-memory")).toBe(true)
		const tools = await pluginRegistry.collectTools()
		expect(tools.map((t) => t.name)).toContain("ask_live_memory")
	}, 60_000)

	it("afterToolCall accumulates memory and transformSystemPrompt injects a live section", async () => {
		await buildHarness({ consented: true })

		// Simulate Shofer editing two files — the wired afterToolCall reducer path.
		await pluginRegistry.applyAfterToolCall("write_to_file", { path: "src/foo.ts" }, "ok, wrote 10 lines")
		await pluginRegistry.applyAfterToolCall("apply_diff", { path: "src/bar.ts" }, "applied")
		// A read is also observed (richer than the built-in's edit-only signal).
		await pluginRegistry.applyAfterToolCall("read_file", { path: "src/baz.ts" }, "contents")
		// A non-file tool is ignored.
		await pluginRegistry.applyAfterToolCall("execute_command", { command: "ls" }, "a b c")

		const prompt = await pluginRegistry.applySystemPromptTransforms("BASE PROMPT")
		expect(prompt).toContain("BASE PROMPT")
		expect(prompt).toContain("LIVE MEMORY")
		expect(prompt).toContain("ask_live_memory")
		// 3 observations retained (2 edits + 1 read), across 3 distinct files.
		expect(prompt).toContain("3 (of 3 seen) across 3 file(s)")
	})

	it("ask_live_memory answers from the accumulated memory via ctx.ai (consented)", async () => {
		await buildHarness({ consented: true })
		await pluginRegistry.applyAfterToolCall("write_to_file", { path: "src/foo.ts" }, "ok")

		const tools = await pluginRegistry.collectTools()
		const ask = tools.find((t) => t.name === "ask_live_memory")!
		const answer = await ask.execute({ question: "What changed recently?" }, { mode: "code", task: {} as never })
		// The echo handler surfaces the file names it found in the injected memory
		// context — proving the answer is grounded in the plugin's own store.
		expect(answer).toContain("Live Memory Answer")
		expect(answer).toContain("src/foo.ts")
		expect(answer).toContain("What changed recently?")
	})

	it("accepts the full ask_live_memory param set and returns the agent-loop output block", async () => {
		const h = await buildHarness({ consented: true })
		await pluginRegistry.applyAfterToolCall("write_to_file", { path: "src/foo.ts" }, "ok")
		// Seed a context file so `contextFiles` loading is exercised (Files in context: 1).
		h.recordingFs.files.set(path.resolve(h.workspace, "src/foo.ts"), "export const foo = 1\n")

		const tools = await pluginRegistry.collectTools()
		const ask = tools.find((t) => t.name === "ask_live_memory")!
		const answer = await ask.execute(
			{
				question: "How does foo work?",
				contextFiles: ["src/foo.ts"],
				timeoutMs: 120000,
				softTimeoutSec: 20,
				softResultLength: 500,
			},
			{ mode: "code", task: {} as never },
		)
		// The Stage-C output block emits the canonical Live Memory answer format.
		expect(answer).toContain("Live Memory Answer")
		expect(answer).toContain("Context:")
		expect(answer).toContain("% full)")
		expect(answer).toMatch(/Duration: [\d.]+s/)
		expect(answer).toMatch(/Tokens: \d+ prompt \+ \d+ completion = \d+ total/)
		expect(answer).toMatch(/Cost: \$[\d.]+ \(session total\)/)
		expect(answer).toContain("Files in context: 1")
	})

	it("gates ctx.ai on the billed-AI consent (denying stub when not consented)", async () => {
		await buildHarness({ consented: false })
		await pluginRegistry.applyAfterToolCall("write_to_file", { path: "src/foo.ts" }, "ok")

		const tools = await pluginRegistry.collectTools()
		const ask = tools.find((t) => t.name === "ask_live_memory")!
		const answer = await ask.execute({ question: "anything?" }, { mode: "code", task: {} as never })
		expect(answer).toContain("Live Memory error")
		expect(answer.toLowerCase()).toContain("consent")
	})

	it("writes memory through ctx.storage as a per-workspace JSON document", async () => {
		const h = await buildHarness({ consented: true })
		await pluginRegistry.applyAfterToolCall("write_to_file", { path: "src/persisted.ts" }, "ok")

		// The plugin persisted its memory through ctx.storage → the host fs recorded a
		// `memory-<hash>.json` file under the plugin's storage dir, containing the edit.
		const memoryFiles = [...h.recordingFs.files.entries()].filter(([p]) => /memory-[0-9a-f]+\.json$/.test(p))
		expect(memoryFiles.length).toBe(1)
		const [filePath, content] = memoryFiles[0]!
		expect(filePath).toContain("live-memory") // rooted at <storageBaseDir>/live-memory
		const doc = JSON.parse(content) as { observations: Array<{ subject: string; kind: string }> }
		expect(doc.observations.some((o) => o.subject === "src/persisted.ts" && o.kind === "edit")).toBe(true)
	})

	it("packs to a .shofer-plugin archive that round-trips (P8 distributable)", async () => {
		const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-memory-pack-"))
		try {
			const archive = path.join(outDir, `live-memory${PLUGIN_ARCHIVE_EXTENSION}`)
			await packPluginToFile(PLUGIN_DIR, archive)
			expect(fs.existsSync(archive)).toBe(true)

			const dest = path.join(outDir, "unpacked")
			const installed = await unpackPlugin(archive, dest)
			expect(installed.name).toBe("live-memory")
			// The manifest + code entry sit at the archive root (no wrapping dir),
			// unpacked into <dest>/<name>/ and re-discoverable as a plugin.
			expect(fs.existsSync(path.join(installed.dir, "plugin.json"))).toBe(true)
			expect(fs.existsSync(path.join(installed.dir, "main.ts"))).toBe(true)
			expect(fs.existsSync(path.join(installed.dir, "memory-store.ts"))).toBe(true)
		} finally {
			fs.rmSync(outDir, { recursive: true, force: true })
		}
	})
})
