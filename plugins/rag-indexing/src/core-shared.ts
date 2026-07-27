/**
 * The handful of **pure** modules this plugin borrows from `@shofer/core` at BUILD time.
 *
 * Everything else the indexer needs came with it when it left core. These did not,
 * because they are genuinely shared with the rest of the product and duplicating them
 * would mean maintaining two copies that must not drift:
 *
 * | Borrowed                     | Also used by                                          |
 * | ---------------------------- | ----------------------------------------------------- |
 * | tree-sitter loader + queries | `list_code_definition_names`, `lsp_search` (62 MB of grammars ship once) |
 * | the embedding-model catalog  | the provider settings UI, the Vercel AI Gateway fetcher |
 * | `.gitmodules` discovery      | the system-prompt's workspace description              |
 * | `listFiles` / ignore rules   | the file tools, the environment details                |
 *
 * **This is a build-time coupling, not a runtime one.** `build-ui.mjs` bundles these into
 * `main.mjs`, so the shipped plugin has no dependency on `@shofer/core` at all — the same
 * arrangement that lets the checkpoints plugin bundle `simple-git`. What it does mean is
 * that this plugin builds *inside this repository*; a third-party plugin doing the same
 * job would vendor its own parser and model table.
 *
 * One module rather than deep relative paths at thirty call sites: the coupling is a thing
 * to keep an eye on, so it should be visible in one file rather than smeared across the
 * plugin.
 */

export {
	loadRequiredLanguageParsers,
	type LanguageParser,
} from "../../../packages/core/src/services/tree-sitter/languageParser.js"
export { parseMarkdown } from "../../../packages/core/src/services/tree-sitter/markdownParser.js"
export { extensions } from "../../../packages/core/src/services/tree-sitter/index.js"
export {
	getDefaultModelId,
	getModelDimension,
	getModelQueryPrefix,
	getModelScoreThreshold,
} from "../../../packages/core/src/shared/embeddingModels.js"
export { listSubmoduleDisplayPaths } from "../../../packages/core/src/utils/git-submodules.js"
export { listFiles } from "../../../packages/core/src/services/glob/list-files.js"
export { isPathInIgnoredDirectory } from "../../../packages/core/src/services/glob/ignore-utils.js"
export { ShoferIgnoreController } from "../../../packages/core/src/ignore/ShoferIgnoreController.js"
export { safeWriteJson } from "../../../packages/core/src/utils/safeWriteJson.js"
export { getWorkspacePathForContext } from "../../../packages/core/src/path/path.js"
