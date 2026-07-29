/**
 * Test fixtures shared across the workspace's packages.
 *
 * Exported as `@shofer/core/fixtures` so `src/` and `webview-ui/` specs can assert
 * against the same values `packages/core`'s own specs use, instead of each keeping a
 * hand-copied duplicate that drifts.
 */

export { BUILTIN_MODES } from "./builtin-config.js"
