import { describe, it, expect } from "vitest"

import { ContextWindow, estimateTokens } from "../context-window"
import type { AgentMessage, FileContextEntry } from "@shofer/types"

const MS = 1
const makeMessage = (role: AgentMessage["role"], content: string, ts = MS): AgentMessage => ({
	id: `${role}-${ts}`,
	role,
	content,
	timestamp: ts,
})

const makeFile = (filePath: string, tokens: number, lastRef = MS): FileContextEntry => ({
	filePath,
	contentHash: "h",
	tokenEstimate: tokens,
	loadedAt: lastRef,
	lastReferencedAt: lastRef,
})

describe("ContextWindow", () => {
	describe("token estimation", () => {
		it("estimates 1 token per ~4 characters", () => {
			expect(estimateTokens("")).toBe(0)
			expect(estimateTokens("abcd")).toBe(1)
			expect(estimateTokens("a".repeat(40))).toBe(10)
		})

		it("sums message + file context tokens", () => {
			const cw = new ContextWindow({ maxContextTokens: 1000 })
			cw.appendMessage(makeMessage("user", "x".repeat(40))) // 10 tokens
			cw.upsertFileContext(makeFile("a.ts", 25))
			expect(cw.estimatedTokenCount).toBe(35)
		})
	})

	describe("isNearlyFull", () => {
		it("is true once estimated tokens exceed threshold * max", () => {
			const cw = new ContextWindow({ maxContextTokens: 100, contextFillThreshold: 0.5 })
			cw.upsertFileContext(makeFile("a.ts", 40))
			expect(cw.isNearlyFull).toBe(false)
			cw.upsertFileContext(makeFile("b.ts", 20))
			expect(cw.isNearlyFull).toBe(true)
		})
	})

	describe("upsertFileContext", () => {
		it("inserts a new entry", () => {
			const cw = new ContextWindow()
			cw.upsertFileContext(makeFile("a.ts", 10))
			expect(cw.fileContextPaths).toEqual(["a.ts"])
		})

		it("refreshes hash + lastReferencedAt for an existing entry", () => {
			const cw = new ContextWindow()
			cw.upsertFileContext(makeFile("a.ts", 10, 100))
			cw.upsertFileContext({
				filePath: "a.ts",
				contentHash: "newhash",
				tokenEstimate: 12,
				loadedAt: 100,
				lastReferencedAt: 200,
			})
			expect(cw.fileContexts.length).toBe(1)
			expect(cw.fileContexts[0].contentHash).toBe("newhash")
			expect(cw.fileContexts[0].lastReferencedAt).toBe(200)
			expect(cw.fileContexts[0].tokenEstimate).toBe(12)
		})
	})

	describe("invalidateFileContext", () => {
		it("clears the content hash so the next load detects staleness", () => {
			const cw = new ContextWindow()
			cw.upsertFileContext(makeFile("a.ts", 10))
			cw.invalidateFileContext("a.ts")
			expect(cw.fileContexts[0].contentHash).toBe("")
		})
	})

	describe("enforceLimit", () => {
		it("evicts least-recently-referenced file contexts first", () => {
			const cw = new ContextWindow({ maxContextTokens: 50 })
			cw.upsertFileContext(makeFile("old.ts", 30, 100))
			cw.upsertFileContext(makeFile("new.ts", 30, 200))
			cw.enforceLimit()
			expect(cw.fileContextPaths).toEqual(["new.ts"])
			expect(cw.consumeEvictedTokens()).toBe(30)
		})

		it("evicts message pairs once no file contexts remain", () => {
			const cw = new ContextWindow({ maxContextTokens: 5 })
			cw.appendMessage(makeMessage("user", "u1".repeat(20)))
			cw.appendMessage(makeMessage("assistant", "a1".repeat(20)))
			cw.appendMessage(makeMessage("user", "u2".repeat(2))) // small, kept
			cw.appendMessage(makeMessage("assistant", "a2".repeat(2)))
			cw.enforceLimit()
			// Oldest pair evicted
			expect(cw.messages.map((m) => m.role)).toEqual(["user", "assistant"])
			expect(cw.consumeEvictedTokens()).toBeGreaterThan(0)
		})

		it("does not infinitely loop when only the system pair remains", () => {
			const cw = new ContextWindow({ maxContextTokens: 1 })
			cw.appendMessage(makeMessage("user", "x".repeat(20)))
			cw.appendMessage(makeMessage("assistant", "y".repeat(20)))
			cw.enforceLimit() // would loop forever in a buggy impl
			expect(cw.messages.length).toBe(2)
		})
	})

	describe("consumeEvictedTokens", () => {
		it("returns and resets the accumulated total", () => {
			const cw = new ContextWindow({ maxContextTokens: 10 })
			cw.upsertFileContext(makeFile("a.ts", 50))
			cw.enforceLimit()
			expect(cw.consumeEvictedTokens()).toBe(50)
			expect(cw.consumeEvictedTokens()).toBe(0)
		})
	})

	describe("clear / restore", () => {
		it("clear empties messages + file contexts", () => {
			const cw = new ContextWindow()
			cw.appendMessage(makeMessage("user", "hi"))
			cw.upsertFileContext(makeFile("a.ts", 10))
			cw.clear()
			expect(cw.messages.length).toBe(0)
			expect(cw.fileContexts.length).toBe(0)
		})

		it("restore replaces state with copies of the inputs", () => {
			const cw = new ContextWindow()
			const msg = makeMessage("user", "hi")
			const file = makeFile("a.ts", 10)
			cw.restore([msg], [file])
			expect(cw.messages).toEqual([msg])
			expect(cw.fileContexts).toEqual([file])
		})
	})
})
