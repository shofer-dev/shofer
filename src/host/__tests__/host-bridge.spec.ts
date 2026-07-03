import { describe, it, expect, afterEach } from "vitest"
import { createInMemoryHost, RecordingNotifier, type HostBridge } from "@shofer/types"

import { getHost, setHost } from "../host-bridge"

/**
 * §9 host accessor. Verifies the swappable host bridge — a test/CLI host can be
 * installed and is what `getHost()` returns (the seam migrated call sites use).
 */
describe("host-bridge accessor", () => {
	afterEach(() => setHost(createInMemoryHost()))

	it("defaults to an in-memory host", () => {
		expect(getHost().notifier).toBeDefined()
		expect(getHost().fs).toBeDefined()
	})

	it("returns the installed host and routes notifications through it", () => {
		const notifier = new RecordingNotifier()
		const base = createInMemoryHost()
		const host: HostBridge = {
			notifier,
			fs: base.fs,
			config: base.config,
			env: base.env,
			lsp: base.lsp,
			workspace: base.workspace,
			watcher: base.watcher,
			terminals: base.terminals,
			external: base.external,
			editor: base.editor,
			createDiffView: base.createDiffView,
		}
		setHost(host)
		getHost().notifier.info("hello")
		getHost().notifier.error("oops")
		expect(notifier.messages).toEqual([
			{ level: "info", message: "hello" },
			{ level: "error", message: "oops" },
		])
	})
})
