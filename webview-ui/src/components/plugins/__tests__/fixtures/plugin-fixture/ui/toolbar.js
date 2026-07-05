// Compiled UI bundle for the `fixture-ui` test plugin (P4 external UI).
//
// This is the *built* output shape a plugin author ships: an ESM module with
// `react`/`react/jsx-runtime` **externalized** — exactly what
// `esbuild --bundle --format=esm --external:react --external:react/jsx-runtime`
// (or Vite with those externals) emits. Its bare `react` imports resolve to the
// HOST React instance via the webview's import map at runtime (design §6.8); under
// vitest they resolve to the workspace React through Vite's module pipeline — the
// same shared-instance guarantee, so hooks work.
//
// Default-exports a React component taking a single `{ api: PluginUIApi }` prop.
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime"
import { useEffect, useState } from "react"

export default function ExternalToolbar({ api }) {
	const [reply, setReply] = useState("")
	// Round-trip: subscribe to inbound messages addressed to this plugin.
	useEffect(() => api.onMessage((m) => setReply(String(m))), [api])
	return _jsxs("div", {
		"data-testid": "ext-toolbar",
		children: [
			_jsx("span", { "data-testid": "ext-where", children: api.context.region }),
			_jsx("button", {
				"data-testid": "ext-send",
				onClick: () => api.postMessage({ hello: api.context.region }),
				children: "send",
			}),
			_jsx("span", { "data-testid": "ext-reply", children: reply }),
		],
	})
}
