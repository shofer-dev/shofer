import { describe, it, expect, afterEach } from "vitest"

import {
	adoptSharedPluginManager,
	getSharedPluginManager,
	releaseSharedPluginManager,
	setSharedPluginManager,
	type PluginManager,
} from "../plugin-manager.js"

/**
 * Ownership of the process-wide plugin-manager slot.
 *
 * A host may have several live managers at once — VS Code builds a SECOND
 * `ShoferProvider` for "Shofer in a new tab", and each provider builds its own. The
 * slot holds whichever installed last, so disposal must not assume the disposing owner
 * is the only one. It did assume that, and the consequence was severe and silent:
 * closing a Shofer tab emptied the slot while the sidebar's manager was still running,
 * and since Shofer's own modes ship as the bundled `builtin-config` plugin, every mode
 * enumeration from that point saw no plugins — the built-in modes vanished from the
 * mode selector, and `CustomModesManager` persisted the reduced list. These specs pin
 * the two halves of the contract that make that impossible.
 */

const manager = (name: string) => ({ name }) as unknown as PluginManager

describe("shared plugin manager ownership", () => {
	afterEach(() => setSharedPluginManager(undefined))

	describe("releaseSharedPluginManager", () => {
		it("hands the slot to the successor instead of emptying it", () => {
			const sidebar = manager("sidebar")
			const tab = manager("tab")
			setSharedPluginManager(sidebar)
			setSharedPluginManager(tab) // the tab provider installed last, so it owns the slot

			releaseSharedPluginManager(tab, sidebar)

			expect(getSharedPluginManager()).toBe(sidebar)
		})

		it("empties the slot when the host has no other manager", () => {
			const only = manager("only")
			setSharedPluginManager(only)

			releaseSharedPluginManager(only, undefined)

			expect(getSharedPluginManager()).toBeUndefined()
		})

		it("leaves the slot alone when it points at someone else", () => {
			// The reverse disposal order: the sidebar goes away while the tab, which
			// installed after it, is still serving. Releasing must not disturb the owner.
			const sidebar = manager("sidebar")
			const tab = manager("tab")
			setSharedPluginManager(tab)

			releaseSharedPluginManager(sidebar, undefined)

			expect(getSharedPluginManager()).toBe(tab)
		})
	})

	describe("adoptSharedPluginManager", () => {
		it("claims an empty slot", () => {
			const sidebar = manager("sidebar")

			adoptSharedPluginManager(sidebar)

			expect(getSharedPluginManager()).toBe(sidebar)
		})

		it("never steals the slot from the current owner", () => {
			const tab = manager("tab")
			const sidebar = manager("sidebar")
			setSharedPluginManager(tab)

			adoptSharedPluginManager(sidebar)

			expect(getSharedPluginManager()).toBe(tab)
		})

		it("heals a slot that a released manager left empty", () => {
			// The end-to-end shape of the bug: tab installs, tab closes with no successor
			// known, and the next caller that already holds a live manager re-asserts it.
			const sidebar = manager("sidebar")
			const tab = manager("tab")
			setSharedPluginManager(sidebar)
			setSharedPluginManager(tab)
			releaseSharedPluginManager(tab, undefined)
			expect(getSharedPluginManager()).toBeUndefined()

			adoptSharedPluginManager(sidebar)

			expect(getSharedPluginManager()).toBe(sidebar)
		})
	})
})
