// Host-shared `react-dom` shim (design §6.8, P4). Provided so a plugin UI bundle
// that pulls in a lib importing `react-dom` reuses the HOST instance. Plugin
// components render inside the host tree (no own root), so this is a convenience
// surface, not a mounting API. See `react.js` for the shared-instance rationale.
const NS = globalThis.__shoferHostReactDom
const R = (NS && NS.default) || NS

export default R
export const createPortal = R.createPortal
export const flushSync = R.flushSync
export const version = R.version
