import * as path from "path"

import { governanceDisabledPlugins, governanceEnabledPlugins, governancePluginDirs } from "../governance.js"

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

/**
 * Delivery: the directories a host provisioned plugin code into. These exist because
 * every standard plugin root is writable by the person a mandated plugin may be
 * constraining, so the parsing rules matter for the same reason the two above do —
 * a list that silently reads as empty means the org's plugin is simply not there,
 * and nothing says so.
 */
describe("governancePluginDirs", () => {
	const LIST_ENV = "SHOFER_PLUGIN_DIRS"
	let saved: string | undefined

	beforeEach(() => {
		saved = process.env[LIST_ENV]
		delete process.env[LIST_ENV]
	})

	afterEach(() => {
		if (saved === undefined) delete process.env[LIST_ENV]
		else process.env[LIST_ENV] = saved
	})

	it("scans nothing beyond the standard roots when unset", () => {
		expect(governancePluginDirs()).toEqual([])
	})

	it("accepts a delimiter-separated list, tolerating spacing and empties", () => {
		process.env[LIST_ENV] = ["/opt/shofer-plugins", " /etc/shofer/plugins ", ""].join(path.delimiter)
		expect(governancePluginDirs()).toEqual(["/opt/shofer-plugins", "/etc/shofer/plugins"])
	})

	it("preserves order, because discovery is last-wins on a name collision", () => {
		process.env[LIST_ENV] = ["/etc/shofer/plugins", "/opt/shofer-plugins"].join(path.delimiter)
		expect(governancePluginDirs()).toEqual(["/etc/shofer/plugins", "/opt/shofer-plugins"])
	})

	it("drops a relative entry rather than resolving it against the process cwd", () => {
		// Resolving it would silently name a different directory depending on where the
		// host was started — and silently discovering nothing is the failure this
		// variable exists to prevent.
		process.env[LIST_ENV] = ["plugins", "./plugins", "/opt/shofer-plugins"].join(path.delimiter)
		expect(governancePluginDirs()).toEqual(["/opt/shofer-plugins"])
	})

	it("does not repeat a directory listed twice", () => {
		process.env[LIST_ENV] = ["/opt/shofer-plugins", "/opt/shofer-plugins"].join(path.delimiter)
		expect(governancePluginDirs()).toEqual(["/opt/shofer-plugins"])
	})
})
