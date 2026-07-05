// Host-shared `react/jsx-dev-runtime` shim (design §6.8, P4). Same role as
// `jsx-runtime.js` but for dev builds, which emit `jsxDEV`. See `react.js`.
const NS = globalThis.__shoferHostJsxDevRuntime
const R = (NS && NS.default) || NS

export const Fragment = R.Fragment
export const jsxDEV = R.jsxDEV
