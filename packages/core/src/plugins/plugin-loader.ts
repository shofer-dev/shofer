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
import { spawnSync } from "child_process"
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
 * Ensure a plugin's runtime dependencies are present AND match the current platform, doing a
 * clean `npm install` when they are not. This is the escape hatch for plugins shipped with
 * `node_modules` **baked for one platform** (see `shofer-plugins/build.sh`, which writes a
 * `.shofer-baked-arch` marker of `<platform>-<arch>`): on a matching host the baked deps are used
 * as-is (fast path, no network); on a different host — or when deps are simply missing — we
 * reinstall so the correct native binaries (`@temporalio/core-bridge`, `@swc/core-*`) are fetched.
 *
 * Fast, safe no-ops for the common cases: no `package.json`/no deps → return; `node_modules`
 * present and either baked for this arch or unmarked (host-installed, e.g. a workspace plugin or a
 * unit-test fixture) → return without touching anything. Only a real mismatch spawns `npm`.
 */
function ensurePluginDeps(pluginRoot: string): void {
	let pkg: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
	try {
		const pkgPath = path.join(pluginRoot, "package.json")
		if (!fs.existsSync(pkgPath)) return
		pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
	} catch {
		return
	}
	const depCount = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }).length
	if (depCount === 0) return

	const nodeModules = path.join(pluginRoot, "node_modules")
	const marker = path.join(pluginRoot, ".shofer-baked-arch")
	const current = `${process.platform}-${process.arch}`
	const haveNodeModules = fs.existsSync(nodeModules)
	const bakedFor = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : ""

	// Present + (baked for us OR host-installed/unmarked) → use as-is.
	if (haveNodeModules && (bakedFor === "" || bakedFor === current)) return

	// Mismatch or missing → (re)install. A baked-for-another-arch tree is pruned to that arch's
	// native binaries, so wipe it first for a clean, correct install.
	const reason = !haveNodeModules ? "dependencies not installed" : `deps baked for ${bakedFor}, running on ${current}`
	if (haveNodeModules) {
		try {
			fs.rmSync(nodeModules, { recursive: true, force: true })
		} catch {
			/* proceed; npm will reconcile */
		}
	}
	const res = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
		cwd: pluginRoot,
		encoding: "utf8",
		stdio: "pipe",
	})
	if (res.status !== 0) {
		const detail = (res.stderr || res.error?.message || `exit ${res.status}`).slice(0, 400)
		throw new Error(
			`plugin "${path.basename(pluginRoot)}": ${reason}, and the automatic \`npm install\` failed (${detail}). ` +
				`Run \`npm install\` in ${pluginRoot}.`,
		)
	}
	try {
		fs.writeFileSync(marker, current)
	} catch {
		/* marker is best-effort */
	}
}

/**
 * Names of a plugin's declared runtime dependencies (dependencies + optional + peer) that are
 * actually installed in its `node_modules`. These get externalized from the esbuild bundle and
 * resolved at runtime — so native/wasm packages don't have to be (and cannot be) inlined. A
 * declared-but-not-installed dep is left out, so it stays bundled (unchanged behavior).
 */
function installedRuntimeDeps(pluginDir: string, pluginNodeModules: string): string[] {
	try {
		const pkgPath = path.join(pluginDir, "package.json")
		if (!fs.existsSync(pkgPath)) return []
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
			dependencies?: Record<string, string>
			optionalDependencies?: Record<string, string>
			peerDependencies?: Record<string, string>
		}
		const names = new Set<string>([
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.optionalDependencies ?? {}),
			...Object.keys(pkg.peerDependencies ?? {}),
		])
		return [...names].filter((name) => fs.existsSync(path.join(pluginNodeModules, ...name.split("/"))))
	} catch {
		return []
	}
}

/**
 * Module-resolution roots for transpiling a plugin entry.
 *
 * A plugin's TS entry routinely imports the plugin SDK (`@shofer/types` — `defineCustomTool`,
 * the parameter-schema helper, the context types), and esbuild has to resolve it from
 * somewhere. Walking up from the plugin's own directory only works when the plugin sits
 * inside a tree that already has those packages installed — true for a repo checkout, false
 * for a plugin installed at a standalone path, which is how a deployed node runs one
 * (`/opt/shofer-plugins/<name>` symlinked into the global plugin scope). There the walk-up
 * finds nothing and the plugin fails to load with "Could not resolve @shofer/types".
 *
 * So resolve from the HOST's own installation. `extensionPath` means different things in
 * different hosts — in VS Code it is the extension ROOT (bundle at `<root>/dist`), while a
 * headless host points it straight AT the bundle (`shofer serve --extension <…>/src/dist`) —
 * so both shapes are probed rather than assuming one. Non-existent roots are dropped, so the
 * list is only ever paths that can actually answer a resolution.
 *
 * `process.cwd()` stays last: it is right for a dev run from the repo, but it is merely the
 * directory the process happened to start in, which is not a fact about where the host lives.
 */
export function hostNodePaths(extensionPath?: string): string[] {
	const roots: string[] = []
	for (const base of extensionPath ? [extensionPath, path.dirname(extensionPath)] : []) {
		roots.push(
			// The shipped plugin SDK: `<bundle>/plugin-sdk/node_modules`, reached either
			// directly (headless: extensionPath IS the bundle) or via `dist` (VS Code).
			path.join(base, "dist", "plugin-sdk", "node_modules"),
			path.join(base, "plugin-sdk", "node_modules"),
			// The host's own installed packages, for a source checkout.
			path.join(base, "node_modules"),
		)
	}
	roots.push(path.join(process.cwd(), "node_modules"))
	return roots.filter((dir, index) => roots.indexOf(dir) === index && fs.existsSync(dir))
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
		const defaultNodePaths = options.nodePaths ?? hostNodePaths(options.extensionPath)
		const nodePaths = fs.existsSync(pluginNodeModules) ? [pluginNodeModules, ...defaultNodePaths] : defaultNodePaths

		// Externalize the plugin's declared runtime dependencies that are actually installed in its
		// own node_modules, so esbuild does NOT try to bundle them. Native addons (`.node`), wasm,
		// and other non-bundlable packages (e.g. `@temporalio/*`, which pulls `@swc/wasm` + a native
		// core-bridge) simply cannot be inlined — attempting to fails the whole load. They are
		// `import()`ed at runtime from the plugin's node_modules instead. Deps NOT present in the
		// plugin's node_modules stay bundled, so self-contained plugins are unaffected.
		const externalDeps = fs.existsSync(pluginNodeModules)
			? installedRuntimeDeps(path.dirname(entry), pluginNodeModules)
			: []
		const externalPatterns = externalDeps.flatMap((d) => [d, `${d}/*`])

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
				external: [...NODE_BUILTIN_MODULES, ...externalPatterns],
				banner: COMMONJS_REQUIRE_BANNER,
			},
			options.extensionPath,
		)

		// ESM bare-specifier resolution walks up from the importing file. The cached bundle lives in
		// a temp dir with no node_modules, so link the plugin's installed deps next to it — that is
		// how the externalized `import("@temporalio/worker")` etc. resolve at runtime.
		if (externalDeps.length > 0) {
			const link = path.join(bundleDir, "node_modules")
			try {
				if (!fs.existsSync(link)) fs.symlinkSync(pluginNodeModules, link, "junction")
			} catch {
				/* best-effort; a failed link surfaces later as a clear MODULE_NOT_FOUND at import */
			}
		}
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

	// Make runtime deps present + arch-correct before transpiling — handles plugins shipped with
	// node_modules baked for one platform (and re-installs on a mismatching host). No-op for
	// plugins with no deps or host-installed deps.
	ensurePluginDeps(path.dirname(entry))

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
