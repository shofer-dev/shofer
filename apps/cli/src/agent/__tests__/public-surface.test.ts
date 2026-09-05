// pnpm --filter @shofer/cli test src/agent/__tests__/public-surface.test.ts

import * as clientLibrary from "../client.js"
import * as agentIndex from "../index.js"

/**
 * `src/agent/client.ts` is the `@shofer/cli/client` entry point and
 * `src/agent/index.ts` is the internal agent barrel. Both are re-export-only, so
 * the thing worth asserting is that every name they promise actually resolves —
 * a renamed symbol upstream turns into an `undefined` export, not a build error.
 */

describe("@shofer/cli/client barrel", () => {
	it("exports the client, store and processor", () => {
		expect(typeof clientLibrary.ExtensionClient).toBe("function")
		expect(typeof clientLibrary.createClient).toBe("function")
		expect(typeof clientLibrary.createMockClient).toBe("function")
		expect(typeof clientLibrary.StateStore).toBe("function")
		expect(typeof clientLibrary.MessageProcessor).toBe("function")
		expect(typeof clientLibrary.parseExtensionMessage).toBe("function")
	})

	it("exports the event system and the state-transition helpers", () => {
		expect(typeof clientLibrary.TypedEventEmitter).toBe("function")
		expect(typeof clientLibrary.Observable).toBe("function")
		for (const helper of [
			clientLibrary.isSignificantStateChange,
			clientLibrary.transitionedToWaiting,
			clientLibrary.transitionedToRunning,
			clientLibrary.streamingStarted,
			clientLibrary.streamingEnded,
			clientLibrary.taskCompleted,
		]) {
			expect(typeof helper).toBe("function")
		}
	})

	it("exports the agent loop state enum", () => {
		expect(clientLibrary.AgentLoopState.NO_TASK).toBe("no_task")
	})
})

describe("agent barrel", () => {
	it("re-exports the host, the JSON emitter and the approval posture", () => {
		expect(typeof agentIndex.ExtensionHost).toBe("function")
		expect(typeof agentIndex.JsonEventEmitter).toBe("function")
		expect(typeof agentIndex.defaultApprovalSeed).toBe("function")
		expect(typeof agentIndex.unattendedApprovalSeed).toBe("function")
	})
})
