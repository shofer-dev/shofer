import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { getHost, setHost, createInMemoryHost, RecordingNotifier } from "@shofer/types"

import { parseScopeSettings, readScopeSettingsFile, SCOPE_SETTINGS_FILE } from "../layered-settings-file.js"

/**
 * The reader's contract: an invalid VALUE costs you that key, not the file, and
 * never costs you it silently.
 *
 * Both fixtures below are real defects. `defaultCostLimit.maxUsd: 0` and
 * `maxConsecutiveApiFailures: 0` are each the natural spelling of "no limit" for
 * a field whose schema is `z.number().positive()` / `z.number().int().min(1)`,
 * and each one used to discard every OTHER setting the file carried — including,
 * in the org-global scope, the restrictions the org had set. The pairing of
 * assertions in every case here is deliberate: the good keys survive AND the
 * operator is told.
 */
describe("parseScopeSettings", () => {
	it("returns every key of a clean document", () => {
		const parsed = parseScopeSettings(JSON.stringify({ autoApprovalEnabled: true, writeDelayMs: 500 }))
		expect(parsed.settings).toEqual({ autoApprovalEnabled: true, writeDelayMs: 500 })
		expect(parsed.rejected).toEqual([])
		expect(parsed.voidedReason).toBeUndefined()
	})

	it("keeps the file when defaultCostLimit.maxUsd is 0 and drops only that key", () => {
		const parsed = parseScopeSettings(
			JSON.stringify({
				defaultCostLimit: { maxUsd: 0, action: "pause" },
				autoApprovalEnabled: false,
				alwaysAllowWrite: false,
			}),
		)
		expect(parsed.settings).toEqual({ autoApprovalEnabled: false, alwaysAllowWrite: false })
		expect(parsed.settings).not.toHaveProperty("defaultCostLimit")
		expect(parsed.rejected.map((r) => r.key)).toEqual(["defaultCostLimit"])
		expect(parsed.voidedReason).toBeUndefined()
	})

	it("keeps the file when maxConsecutiveApiFailures is 0 and drops only that key", () => {
		const parsed = parseScopeSettings(
			JSON.stringify({ maxConsecutiveApiFailures: 0, customInstructions: "be terse" }),
		)
		expect(parsed.settings).toEqual({ customInstructions: "be terse" })
		expect(parsed.rejected.map((r) => r.key)).toEqual(["maxConsecutiveApiFailures"])
	})

	it("drops several bad keys in one read", () => {
		const parsed = parseScopeSettings(
			JSON.stringify({
				maxConsecutiveApiFailures: 0,
				writeDelayMs: -1,
				settingsWriteScope: "org",
				alwaysAllowReadOnly: true,
			}),
		)
		expect(parsed.settings).toEqual({ alwaysAllowReadOnly: true })
		expect(parsed.rejected.map((r) => r.key).sort()).toEqual([
			"maxConsecutiveApiFailures",
			"settingsWriteScope",
			"writeDelayMs",
		])
	})

	it("reports the reason, including the nested path", () => {
		const parsed = parseScopeSettings(JSON.stringify({ defaultCostLimit: { maxUsd: 0, action: "pause" } }))
		expect(parsed.rejected[0]?.reason).toContain("defaultCostLimit.maxUsd")
	})

	it("still strips unknown keys silently — a newer Shofer's key is not an error", () => {
		const parsed = parseScopeSettings(JSON.stringify({ somethingAddedLater: 1, alwaysAllowMcp: true }))
		expect(parsed.settings).toEqual({ alwaysAllowMcp: true })
		expect(parsed.rejected).toEqual([])
	})

	it("voids the layer when the file is not JSON", () => {
		const parsed = parseScopeSettings("{ not json")
		expect(parsed.settings).toEqual({})
		expect(parsed.voidedReason).toContain("not valid JSON")
	})

	it("voids the layer when the top level is not an object", () => {
		for (const text of ["[]", '"nope"', "42", "null"]) {
			const parsed = parseScopeSettings(text)
			expect(parsed.settings).toEqual({})
			expect(parsed.voidedReason).toContain("not a JSON object")
		}
	})
})

describe("readScopeSettingsFile", () => {
	let dir: string
	let notifier: RecordingNotifier

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-scope-"))
		notifier = new RecordingNotifier()
		setHost({ ...createInMemoryHost(), notifier })
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	const write = (contents: unknown) =>
		fs.writeFile(path.join(dir, SCOPE_SETTINGS_FILE), JSON.stringify(contents), "utf8")

	it("returns {} silently for an absent scope", async () => {
		expect(await readScopeSettingsFile(dir)).toEqual({})
		expect(await readScopeSettingsFile(undefined)).toEqual({})
		expect(notifier.messages).toEqual([])
	})

	it("reads a clean file without notifying", async () => {
		await write({ alwaysAllowWrite: true })
		expect(await readScopeSettingsFile(dir)).toEqual({ alwaysAllowWrite: true })
		expect(notifier.messages).toEqual([])
	})

	// The whole point of (b): the org's other settings survive, and a human is
	// told, where previously the layer vanished in silence.
	it("keeps the good keys and reports the bad one as an error", async () => {
		await write({ maxConsecutiveApiFailures: 0, alwaysAllowWrite: false })

		expect(await readScopeSettingsFile(dir)).toEqual({ alwaysAllowWrite: false })

		expect(notifier.messages).toHaveLength(1)
		expect(notifier.messages[0]?.level).toBe("error")
		expect(notifier.messages[0]?.message).toContain("maxConsecutiveApiFailures")
		expect(notifier.messages[0]?.message).toContain(SCOPE_SETTINGS_FILE)
		expect(notifier.messages[0]?.message).toContain("The rest of the file is in effect")
	})

	it("reports a wholly unreadable file as such", async () => {
		await fs.writeFile(path.join(dir, SCOPE_SETTINGS_FILE), "{ nope", "utf8")

		expect(await readScopeSettingsFile(dir)).toEqual({})
		expect(notifier.messages[0]?.message).toContain("ignored ALL of")
	})

	it("does not re-notify while the same problem persists", async () => {
		await write({ maxConsecutiveApiFailures: 0 })
		await readScopeSettingsFile(dir)
		await readScopeSettingsFile(dir)
		await readScopeSettingsFile(dir)
		expect(notifier.messages).toHaveLength(1)
	})

	it("notifies again when the problem changes, and forgets it once fixed", async () => {
		await write({ maxConsecutiveApiFailures: 0 })
		await readScopeSettingsFile(dir)

		await write({ writeDelayMs: -5 })
		await readScopeSettingsFile(dir)
		expect(notifier.messages).toHaveLength(2)

		await write({ writeDelayMs: 5 })
		await readScopeSettingsFile(dir)
		expect(notifier.messages).toHaveLength(2)

		await write({ writeDelayMs: -5 })
		await readScopeSettingsFile(dir)
		expect(notifier.messages).toHaveLength(3)
	})

	it("uses the installed host's notifier", async () => {
		await write({ maxConsecutiveApiFailures: 0 })
		await readScopeSettingsFile(dir)
		expect(getHost().notifier).toBe(notifier)
	})
})
