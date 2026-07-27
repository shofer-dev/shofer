import { governanceDisabledPlugins, governanceEnabledPlugins } from "../governance.js"

/**
 * The built-ins ship as bundled plugins, so an org suppressing them means exactly one
 * thing: those plugin names are force-disabled. These specs pin the env → plugin-name
 * mapping and the truthiness rules, because a flag that silently reads as "off" leaves
 * an org's users with modes the org meant to remove.
 */

describe("governanceDisabledPlugins", () => {
	const MODES_ENV = "SHOFER_DISABLE_BUILTIN_MODES"
	const WORKFLOWS_ENV = "SHOFER_DISABLE_BUILTIN_WORKFLOWS"
	const LIST_ENV = "SHOFER_DISABLED_PLUGINS"

	const saved: Record<string, string | undefined> = {}

	beforeEach(() => {
		for (const key of [MODES_ENV, WORKFLOWS_ENV, LIST_ENV]) {
			saved[key] = process.env[key]
			delete process.env[key]
		}
	})

	afterEach(() => {
		for (const key of [MODES_ENV, WORKFLOWS_ENV, LIST_ENV]) {
			if (saved[key] === undefined) delete process.env[key]
			else process.env[key] = saved[key]
		}
	})

	it("suppresses nothing when unset", () => {
		expect(governanceDisabledPlugins()).toEqual([])
	})

	it.each(["1", "true", "TRUE", "yes", "on", " True ", "On"])("treats %j as truthy", (value) => {
		process.env[MODES_ENV] = value
		expect(governanceDisabledPlugins()).toEqual(["builtin-modes"])
	})

	it.each(["0", "false", "no", "off", "", "disabled", "2"])("treats %j as falsy", (value) => {
		process.env[MODES_ENV] = value
		expect(governanceDisabledPlugins()).toEqual([])
	})

	it("maps each flag to its own plugin, independently", () => {
		process.env[WORKFLOWS_ENV] = "1"
		expect(governanceDisabledPlugins()).toEqual(["builtin-workflows"])

		process.env[MODES_ENV] = "1"
		expect(governanceDisabledPlugins()).toEqual(["builtin-workflows", "builtin-modes"])
	})

	it("accepts an arbitrary list, so any bundled plugin can be suppressed", () => {
		process.env[LIST_ENV] = "live-memory, checkpoints ,"
		expect(governanceDisabledPlugins()).toEqual(["live-memory", "checkpoints"])
	})

	it("does not repeat a plugin named by both a flag and the list", () => {
		process.env[MODES_ENV] = "1"
		process.env[LIST_ENV] = "builtin-modes"
		expect(governanceDisabledPlugins()).toEqual(["builtin-modes"])
	})
})

/**
 * Activation is how a pod that was PROVISIONED with a plugin comes up running it — no
 * Plugins panel, no seeded per-host state. `defaultEnabled` cannot express it (bundled
 * scope only), so this env flag is the only lever, and a flag that silently reads as
 * "off" means a workspace that registers as no runner at all.
 */
describe("governanceEnabledPlugins", () => {
	const LIST_ENV = "SHOFER_ENABLED_PLUGINS"
	let saved: string | undefined

	beforeEach(() => {
		saved = process.env[LIST_ENV]
		delete process.env[LIST_ENV]
	})

	afterEach(() => {
		if (saved === undefined) delete process.env[LIST_ENV]
		else process.env[LIST_ENV] = saved
	})

	it("activates nothing when unset", () => {
		expect(governanceEnabledPlugins()).toEqual([])
	})

	it("accepts a comma-separated list, tolerating spacing and empties", () => {
		process.env[LIST_ENV] = "temporal-runner, shofer-mesh ,"
		expect(governanceEnabledPlugins()).toEqual(["temporal-runner", "shofer-mesh"])
	})

	it("does not repeat a name listed twice", () => {
		process.env[LIST_ENV] = "temporal-runner,temporal-runner"
		expect(governanceEnabledPlugins()).toEqual(["temporal-runner"])
	})
})
