/**
 * apply_patch tool module
 *
 * A stripped-down, file-oriented diff format designed to be easy to parse and safe to apply.
 * Based on the Codex apply_patch specification.
 */

export { parsePatch, ParseError } from "./parser.js"
export type { Hunk, UpdateFileChunk, ApplyPatchArgs } from "./parser.js"

export { seekSequence } from "./seek-sequence.js"

export { applyChunksToContent, processHunk, processAllHunks, ApplyPatchError } from "./apply.js"
export type { ApplyPatchFileChange } from "./apply.js"
