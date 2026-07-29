import { governanceDisabledPlugins, governanceEnabledPlugins } from "../governance.js"

/**
 * The built-ins ship as bundled plugins, so an org suppressing them means exactly one
 * thing: those plugin names are force-disabled (`SHOFER_DISABLED_PLUGINS`). These specs
 * pin the parsing rules, because a list that silently reads as empty leaves an org's
 * users with modes the org meant to remove.
 */

describe("governanceDisabledPlugins", () => {
	const LIST_ENV = "SHOFER_DISABLED_PLUGINS"
	let saved: string | undefined

	beforeEach(() => {
		saved = process.env[LIST_ENV]
		delete process.env[LIST_ENV]
	})

	afterEach(() => {
		if (saved === undefined) delete process.env[LIST_ENV]
		else process.env[LIST_ENV] = saved
	})

	it("suppresses nothing when unset", () => {
		expect(governanceDisabledPlugins()).toEqual([])
	})

	it("accepts a comma-separated list, so any bundled plugin can be suppressed", () => {
		process.env[LIST_ENV] = "live-memory, builtin-config ,"
		expect(governanceDisabledPlugins()).toEqual(["live-memory", "builtin-config"])
	})

	it("passes feature-scoped entries through verbatim for the plugin to interpret", () => {
		// `basics:<feature>` matches no plugin name — PluginManager ignores it, and the
		// basics plugin reads the same variable to switch one feature off.
		process.env[LIST_ENV] = "basics:worktrees,basics:checkpoints"
		expect(governanceDisabledPlugins()).toEqual(["basics:worktrees", "basics:checkpoints"])
	})

	it("does not repeat a plugin named twice", () => {
		process.env[LIST_ENV] = "builtin-config,builtin-config"
		expect(governanceDisabledPlugins()).toEqual(["builtin-config"])
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
