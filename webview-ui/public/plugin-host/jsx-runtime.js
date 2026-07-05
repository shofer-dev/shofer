// Host-shared `react/jsx-runtime` shim (design §6.8, P4). A plugin UI bundle built
// with the automatic JSX runtime emits `import { jsx as _jsx } from "react/jsx-runtime"`
// with `react/jsx-runtime` externalized; the webview import map resolves it here so
// the plugin's JSX is created by the HOST React instance. See `react.js` for the why.
const NS = globalThis.__shoferHostJsxRuntime
const R = (NS && NS.default) || NS

export const Fragment = R.Fragment
export const jsx = R.jsx
export const jsxs = R.jsxs
