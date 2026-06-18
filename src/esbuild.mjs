import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import process from "node:process"
import { execSync } from "node:child_process"
import * as console from "node:console"

import { copyPaths, copyWasms, copyLocales, setupLocaleWatcher } from "@shofer/build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
	const name = "extension"
	const production = process.argv.includes("--production")
	const watch = process.argv.includes("--watch")
	const minify = production
	const sourcemap = true // Always generate source maps for error handling.

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
			name: "copyLocales",
			setup(build) {
				build.onEnd(() => copyLocales(srcDir, distDir))
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
		copyLocales(srcDir, distDir)
		setupLocaleWatcher(srcDir, distDir)
	} else {
		await Promise.all([extensionCtx.rebuild(), workerCtx.rebuild()])
		await Promise.all([extensionCtx.dispose(), workerCtx.dispose()])
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
