import { Plugin } from "vite"
import fs from "fs"
import path from "path"

/**
 * Custom Vite plugin to normalize source maps for the VSCode webview context.
 *
 * Vite builds with `sourcemap: "hidden"` — source maps are emitted to disk but
 * no `sourceMappingURL` comment is added to JS files.  This avoids Chrome
 * preloading the maps and emitting "preloaded but not used" warnings.
 *
 * This plugin post-processes the emitted `.map` files to fix up `sourceRoot`
 * and `sources` paths so the maps work when loaded manually for debugging.
 */
export function sourcemapPlugin(): Plugin {
	return {
		name: "vite-plugin-sourcemap",
		apply: "build",

		closeBundle: {
			order: "post",
			handler: async () => {
				console.log("Normalizing source maps for VSCode webview...")

				const mode = process.env.NODE_ENV
				const outDir =
					mode === "nightly"
						? path.resolve("../apps/vscode-nightly/build/webview-ui/build")
						: path.resolve("../src/webview-ui/build")

				const assetsDir = path.join(outDir, "assets")

				if (!fs.existsSync(assetsDir)) {
					console.warn("Assets directory not found:", assetsDir)
					return
				}

				const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"))

				for (const jsFile of jsFiles) {
					const mapPath = path.join(assetsDir, jsFile + ".map")
					if (!fs.existsSync(mapPath)) continue

					try {
						const mapContent = JSON.parse(fs.readFileSync(mapPath, "utf8"))

						// Ensure the sourceRoot is set correctly for VSCode webview
						if (!mapContent.sourceRoot) {
							mapContent.sourceRoot = ""
						}

						// Make sure "sources" paths are relative
						if (mapContent.sources) {
							mapContent.sources = mapContent.sources.map((source: string) => source.replace(/^\//, ""))
						}

						// Write back the normalized source map (compact, not pretty-printed)
						fs.writeFileSync(mapPath, JSON.stringify(mapContent))
					} catch (error) {
						console.error(`Error processing source map for ${jsFile}:`, error)
					}
				}

				console.log("Source map normalization complete")
			},
		},
	}
}
