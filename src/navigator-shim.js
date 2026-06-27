/**
 * navigator-shim — prepended (esbuild `banner`) to the Shofer extension-host
 * bundle so it runs before any bundled module evaluates.
 *
 * Newer VS Code / code-server expose `navigator` in the Node extension host as a
 * global whose property access throws a `PendingMigrationError` (flagging the
 * Node 22 migration; see https://aka.ms/vscode-extensions/navigator). Bundled
 * browser-oriented dependencies (pdf.js, exceljs, AWS smithy, react-use,
 * mermaid, …) feature-detect with `typeof navigator !== 'undefined' &&
 * navigator.userAgent` — which now passes the `typeof` check and then THROWS on
 * the property read, flooding activation with errors.
 *
 * Install a benign `navigator` once, before any bundled module runs, so those
 * reads succeed. No-op in a real browser/webview (where `navigator.userAgent`
 * already works) and degrades silently if the host's `navigator` is
 * non-configurable. Wrapped so it can never break activation.
 */
/* global process, require */
;(function () {
	try {
		var g = typeof globalThis !== "undefined" ? globalThis : this
		if (!g) return

		// Only act when reading navigator.userAgent throws (the VS Code migration
		// proxy). In a real browser/webview this read succeeds and we leave it be.
		var broken = false
		try {
			void (g.navigator && g.navigator.userAgent)
		} catch (e) {
			broken = true
		}
		if (!broken) return

		var cpus = 1
		try {
			cpus = (require("os").cpus() || []).length || 1
		} catch (e) {
			/* os unavailable — keep default */
		}

		var shim = {
			userAgent: "Shofer/node",
			platform: typeof process !== "undefined" && process.platform ? process.platform : "",
			language: "en-US",
			languages: ["en-US"],
			hardwareConcurrency: cpus,
			onLine: true,
		}

		try {
			Object.defineProperty(g, "navigator", {
				value: shim,
				configurable: true,
				writable: true,
				enumerable: false,
			})
		} catch (e) {
			try {
				g.navigator = shim
			} catch (e2) {
				/* non-configurable, non-writable — nothing more we can do */
			}
		}
	} catch (e) {
		/* never let the shim break activation */
	}
})()
