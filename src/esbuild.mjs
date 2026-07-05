import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import process from "node:process"
import { execSync } from "node:child_process"
import * as console from "node:console"

import { copyPaths, copyWasms } from "@shofer/build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Directory/file names never shipped into a packaged plugin (dev-only cruft). */
const PLUGIN_COPY_EXCLUDE_DIRS = new Set(["node_modules", "__tests__"])
const PLUGIN_COPY_EXCLUDE_FILES = new Set(["tsconfig.json", "vitest.config.ts", "build-ui.mjs"])
const PLUGIN_COPY_EXCLUDE_EXT = new Set([".tsx"]) // built .js ships; .tsx source doesn't.

/**
 * Recursively copy the first-party plugins tree into the packaged output, skipping
 * dev-only cruft. Runtime needs each plugin's `plugin.json`, its `main` .ts sources
 * (the code loader transpiles them at load), built UI bundles (`ui/panel.js`), and
 * the skills/commands markdown — everything except {@link PLUGIN_COPY_EXCLUDE_DIRS}
 * / {@link PLUGIN_COPY_EXCLUDE_FILES} / {@link PLUGIN_COPY_EXCLUDE_EXT}.
 */
function copyBundledPlugins(srcRoot, dstRoot) {
	if (!fs.existsSync(srcRoot)) {
		console.warn(`[esbuild] No plugins dir to bundle at ${srcRoot} — skipping.`)
		return
	}
	let count = 0
	const walk = (src, dst) => {
		fs.mkdirSync(dst, { recursive: true })
		for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (PLUGIN_COPY_EXCLUDE_DIRS.has(entry.name)) continue
				walk(path.join(src, entry.name), path.join(dst, entry.name))
			} else if (entry.isFile()) {
				if (PLUGIN_COPY_EXCLUDE_FILES.has(entry.name)) continue
				if (PLUGIN_COPY_EXCLUDE_EXT.has(path.extname(entry.name))) continue
				fs.copyFileSync(path.join(src, entry.name), path.join(dst, entry.name))
				count++
			}
		}
	}
	walk(srcRoot, dstRoot)
	console.log(`[esbuild] Copied ${count} bundled-plugin files to ${dstRoot}`)
}

async function main() {
	const name = "extension"
	const production = process.argv.includes("--production")
	const watch = process.argv.includes("--watch")
	const minify = production
	const sourcemap = !production // Only in dev/watch; production VSIX doesn't ship maps.

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const buildOptions = {
		bundle: true,
		minify,
		sourcemap,
		logLevel: "silent",
		format: "cjs",
		sourcesContent: false,
		platform: "node",
	}

	const srcDir = __dirname
	const buildDir = __dirname
	const distDir = path.join(buildDir, "dist")

	if (fs.existsSync(distDir)) {
		console.log(`[${name}] Cleaning dist directory: ${distDir}`)
		fs.rmSync(distDir, { recursive: true, force: true })
	}

	/**
	 * @type {import('esbuild').Plugin[]}
	 */
	const plugins = [
		{
			name: "copyFiles",
			setup(build) {
				build.onEnd(() => {
					copyPaths(
						[
							["../README.md", "README.md"],
							["../CHANGELOG.md", "CHANGELOG.md"],
							["../LICENSE", "LICENSE"],
							["../.env", ".env", { optional: true }],
							["node_modules/vscode-material-icons/generated", "assets/vscode-material-icons"],
							["../webview-ui/audio", "webview-ui/audio"],
						],
						srcDir,
						buildDir,
					)
					// Copy built-in .slang workflows so discoverWorkflows() finds them at runtime.
					// They go into dist/media/workflows/, which is bundled into the VSIX.
					// discoverWorkflows() resolves __dirname + "/media/workflows" at runtime.
					const workflowsDest = path.join(distDir, "media", "workflows")
					fs.mkdirSync(workflowsDest, { recursive: true })
					fs.copyFileSync(
						path.join(srcDir, "media", "workflows", "debug.slang"),
						path.join(workflowsDest, "debug.slang"),
					)
					fs.copyFileSync(
						path.join(srcDir, "media", "workflows", "implement-feature.slang"),
						path.join(workflowsDest, "implement-feature.slang"),
					)
					// Copy the sandbox wrapper binary so it is available
					// alongside the extension bundle in dist/.  The binary is
					// a prebuilt Go artifact at src/sandbox/shofer-sandbox.
					// Build the sandbox wrapper from Go source (no prebuilt binary
					// committed to git).  Requires `go` on $PATH; fails the build
					// if compilation doesn't succeed so the packaging step never
					// ships an extension without the binary.
					const sandboxDir = path.join(srcDir, "sandbox")
					const sandboxSrc = path.join(sandboxDir, "main.go")
					const sandboxBin = path.join(sandboxDir, "shofer-sandbox")
					const sandboxDestDir = path.join(distDir, "sandbox")
					const sandboxDest = path.join(sandboxDestDir, "shofer-sandbox")

					try {
						execSync("go build -o shofer-sandbox .", {
							cwd: sandboxDir,
							env: { ...process.env, GOWORK: "off", CGO_ENABLED: "0" },
							stdio: "pipe",
						})
					} catch (err) {
						console.error(
							`[esbuild] ERROR: failed to build shofer-sandbox: ${err.message}`,
						)
						process.exit(1)
					}

					if (!fs.existsSync(sandboxBin)) {
						console.error(
							`[esbuild] ERROR: shofer-sandbox not found after build at ${sandboxBin}`,
						)
						process.exit(1)
					}

					fs.mkdirSync(sandboxDestDir, { recursive: true })
					fs.copyFileSync(sandboxBin, sandboxDest)
					fs.chmodSync(sandboxDest, 0o755)
					copyPaths(
						[
							["core/webview/slang-render.js", "slang-render.js"],
							["core/webview/slang-render.css", "slang-render.css"],
							["node_modules/dagre/dist/dagre.min.js", "dagre.min.js"],
						],
						srcDir,
						distDir,
					)
					// Ship the esbuild-wasm CLI so the runtime loader can transpile
					// TypeScript at `<extensionPath>/dist/bin/esbuild` (the production
					// path in custom-tools/esbuild-runner.ts getEsbuildScriptPath). This
					// is what custom tools AND bundled code plugins (e.g. the live-memory
					// plugin, transpiled at activation) rely on — without it the loader
					// falls back to node_modules, which isn't resolvable from the bundled
					// CJS extension host. The wasm shim resolves `../esbuild.wasm` and
					// `../wasm_exec_node.js` relative to itself, and that in turn
					// `require("./wasm_exec")`, so the wasm blob and both Go loader
					// scripts must sit one level up, at the dist/ root.
					const esbuildWasmDir = path.join(srcDir, "node_modules", "esbuild-wasm")
					const esbuildBinDest = path.join(distDir, "bin")
					fs.mkdirSync(esbuildBinDest, { recursive: true })
					fs.copyFileSync(
						path.join(esbuildWasmDir, "bin", "esbuild"),
						path.join(esbuildBinDest, "esbuild"),
					)
					fs.copyFileSync(
						path.join(esbuildWasmDir, "esbuild.wasm"),
						path.join(distDir, "esbuild.wasm"),
					)
					fs.copyFileSync(
						path.join(esbuildWasmDir, "wasm_exec_node.js"),
						path.join(distDir, "wasm_exec_node.js"),
					)
					fs.copyFileSync(
						path.join(esbuildWasmDir, "wasm_exec.js"),
						path.join(distDir, "wasm_exec.js"),
					)
					// Ship the first-party (bundled) plugins tree into dist/plugins so the
					// runtime resolves it at `<extensionPath>/dist/plugins` (design §7 —
					// bundled scope). Mirrors the tree-sitter-wasm copy above. The P2 code
					// loader transpiles each plugin's `main` (e.g. main.ts) at runtime, so the
					// .ts SOURCES must ship — we copy everything except dev-only cruft
					// (node_modules, __tests__, tsconfig/vitest/build scripts, .tsx sources
					// whose built .js is already present).
					copyBundledPlugins(path.join(srcDir, "..", "plugins"), path.join(distDir, "plugins"))
				})
			},
		},
		{
			name: "copyWasms",
			setup(build) {
				build.onEnd(() => copyWasms(srcDir, distDir))
			},
		},
		{
			name: "esbuild-problem-matcher",
			setup(build) {
				build.onStart(() => console.log("[esbuild-problem-matcher#onStart]"))
				build.onEnd((result) => {
					result.errors.forEach(({ text, location }) => {
						console.error(`✘ [ERROR] ${text}`)
						if (location && location.file) {
							console.error(`    ${location.file}:${location.line}:${location.column}:`)
						}
					})

					console.log("[esbuild-problem-matcher#onEnd]")
				})
			},
		},
	]

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const extensionConfig = {
		...buildOptions,
		plugins,
		entryPoints: ["extension.ts"],
		outfile: "dist/extension.js",
		// Prepend the navigator shim so it runs before any bundled module evaluates
		// (neutralizes VS Code's throwing `navigator` proxy in the Node ext host;
		// see navigator-shim.js).
		banner: { js: fs.readFileSync(path.join(__dirname, "navigator-shim.js"), "utf8") },
		// global-agent must be external because it dynamically patches Node.js http/https modules
		// which breaks when bundled. It needs access to the actual Node.js module instances.
		// undici must be bundled because our VSIX is packaged with `--no-dependencies`.
		external: ["vscode", "esbuild", "global-agent"],
	}

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	// Phase 1 worker modules (server-worker, agent-worker, worker-extension-host)
	// are compiled by vitest/tsc for tests; they are NOT bundled into dist/ yet.
	// They will be added as entry points before Phase 2 spawns actual worker_threads
	// (see docs/multi_threaded.md §9 "esbuild entry points").
	const workerConfig = {
		...buildOptions,
		entryPoints: ["workers/countTokens.ts", "workers/exportJson.ts"],
		outdir: "dist/workers",
	}

	const [extensionCtx, workerCtx] = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(workerConfig),
	])

	if (watch) {
		await Promise.all([extensionCtx.watch(), workerCtx.watch()])
	} else {
		await Promise.all([extensionCtx.rebuild(), workerCtx.rebuild()])
		await Promise.all([extensionCtx.dispose(), workerCtx.dispose()])
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
