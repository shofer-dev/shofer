// Host-shared `react-dom/client` shim (design §6.8, P4). Exposes the HOST's
// createRoot/hydrateRoot for completeness; a plugin UI component normally renders
// within the host tree and does not create its own root. See `react.js`.
const NS = globalThis.__shoferHostReactDomClient
const R = (NS && NS.default) || NS

export default R
export const createRoot = R.createRoot
export const hydrateRoot = R.hydrateRoot
