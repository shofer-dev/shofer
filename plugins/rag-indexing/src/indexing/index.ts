// The parser engine moved to @shofer/core; re-export its public surface so existing
// `./processors` consumers keep working unchanged.
export { CodeParser, codeParser } from "../engine/processors/parser.js"
export * from "./scanner"
export * from "./file-watcher"
