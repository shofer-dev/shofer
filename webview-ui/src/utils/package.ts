// Build-time app/build identity for the WEBVIEW browser bundle.
//
// The Node core exposes a host-provided `Package` (backed by `getHost().env.appInfo`,
// i.e. the real VS Code extension `package.json`). The webview has no such host — its
// in-memory host returns defaults (name "shofer", version "0.0.0") — so instead we
// bake the real identity in at build time via Vite `define` (see webview-ui/vite.config.ts,
// which reads the extension's package.json + git SHA + latest CHANGELOG entry). This
// mirrors the pre-carve-out `src/shared/package.ts` mechanism.
export const Package = {
	publisher: process.env.PKG_PUBLISHER,
	name: process.env.PKG_NAME || "shofer",
	version: process.env.PKG_VERSION || "0.0.0",
	outputChannel: process.env.PKG_OUTPUT_CHANNEL || "Shofer",
	sha: process.env.PKG_SHA,
	// Latest CHANGELOG.md entry, injected by the webview build (see vite.config.ts).
	changelog: process.env.PKG_CHANGELOG,
} as const
