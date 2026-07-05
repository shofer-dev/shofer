/**
 * plugin-loader — load a code plugin's `main` entry into a {@link ShoferPlugin}
 * (design §7 "Code loading"; Phase 2, step 2.1).
 *
 * A code plugin ships a `main` entry (`.ts`/`.tsx`/`.js`/`.mjs`). This module
 * transpiles TypeScript via the **same** `esbuild-runner` path custom tools use
 * ({@link runEsbuild}) and dynamic-imports the result, then extracts and validates
 * the exported `ShoferPlugin` object. It enforces the plugin-API version contract
 * (owner decision: refuse an incompatible plugin at load) before any code runs
 * that could touch the host.
 *
 * This is the *mechanism*; orchestration (which enabled plugins to load, building
 * the sandboxed {@link PluginContext}, and registering into `pluginRegistry`) lives
 * in {@link PluginManager} (step 2.5). Node-only — it lives in `@shofer/core`, not
 * `@shofer/types`, so the browser-safe types package never pulls in esbuild/`node:*`.
 */

import fs from "fs"
import path from "path"
import os from "os"
import { createHash } from "crypto"
import { pathToFileURL } from "url"

import { PLUGIN_API_VERSION, isPluginApiCompatible, type ShoferPlugin } from "@shofer/types"

import { runEsbuild, NODE_BUILTIN_MODULES, COMMONJS_REQUIRE_BANNER } from "../custom-tools/esbuild-runner.js"

/** File extensions that are dynamic-imported directly (no transpile step). */
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"])
/** File extensions transpiled via esbuild before import. */
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"])

/** The minimal, structural view of a discovered plugin the loader needs. */
export interface PluginCodeSource {
	/** Manifest plugin name — the loaded module's `name` must match this. */
	name: string
	/** Absolute plugin root directory. */
	root: string
	/** Entry point relative to {@link root} (manifest `main`). */
	main: string
	/** Declared target plugin-API version (manifest `shoferPluginApiVersion`), if any. */
	apiVersion?: string
}

export interface PluginCodeLoaderOptions {
	/** Path to the extension root (locates the bundled esbuild binary in production). */
	extensionPath?: string
	/** Directory for cached transpiled bundles. Defaults to an OS-temp subdir. */
	cacheDir?: string
	/** Extra module-resolution paths for the plugin's dependencies. */
	nodePaths?: string[]
	/** Host plugin-API version to validate against (defaults to {@link PLUGIN_API_VERSION}). */
	hostApiVersion?: string
}

/**
 * Loader seam consumed by {@link PluginManager}. A `undefined` loader means the
 * manager skips code loading entirely (byte-for-byte identical to no plugins).
 * The Node implementation is {@link createNodePluginCodeLoader}.
 */
export interface PluginCodeLoader {
	load(source: PluginCodeSource): Promise<ShoferPlugin>
}

/** Whether `value` structurally conforms to {@link ShoferPlugin} (a string `name`). */
function isShoferPlugin(value: unknown): value is ShoferPlugin {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { name?: unknown }).name === "string" &&
		(value as { name: string }).name.length > 0
	)
}

/**
 * Pick the `ShoferPlugin` out of a loaded module. Prefers the default export
 * (design §7: "the plugin's default export must be a `ShoferPlugin` object");
 * falls back to a named export whose `name` matches the manifest, then to the
 * module namespace itself (for `export const name = ...` style entries).
 */
function extractPlugin(mod: Record<string, unknown>, expectedName: string): ShoferPlugin | undefined {
	const def = mod.default
	if (isShoferPlugin(def)) return def
	for (const value of Object.values(mod)) {
		if (isShoferPlugin(value) && value.name === expectedName) return value
	}
	if (isShoferPlugin(mod)) return mod
	return undefined
}

/**
 * Transpile (if TypeScript) and dynamic-import a plugin entry file, returning the
 * module namespace. Mirrors `CustomToolRegistry.import()`: TS is esbuild-bundled to
 * a content-addressed cache file (Node built-ins external, deps bundled with a
 * CommonJS `require` shim), JS is imported directly.
 */
async function importEntry(entry: string, options: PluginCodeLoaderOptions): Promise<Record<string, unknown>> {
	const ext = path.extname(entry).toLowerCase()

	if (JS_EXTENSIONS.has(ext)) {
		return (await import(pathToFileURL(entry).href)) as Record<string, unknown>
	}

	if (!TS_EXTENSIONS.has(ext)) {
		throw new Error(`unsupported plugin entry extension "${ext}" (expected .ts/.tsx/.js/.mjs)`)
	}

	const stat = fs.statSync(entry)
	const cacheDir = options.cacheDir ?? path.join(os.tmpdir(), "shofer-plugins-cache")
	const hash = createHash("sha256").update(`${entry}:${stat.mtimeMs}`).digest("hex").slice(0, 16)
	const bundleDir = path.join(cacheDir, hash)
	const bundle = path.join(bundleDir, "plugin.mjs")

	if (!fs.existsSync(bundle)) {
		fs.mkdirSync(bundleDir, { recursive: true })
		const pluginNodeModules = path.join(path.dirname(entry), "node_modules")
		const defaultNodePaths = options.nodePaths ?? [path.join(process.cwd(), "node_modules")]
		const nodePaths = fs.existsSync(pluginNodeModules) ? [pluginNodeModules, ...defaultNodePaths] : defaultNodePaths
		await runEsbuild(
			{
				entryPoint: entry,
				outfile: bundle,
				format: "esm",
				platform: "node",
				target: "node18",
				bundle: true,
				sourcemap: "inline",
				packages: "bundle",
				nodePaths,
				external: NODE_BUILTIN_MODULES,
				banner: COMMONJS_REQUIRE_BANNER,
			},
			options.extensionPath,
		)
	}

	return (await import(pathToFileURL(bundle).href)) as Record<string, unknown>
}

/**
 * Load a single code plugin's entry into a validated {@link ShoferPlugin}.
 *
 * Order (fail-closed): (1) enforce the plugin-API version contract before running
 * any plugin code; (2) resolve the entry inside the plugin root (reject escapes);
 * (3) transpile+import; (4) extract the exported plugin and verify its `name`
 * matches the manifest. Throws a descriptive `Error` on any failure — the caller
 * ({@link PluginManager}) turns that into a shown+logged warning and disables the
 * plugin without crashing activation.
 */
export async function loadPluginFromEntry(
	source: PluginCodeSource,
	options: PluginCodeLoaderOptions = {},
): Promise<ShoferPlugin> {
	const hostApiVersion = options.hostApiVersion ?? PLUGIN_API_VERSION
	if (source.apiVersion !== undefined && !isPluginApiCompatible(source.apiVersion, hostApiVersion)) {
		throw new Error(
			`plugin "${source.name}" targets plugin API ${source.apiVersion}, incompatible with host ${hostApiVersion}`,
		)
	}

	if (!source.main) {
		throw new Error(`plugin "${source.name}" has no code entry (main)`)
	}

	const entry = path.resolve(source.root, source.main)
	const rootResolved = path.resolve(source.root)
	if (entry !== rootResolved && !entry.startsWith(rootResolved + path.sep)) {
		throw new Error(`plugin "${source.name}" entry "${source.main}" escapes the plugin directory`)
	}
	if (!fs.existsSync(entry)) {
		throw new Error(`plugin "${source.name}" entry not found: ${entry}`)
	}

	const mod = await importEntry(entry, options)
	const plugin = extractPlugin(mod, source.name)
	if (!plugin) {
		throw new Error(`plugin "${source.name}" entry does not export a ShoferPlugin object`)
	}
	if (plugin.name !== source.name) {
		throw new Error(
			`plugin "${source.name}" entry exports a plugin named "${plugin.name}" (manifest name mismatch)`,
		)
	}
	return plugin
}

/** A {@link PluginCodeLoader} backed by esbuild + Node dynamic import. */
export function createNodePluginCodeLoader(options: PluginCodeLoaderOptions = {}): PluginCodeLoader {
	return {
		load: (source: PluginCodeSource) => loadPluginFromEntry(source, options),
	}
}
