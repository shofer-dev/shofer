/**
 * Types for the pre-bundled `ignore` copy in `ignore.mjs` (see `build-ui.mjs` for why
 * it is vendored). The bundle re-exports the real package's default export, so the
 * declarations simply forward to it (resolved via the tsconfig `paths` mapping).
 */

export { default } from "ignore"
export * from "ignore"
