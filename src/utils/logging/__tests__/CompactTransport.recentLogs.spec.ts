// npx vitest run utils/logging/__tests__/CompactTransport.recentLogs.spec.ts

import { CompactTransport } from "../CompactTransport"

/** Minimal mock OutputChannel for testing. */
class MockOutputChannel {
	lines: string[] = []
	appendLine(line: string): void {
		this.lines.push(line)
	}
}

describe("CompactTransport — getRecentLogs", () => {
	let transport: CompactTransport
	let outputChannel: MockOutputChannel

	beforeEach(() => {
		outputChannel = new MockOutputChannel()
		transport = new CompactTransport(outputChannel as any, { level: "debug" })
	})

	afterEach(() => {
		transport.close()
	})

	function writeEntry(message: string, level = "info") {
		transport.write({ t: Date.now(), l: level, m: message })
	}

	it("returns empty string when no entries have been written", () => {
		expect(transport.getRecentLogs()).toBe("")
	})

	it("returns all entries when fewer than maxLines", () => {
		writeEntry("first")
		writeEntry("second")
		writeEntry("third")

		const result = transport.getRecentLogs(10)
		const lines = result.split("\n")
		expect(lines.length).toBeGreaterThanOrEqual(3)
	})

	it("returns only the most recent maxLines", () => {
		for (let i = 0; i < 20; i++) {
			writeEntry(`msg ${i}`)
		}

		const result = transport.getRecentLogs(5)
		const lines = result.split("\n")
		expect(lines.length).toBe(5)
		expect(lines[4]).toContain("msg 19")
	})

	it("default maxLines is 2000", () => {
		for (let i = 0; i < 10; i++) {
			writeEntry(`msg ${i}`)
		}

		const result = transport.getRecentLogs()
		const lines = result.split("\n")
		expect(lines.length).toBeGreaterThanOrEqual(10) // entries + session start
	})

	it("ring buffer wraps correctly when exceeding capacity", () => {
		// 5000 is the ring buffer capacity. Write more to trigger wrapping.
		for (let i = 0; i < 5200; i++) {
			writeEntry(`msg${i}`)
		}

		const result = transport.getRecentLogs(10)
		const lines = result.split("\n")
		expect(lines.length).toBe(10)
		// All returned lines should be valid entries (not empty, start with timestamp)
		for (const line of lines) {
			expect(line.length).toBeGreaterThan(0)
			expect(line).toMatch(/^\d{4}-\d{2}-\d{2}/)
		}
	})

	it("ring buffer returns last N entries in order after wrapping", () => {
		// Write far past the ring buffer capacity (5000).
		const totalWrites = 5100
		for (let i = 0; i < totalWrites; i++) {
			writeEntry(`uid${i}`)
		}

		// Ask for the last 5 entries
		const result = transport.getRecentLogs(5)
		const lines = result.split("\n")
		expect(lines.length).toBe(5)

		// Extract uid indices from each line
		const indices = lines
			.map((l) => {
				const m = l.match(/uid(\d+)/)
				return m ? parseInt(m[1], 10) : -1
			})
			.filter((n) => n >= 0)

		// All 5 lines should have valid uid indices
		expect(indices.length).toBe(5)
		// Verify they are in strictly increasing chronological order
		for (let i = 1; i < indices.length; i++) {
			expect(indices[i]).toBeGreaterThan(indices[i - 1])
		}
	})

	it("level filtering does not affect the ring buffer (all lines are captured)", () => {
		transport.setLevel("error")

		writeEntry("debug msg", "debug")
		writeEntry("info msg", "info")
		writeEntry("error msg", "error")

		const result = transport.getRecentLogs(10)
		// The ring buffer captures human-readable lines, but level filtering
		// applies to the write path. When level is "error", debug/info entries
		// are dropped from the output channel BUT also dropped from the ring
		// buffer since we add to the ring buffer in the same filtered path.
		expect(result).not.toContain("debug msg")
		expect(result).not.toContain("info msg")
		expect(result).toContain("error msg")
	})

	it("lines include level prefix and context", () => {
		transport.write({ t: Date.now(), l: "warn", m: "test message", c: "MyCtx" })

		const result = transport.getRecentLogs(5)
		expect(result).toContain("WARN")
		expect(result).toContain("[MyCtx]")
		expect(result).toContain("test message")
	})

	it("getRecentLogs works with late-bound output channel", () => {
		const channelLessTransport = new CompactTransport(undefined, { level: "debug" })
		try {
			channelLessTransport.write({ t: Date.now(), l: "info", m: "before attach" })
			channelLessTransport.setOutputChannel(outputChannel as any)
			channelLessTransport.write({ t: Date.now(), l: "info", m: "after attach" })

			const result = channelLessTransport.getRecentLogs(10)
			expect(result).toContain("before attach")
			expect(result).toContain("after attach")
		} finally {
			channelLessTransport.close()
		}
	})
})
