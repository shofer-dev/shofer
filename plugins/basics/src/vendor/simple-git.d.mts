/**
 * Types for the pre-bundled `simple-git` copy in `simple-git.mjs` (see `build-ui.mjs`
 * for why it is vendored). The bundle re-exports the real package's surface, so the
 * declarations simply forward to it (resolved via the tsconfig `paths` mapping).
 */

export * from "simple-git"
