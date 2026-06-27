/**
 * navigator-shim — prepended (esbuild `banner`) to the top of the Shofer
 * extension-host CJS bundle.
 *
 * Newer VS Code / code-server install `navigator` in the Node extension host as
 * a **non-configurable** global getter that throws `PendingMigrationError` on
 * property access (Node 22 migration; https://aka.ms/vscode-extensions/navigator).
 * Bundled browser-oriented deps (pdf.js, exceljs, AWS smithy, react-use,
 * mermaid, …) feature-detect via `typeof navigator !== 'undefined' &&
 * navigator.userAgent`, which now passes the `typeof` check and then THROWS,
 * flooding activation with errors.
 *
 * Because the global is non-configurable, `Object.defineProperty`/assignment
 * can't replace it. Instead we declare a module-scoped `navigator` at the top of
 * the bundle: every bundled dependency's *bare* `navigator` reference resolves
 * to this benign object via lexical scope, and we never touch (or trigger) the
 * throwing global. Node-ext-host only — the webview is a separate bundle.
 */
/* global process, require */
var navigator = (function () {
	var cpus = 1
	try {
		cpus = (require("os").cpus() || []).length || 1
	} catch (e) {
		/* os unavailable — keep default */
	}
	return {
		userAgent: "Shofer/node",
		platform: typeof process !== "undefined" && process.platform ? process.platform : "",
		language: "en-US",
		languages: ["en-US"],
		hardwareConcurrency: cpus,
		onLine: true,
	}
})()
