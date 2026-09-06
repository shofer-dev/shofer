import type { Anthropic } from "@anthropic-ai/sdk"

import { FakeAIHandler } from "../fake-ai.js"

/**
 * `FakeAIHandler` exists to solve one problem, and the tests are about that
 * problem rather than about delegation: provider settings round-trip through
 * `globalState`, so the `fakeAi` object a NEW task is constructed with is a
 * structurally-identical copy that has lost every closure and every bit of
 * accumulated state. The handler therefore keys a module-level map on the
 * object's `id` and always uses the FIRST instance it saw — which is what makes
 * a scripted fake behave consistently across the tasks of one session.
 */

function makeFakeAi(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		createMessage: vi.fn(async function* () {
			yield { type: "text", text: `from ${id}` }
		}),
		getModel: vi.fn(() => ({ id: `${id}-model`, info: { contextWindow: 1000 } })),
		countTokens: vi.fn(async () => 42),
		completePrompt: vi.fn(async () => `completed by ${id}`),
		...overrides,
	}
}

const USER: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hi" }]

describe("FakeAIHandler", () => {
	it("refuses to construct without a fake AI", () => {
		expect(() => new FakeAIHandler({} as never)).toThrow("Fake AI is not set")
	})

	it("delegates every method to the supplied fake", async () => {
		const fake = makeFakeAi("delegating")
		const handler = new FakeAIHandler({ fakeAi: fake } as never)

		const chunks: unknown[] = []
		for await (const c of handler.createMessage("sys", USER, { taskId: "t" } as never)) chunks.push(c)

		expect(chunks).toEqual([{ type: "text", text: "from delegating" }])
		expect(fake.createMessage).toHaveBeenCalledWith("sys", USER, { taskId: "t" })
		expect(handler.getModel().id).toBe("delegating-model")
		expect(await handler.countTokens([])).toBe(42)
		expect(await handler.completePrompt("q")).toBe("completed by delegating")
	})

	it("keeps the FIRST instance seen for an id, so a deserialized copy does not replace it", async () => {
		const original = makeFakeAi("shared")
		new FakeAIHandler({ fakeAi: original } as never)

		// What a second task actually receives: the same id, a different object.
		const deserializedCopy = makeFakeAi("shared")
		const second = new FakeAIHandler({ fakeAi: deserializedCopy } as never)

		expect(await second.completePrompt("q")).toBe("completed by shared")
		expect(original.completePrompt).toHaveBeenCalled()
		expect(deserializedCopy.completePrompt).not.toHaveBeenCalled()
	})

	it("hands the cached fake a way to evict itself", async () => {
		const original = makeFakeAi("evictable") as ReturnType<typeof makeFakeAi> & { removeFromCache?: () => void }
		new FakeAIHandler({ fakeAi: original } as never)

		expect(typeof original.removeFromCache).toBe("function")
		original.removeFromCache!()

		// After eviction the next copy becomes the cached one.
		const replacement = makeFakeAi("evictable")
		const handler = new FakeAIHandler({ fakeAi: replacement } as never)
		await handler.completePrompt("q")

		expect(replacement.completePrompt).toHaveBeenCalled()
	})
})
