// pnpm --filter @shofer/cli test src/agent/__tests__/prompt-manager.test.ts

import { EventEmitter } from "events"
import { PassThrough } from "stream"
import readline from "readline"

import { PromptManager } from "../prompt-manager.js"

/**
 * PromptManager is the CLI's only stdin reader. These tests drive it over fake
 * streams: a PassThrough for the readline paths, and a bare EventEmitter for the
 * raw-mode timed prompt (which only ever uses on/removeListener/resume/pause).
 */

function makeStdout() {
	const chunks: string[] = []
	const stdout = {
		write(text: string) {
			chunks.push(text)
			return true
		},
	} as unknown as NodeJS.WriteStream
	return { chunks, stdout, text: () => chunks.join("") }
}

/** A stdin stand-in for promptWithTimeout, which never needs a real stream. */
function makeRawStdin({ isTTY = false, isRaw = false }: { isTTY?: boolean; isRaw?: boolean } = {}) {
	const emitter = new EventEmitter() as unknown as NodeJS.ReadStream & {
		setRawModeCalls: boolean[]
		resumed: number
		paused: number
	}
	const target = emitter as unknown as Record<string, unknown>
	target.isTTY = isTTY
	target.isRaw = isRaw
	target.setRawModeCalls = []
	target.resumed = 0
	target.paused = 0
	target.setRawMode = (mode: boolean) => {
		;(target.setRawModeCalls as boolean[]).push(mode)
		return emitter
	}
	target.resume = () => {
		target.resumed = (target.resumed as number) + 1
		return emitter
	}
	target.pause = () => {
		target.paused = (target.paused as number) + 1
		return emitter
	}
	return emitter
}

describe("PromptManager readline prompts", () => {
	it("resolves with the typed answer and runs both console hooks", async () => {
		const input = new PassThrough()
		const { stdout, text } = makeStdout()
		const order: string[] = []

		const manager = new PromptManager({
			stdin: input as unknown as NodeJS.ReadStream,
			stdout,
			onBeforePrompt: () => order.push("before"),
			onAfterPrompt: () => order.push("after"),
		})

		expect(manager.isActive()).toBe(false)
		const pending = manager.promptForInput("Your answer: ")
		input.write("hello world\n")

		await expect(pending).resolves.toBe("hello world")
		expect(manager.isActive()).toBe(false)
		expect(order[0]).toBe("before")
		expect(order).toContain("after")
		expect(text()).toContain("Your answer: ")
	})

	it("works with no console hooks configured", async () => {
		const input = new PassThrough()
		const { stdout } = makeStdout()
		const manager = new PromptManager({ stdin: input as unknown as NodeJS.ReadStream, stdout })
		const pending = manager.promptForInput("? ")
		input.write("plain\n")
		await expect(pending).resolves.toBe("plain")
	})

	it("defaults to the process streams", () => {
		const manager = new PromptManager()
		expect(manager.isActive()).toBe(false)
	})

	it("rejects when the readline interface errors", async () => {
		const fakeRl = new EventEmitter() as unknown as readline.Interface & { closed: boolean }
		;(fakeRl as unknown as Record<string, unknown>).question = () => {}
		;(fakeRl as unknown as Record<string, unknown>).close = () => {
			;(fakeRl as unknown as Record<string, unknown>).closed = true
		}
		const spy = vi.spyOn(readline, "createInterface").mockReturnValue(fakeRl)

		try {
			const manager = new PromptManager()
			const pending = manager.promptForInput("? ")
			expect(manager.isActive()).toBe(true)
			fakeRl.emit("error", new Error("stdin exploded"))
			await expect(pending).rejects.toThrow("stdin exploded")
			expect(manager.isActive()).toBe(false)
		} finally {
			spy.mockRestore()
		}
	})

	it("resets active state when the interface closes", async () => {
		const fakeRl = new EventEmitter() as unknown as readline.Interface
		;(fakeRl as unknown as Record<string, unknown>).question = () => {}
		;(fakeRl as unknown as Record<string, unknown>).close = () => {}
		const spy = vi.spyOn(readline, "createInterface").mockReturnValue(fakeRl)
		const afterCalls: number[] = []

		try {
			const manager = new PromptManager({ onAfterPrompt: () => afterCalls.push(1) })
			void manager.promptForInput("? ")
			fakeRl.emit("close")
			expect(manager.isActive()).toBe(false)
			expect(afterCalls).toHaveLength(1)
		} finally {
			spy.mockRestore()
		}
	})
})

describe("PromptManager yes/no", () => {
	async function answer(input: string, defaultValue?: boolean): Promise<boolean> {
		const stream = new PassThrough()
		const { stdout } = makeStdout()
		const manager = new PromptManager({ stdin: stream as unknown as NodeJS.ReadStream, stdout })
		const pending =
			defaultValue === undefined ? manager.promptForYesNo("ok? ") : manager.promptForYesNo("ok? ", defaultValue)
		stream.write(`${input}\n`)
		return pending
	}

	it("accepts y and yes in any case", async () => {
		expect(await answer("y")).toBe(true)
		expect(await answer("YES")).toBe(true)
		expect(await answer(" Yes ")).toBe(true)
	})

	it("treats anything else as no", async () => {
		expect(await answer("n")).toBe(false)
		expect(await answer("nope")).toBe(false)
	})

	it("uses the default for empty input", async () => {
		expect(await answer("")).toBe(false)
		expect(await answer("", true)).toBe(true)
	})
})

describe("PromptManager promptWithTimeout", () => {
	it("returns the default when the timeout elapses", async () => {
		const stdin = makeRawStdin()
		const { stdout, text } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })

		const result = await manager.promptWithTimeout("pick: ", 5, "fallback")

		expect(result).toEqual({ value: "fallback", timedOut: true, cancelled: false })
		expect(text()).toContain("[Timeout - using default: fallback]")
		expect(manager.isActive()).toBe(false)
	})

	it("labels an empty default in the timeout notice", async () => {
		const stdin = makeRawStdin()
		const { stdout, text } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })

		await manager.promptWithTimeout("pick: ", 5, "")
		expect(text()).toContain("(empty)")
	})

	it("accumulates characters and resolves on Enter", async () => {
		const stdin = makeRawStdin()
		const { stdout, text } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })

		const pending = manager.promptWithTimeout("pick: ", 10_000, "d")
		stdin.emit("data", Buffer.from("a"))
		stdin.emit("data", Buffer.from("b"))
		stdin.emit("data", Buffer.from("\r"))

		await expect(pending).resolves.toEqual({ value: "ab", timedOut: false, cancelled: false })
		expect(text()).toContain("pick: ")
		expect(text()).toContain("a")
	})

	it("handles backspace, including on an empty buffer", async () => {
		const stdin = makeRawStdin()
		const { stdout, text } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })

		const pending = manager.promptWithTimeout("pick: ", 10_000, "d")
		stdin.emit("data", Buffer.from("\x7f")) // nothing to delete
		stdin.emit("data", Buffer.from("xy"))
		stdin.emit("data", Buffer.from("\b"))
		stdin.emit("data", Buffer.from("\n"))

		await expect(pending).resolves.toEqual({ value: "x", timedOut: false, cancelled: false })
		expect(text()).toContain("\b \b")
	})

	it("reports cancellation on Ctrl+C", async () => {
		const stdin = makeRawStdin()
		const { stdout, text } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })

		const pending = manager.promptWithTimeout("pick: ", 10_000, "d")
		stdin.emit("data", Buffer.from("\x03"))

		await expect(pending).resolves.toEqual({ value: "d", timedOut: false, cancelled: true })
		expect(text()).toContain("[cancelled]")
	})

	it("ignores late input after the prompt already resolved", async () => {
		const stdin = makeRawStdin()
		const { stdout } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })

		const pending = manager.promptWithTimeout("pick: ", 10_000, "d")
		stdin.emit("data", Buffer.from("\n"))
		await pending

		// The data listener is removed by cleanup; re-emitting must not throw.
		expect(() => stdin.emit("data", Buffer.from("z"))).not.toThrow()
	})

	it("enters and restores raw mode on a TTY", async () => {
		const stdin = makeRawStdin({ isTTY: true, isRaw: false })
		const { stdout } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })

		const pending = manager.promptWithTimeout("pick: ", 10_000, "d")
		stdin.emit("data", Buffer.from("\n"))
		await pending

		const calls = (stdin as unknown as { setRawModeCalls: boolean[] }).setRawModeCalls
		expect(calls).toEqual([true, false])
		expect((stdin as unknown as { paused: number }).paused).toBe(1)
		expect((stdin as unknown as { resumed: number }).resumed).toBe(1)
	})
})

describe("PromptManager promptForYesNoWithTimeout", () => {
	it("returns the default on timeout", async () => {
		const stdin = makeRawStdin()
		const { stdout } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })
		await expect(manager.promptForYesNoWithTimeout("ok? ", 5, true)).resolves.toBe(true)
	})

	it("returns the default when cancelled", async () => {
		const stdin = makeRawStdin()
		const { stdout } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })
		const pending = manager.promptForYesNoWithTimeout("ok? ", 10_000, false)
		stdin.emit("data", Buffer.from("\x03"))
		await expect(pending).resolves.toBe(false)
	})

	it("returns the default for empty typed input", async () => {
		const stdin = makeRawStdin()
		const { stdout } = makeStdout()
		const manager = new PromptManager({ stdin, stdout })
		const pending = manager.promptForYesNoWithTimeout("ok? ", 10_000, true)
		stdin.emit("data", Buffer.from("\n"))
		await expect(pending).resolves.toBe(true)
	})

	it("honours an explicit yes or no", async () => {
		const yesStdin = makeRawStdin()
		const { stdout } = makeStdout()
		const yesManager = new PromptManager({ stdin: yesStdin, stdout })
		const yes = yesManager.promptForYesNoWithTimeout("ok? ", 10_000, false)
		yesStdin.emit("data", Buffer.from("yes"))
		yesStdin.emit("data", Buffer.from("\n"))
		await expect(yes).resolves.toBe(true)

		const noStdin = makeRawStdin()
		const noManager = new PromptManager({ stdin: noStdin, stdout })
		const no = noManager.promptForYesNoWithTimeout("ok? ", 10_000, true)
		noStdin.emit("data", Buffer.from("n"))
		noStdin.emit("data", Buffer.from("\n"))
		await expect(no).resolves.toBe(false)
	})
})

describe("PromptManager writers", () => {
	it("writes raw text and lines", () => {
		const { stdout, text } = makeStdout()
		const manager = new PromptManager({ stdout })
		manager.write("a")
		manager.writeLine("b")
		expect(text()).toBe("ab\n")
	})
})
