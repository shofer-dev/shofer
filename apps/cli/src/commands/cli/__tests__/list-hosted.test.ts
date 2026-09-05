/**
 * Unit tests for the host-backed half of `shofer list`
 * (`src/commands/cli/list.ts`): `listCommands`, `listModes`, `listModels`, and
 * the path/format guards they share with `listSessions`.
 *
 * `listCommands`/`listModes` boot an extension host and ask it a question over
 * the webview message channel, so the host is faked: it answers, stays silent,
 * errors, or replies with something unparseable, one per case. `listSessions`'
 * own JSON/text output is covered by `list.test.ts`; what is added here is the
 * long-title truncation and the unknown-timestamp fallback.
 */

import fs from "fs"
import os from "os"
import path from "path"

import { readWorkspaceTaskSessions } from "@/lib/task-history/index.js"

import { listCommands, listModels, listModes, listSessions } from "../list.js"

class ExitSignal extends Error {
	constructor(readonly code: number | undefined) {
		super(`process.exit(${code})`)
		this.name = "ExitSignal"
	}
}

const hostState = vi.hoisted(() => ({
	instances: [] as Array<Record<string, unknown>>,
	/** How the fake host answers the next `sendToExtension` request. */
	reply: { kind: "message" } as
		| { kind: "message"; payload?: unknown }
		| { kind: "silent" }
		| { kind: "clientError"; error: Error },
	/** Payload the host answers `requestCommands` / `requestModes` with. */
	payloads: {} as Record<string, unknown>,
	initialized: true,
}))

vi.mock("@/agent/index.js", () => {
	class ExtensionHost {
		options: unknown
		listeners = new Map<string, Array<(message: unknown) => void>>()
		clientErrorListeners: Array<(error: Error) => void> = []
		offCalls = 0
		activate = vi.fn(async () => {})
		dispose = vi.fn(async () => {})

		client = {
			isInitialized: () => hostState.initialized,
			on: (event: string, listener: (error: Error) => void) => {
				if (event === "error") this.clientErrorListeners.push(listener)
				return () => {
					this.offCalls++
				}
			},
		}

		constructor(options: unknown) {
			this.options = options
			hostState.instances.push(this as unknown as Record<string, unknown>)
		}

		on(event: string, listener: (message: unknown) => void): void {
			const bucket = this.listeners.get(event) ?? []
			bucket.push(listener)
			this.listeners.set(event, bucket)
		}

		off(event: string, listener: (message: unknown) => void): void {
			const bucket = this.listeners.get(event) ?? []
			this.listeners.set(
				event,
				bucket.filter((entry) => entry !== listener),
			)
		}

		sendToExtension(message: { type: string }): void {
			const deliver = (payload: unknown) => {
				for (const listener of [...(this.listeners.get("extensionWebviewMessage") ?? [])]) listener(payload)
			}

			queueMicrotask(() => {
				if (hostState.reply.kind === "clientError") {
					for (const listener of [...this.clientErrorListeners]) listener(hostState.reply.error)
					return
				}
				if (hostState.reply.kind === "silent") return

				// A message that is not an object at all must be skipped, as must
				// one of the wrong type — only the matching reply resolves.
				deliver("not-a-record")
				deliver({ type: "someOtherMessage" })
				deliver(hostState.reply.payload ?? hostState.payloads[message.type])
			})
		}
	}

	return { ExtensionHost, unattendedApprovalSeed: () => ({}) }
})

vi.mock("@/lib/task-history/index.js", () => ({ readWorkspaceTaskSessions: vi.fn(async () => []) }))

let extensionDir: string
/** Narrow alias so the spy keeps `process.exit`'s own signature. */
const _spyOnExit = () => vi.spyOn(process, "exit")
let exitSpy: ReturnType<typeof _spyOnExit>
let stdoutChunks: string[]
let errorLines: string[]

function lastHost(): Record<string, unknown> {
	return hostState.instances.at(-1)!
}

const stdout = () => stdoutChunks.join("")

describe("host-backed list commands", () => {
	beforeAll(() => {
		// `resolveExtensionPath` insists on an `extension.js` inside the bundle dir.
		extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-list-ext-"))
		fs.writeFileSync(path.join(extensionDir, "extension.js"), "// fake bundle\n")
	})

	afterAll(() => {
		fs.rmSync(extensionDir, { recursive: true, force: true })
	})

	beforeEach(() => {
		vi.clearAllMocks()
		hostState.instances = []
		hostState.reply = { kind: "message" }
		hostState.initialized = true
		hostState.payloads = {
			requestCommands: { type: "commands", commands: [] },
			requestModes: { type: "modes", modes: [] },
		}

		stdoutChunks = []
		errorLines = []
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			stdoutChunks.push(String(chunk))
			return true
		}) as never)
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorLines.push(args.map(String).join(" "))
		})
		exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ExitSignal(code)
		}) as never)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const baseOptions = () => ({ extension: extensionDir, workspace: process.cwd() })

	describe("listCommands", () => {
		it("prints the commands as JSON by default", async () => {
			hostState.payloads.requestCommands = {
				type: "commands",
				commands: [{ name: "review", source: "project", description: "Review the diff" }],
			}

			await listCommands(baseOptions())

			expect(JSON.parse(stdout())).toEqual({
				commands: [{ name: "review", source: "project", description: "Review the diff" }],
			})
			expect(lastHost().activate).toHaveBeenCalledTimes(1)
			expect(lastHost().dispose).toHaveBeenCalledTimes(1)
		})

		it("prints one line per command in text format", async () => {
			hostState.payloads.requestCommands = {
				type: "commands",
				commands: [
					{ name: "review", source: "project", description: "Review the diff" },
					{ name: "bare", source: "global" },
				],
			}

			await listCommands({ ...baseOptions(), format: "text" })

			expect(stdout()).toBe("/review (project) - Review the diff\n/bare (global)\n")
		})

		it("tolerates a reply whose commands field is not an array", async () => {
			hostState.payloads.requestCommands = { type: "commands", commands: "nope" }

			await listCommands(baseOptions())

			expect(JSON.parse(stdout())).toEqual({ commands: [] })
		})

		it("builds an ephemeral, non-interactive, output-silenced host", async () => {
			await listCommands(baseOptions())

			expect(lastHost().options).toMatchObject({
				mode: "code",
				provider: "openrouter",
				nonInteractive: true,
				ephemeral: true,
				debug: false,
				exitOnComplete: true,
				exitOnError: false,
				disableOutput: true,
			})
		})

		it("carries --api-key and --debug onto the host", async () => {
			await listCommands({ ...baseOptions(), apiKey: "sk-test", debug: true })
			expect(lastHost().options).toMatchObject({ apiKey: "sk-test", debug: true })
		})

		it("still answers when the client never reports itself initialized", async () => {
			hostState.initialized = false

			await listCommands(baseOptions())

			expect(JSON.parse(stdout())).toEqual({ commands: [] })
		}, 10_000)

		it("propagates a client error and still disposes the host", async () => {
			hostState.reply = { kind: "clientError", error: new Error("provider unreachable") }

			await expect(listCommands(baseOptions())).rejects.toThrow("provider unreachable")
			expect(lastHost().dispose).toHaveBeenCalledTimes(1)
		})

		it("propagates a failure thrown while parsing a reply", async () => {
			// A reply whose `type` getter throws stands in for any extractor blow-up.
			hostState.reply = {
				kind: "message",
				payload: new Proxy(
					{},
					{
						get() {
							throw new Error("unreadable message")
						},
					},
				),
			}

			await expect(listCommands(baseOptions())).rejects.toThrow("unreadable message")
		})

		it("removes its process signal handlers again", async () => {
			const before = process.listenerCount("SIGINT")
			await listCommands(baseOptions())
			expect(process.listenerCount("SIGINT")).toBe(before)
		})

		it("gives up on a host that never answers", async () => {
			hostState.reply = { kind: "silent" }
			vi.useFakeTimers()

			try {
				const pending = listCommands(baseOptions())
				const assertion = expect(pending).rejects.toThrow(
					"Timed out waiting for requestCommands response after 10000ms",
				)
				await vi.advanceTimersByTimeAsync(11_000)
				await assertion
			} finally {
				vi.useRealTimers()
			}
		})

		it("disposes the host and exits on SIGINT / SIGTERM", async () => {
			hostState.reply = { kind: "silent" }
			const registered: Array<[string, (...args: unknown[]) => void]> = []
			vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...a: unknown[]) => void) => {
				registered.push([event, listener])
				return process
			}) as never)
			vi.spyOn(process, "off").mockImplementation((() => process) as never)
			exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

			void listCommands(baseOptions()).catch(() => {})
			for (let i = 0; i < 200 && registered.length < 2; i++) {
				await new Promise((resolve) => setTimeout(resolve, 5))
			}

			const handlers = Object.fromEntries(registered) as Record<string, () => void>
			handlers.SIGINT!()
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(exitSpy).toHaveBeenCalledWith(130)

			handlers.SIGTERM!()
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(exitSpy).toHaveBeenCalledWith(143)
			expect(lastHost().dispose).toHaveBeenCalled()
		})
	})

	describe("listModes", () => {
		it("prints the modes as JSON by default", async () => {
			hostState.payloads.requestModes = { type: "modes", modes: [{ slug: "code", name: "Code" }] }

			await listModes(baseOptions())

			expect(JSON.parse(stdout())).toEqual({ modes: [{ slug: "code", name: "Code" }] })
		})

		it("prints slug and name tab-separated in text format", async () => {
			hostState.payloads.requestModes = {
				type: "modes",
				modes: [
					{ slug: "code", name: "Code" },
					{ slug: "architect", name: "Architect" },
				],
			}

			await listModes({ ...baseOptions(), format: "text" })

			expect(stdout()).toBe("code\tCode\narchitect\tArchitect\n")
		})

		it("tolerates a reply whose modes field is not an array", async () => {
			hostState.payloads.requestModes = { type: "modes", modes: null }

			await listModes(baseOptions())

			expect(JSON.parse(stdout())).toEqual({ modes: [] })
		})
	})

	describe("listModels", () => {
		it("is retired and exits 1", async () => {
			await expect(listModels(baseOptions())).rejects.toBeInstanceOf(ExitSignal)
			expect(errorLines.join("\n")).toContain('The "models" command is no longer available.')
			expect(exitSpy).toHaveBeenCalledWith(1)
		})
	})

	describe("path and format guards", () => {
		it("rejects an invalid --format before touching the host", async () => {
			await expect(listCommands({ ...baseOptions(), format: "xml" })).rejects.toThrow("Invalid format: xml")
			expect(hostState.instances).toHaveLength(0)
		})

		it("rejects a workspace that does not exist", async () => {
			await expect(listCommands({ ...baseOptions(), workspace: "/tmp/nope-4f3a-nope" })).rejects.toThrow(
				"Workspace path does not exist",
			)
		})

		it("rejects an extension directory with no bundle in it", async () => {
			const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cli-list-empty-"))
			try {
				await expect(listCommands({ ...baseOptions(), extension: empty })).rejects.toThrow(
					`Extension bundle not found at: ${empty}`,
				)
			} finally {
				fs.rmSync(empty, { recursive: true, force: true })
			}
		})

		it("defaults the workspace to the cwd", async () => {
			await listCommands({ extension: extensionDir })
			expect(lastHost().options).toMatchObject({ workspacePath: process.cwd() })
		})
	})

	describe("listSessions text rendering", () => {
		it("truncates a long title and marks an unusable timestamp", async () => {
			vi.mocked(readWorkspaceTaskSessions).mockResolvedValue([
				{ id: "s1", task: "x".repeat(200), ts: Date.UTC(2024, 0, 1) },
				{ id: "s2", task: "fine", ts: Number.NaN },
			] as never)

			await listSessions({ format: "text", workspace: process.cwd() })

			const lines = stdout().trim().split("\n")
			expect(lines[0]).toBe(`s1\t2024-01-01T00:00:00.000Z\t${"x".repeat(117)}...`)
			expect(lines[1]).toBe("s2\tunknown-time\tfine")
		})

		it("collapses runs of whitespace in a title", async () => {
			vi.mocked(readWorkspaceTaskSessions).mockResolvedValue([
				{ id: "s1", task: "  a\n\n b \t c  ", ts: Date.UTC(2024, 0, 1) },
			] as never)

			await listSessions({ format: "text", workspace: process.cwd() })

			expect(stdout().trim().split("\t")[2]).toBe("a b c")
		})
	})
})
