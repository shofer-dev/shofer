import { describe, it, expect, vi } from "vitest"

import { TypedEmitter } from "../emitter.js"

describe("TypedEmitter (host-agnostic vscode.EventEmitter drop-in)", () => {
	it("delivers fired values to every subscriber", () => {
		const e = new TypedEmitter<number>()
		const a = vi.fn()
		const b = vi.fn()
		e.event(a)
		e.event(b)
		e.fire(7)
		expect(a).toHaveBeenCalledWith(7)
		expect(b).toHaveBeenCalledWith(7)
	})

	it("stops delivering after the subscription is disposed", () => {
		const e = new TypedEmitter<string>()
		const cb = vi.fn()
		const sub = e.event(cb)
		e.fire("a")
		sub.dispose()
		e.fire("b")
		expect(cb).toHaveBeenCalledTimes(1)
		expect(cb).toHaveBeenCalledWith("a")
	})

	it("binds thisArgs and collects into a disposables array", () => {
		const e = new TypedEmitter<number>()
		const bag: Array<{ dispose(): void }> = []
		const ctx = { total: 0 }
		e.event(
			function (this: typeof ctx, n) {
				this.total += n
			},
			ctx,
			bag,
		)
		e.fire(3)
		expect(ctx.total).toBe(3)
		expect(bag).toHaveLength(1)
	})

	it("dispose() drops all listeners", () => {
		const e = new TypedEmitter<void>()
		const cb = vi.fn()
		e.event(cb)
		e.dispose()
		e.fire()
		expect(cb).not.toHaveBeenCalled()
	})

	it("a listener that subscribes mid-dispatch does not receive the in-flight value", () => {
		const e = new TypedEmitter<number>()
		const late = vi.fn()
		e.event(() => {
			e.event(late)
		})
		e.fire(1)
		expect(late).not.toHaveBeenCalled()
		e.fire(2)
		expect(late).toHaveBeenCalledWith(2)
	})
})
