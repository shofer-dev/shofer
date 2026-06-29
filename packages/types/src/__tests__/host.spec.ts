import { describe, it, expect } from "vitest"

import { createInMemoryHost, InMemoryFileSystem, RecordingNotifier } from "../host-memory.js"

/**
 * §9 host boundary — exercises the in-memory reference host (the vscode-free
 * implementation used by the CLI/tests).
 */
describe("in-memory HostBridge (§9)", () => {
	it("RecordingNotifier captures messages by level", () => {
		const n = new RecordingNotifier()
		n.info("i")
		n.warn("w")
		n.error("e")
		expect(n.messages).toEqual([
			{ level: "info", message: "i" },
			{ level: "warn", message: "w" },
			{ level: "error", message: "e" },
		])
	})

	it("InMemoryFileSystem round-trips files and reports existence", async () => {
		const fs = new InMemoryFileSystem()
		expect(await fs.exists("/a.txt")).toBe(false)
		await fs.writeFile("/a.txt", "hello")
		expect(await fs.exists("/a.txt")).toBe(true)
		expect(await fs.readFile("/a.txt")).toBe("hello")
		await fs.delete("/a.txt")
		expect(await fs.exists("/a.txt")).toBe(false)
		await expect(fs.readFile("/a.txt")).rejects.toThrow(/ENOENT/)
	})

	it("createInMemoryHost wires a notifier + fs with zero vscode deps", async () => {
		const host = createInMemoryHost()
		host.notifier.info("ready")
		await host.fs.mkdir("/dir")
		expect(await host.fs.exists("/dir")).toBe(true)
	})
})
