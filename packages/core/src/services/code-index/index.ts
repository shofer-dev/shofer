// Public surface of the portable code-index engine (embedders, interfaces,
// vector-store, parser, shared helpers, constants, state manager). The
// vscode-coupled orchestration layer (CodeIndexManager, orchestrator, scanner,
// file-watcher, service-factory, config-manager, search-service, git source)
// remains in the `shofer` extension (src/services/code-index) and imports this
// engine from the `@shofer/core` barrel.
export * from "./constants/index.js"
export * from "./interfaces/index.js"
// `IndexingState` is also declared in interfaces/manager.ts (identical union); take
// it from there and export only the class from state-manager to avoid an ambiguous
// star re-export.
export { CodeIndexStateManager } from "./state-manager.js"
export * from "./shared/get-relative-path.js"
export * from "./shared/retry.js"
export * from "./shared/validation-helpers.js"
export * from "./shared/git-ignore-filter.js"
export * from "./shared/supported-extensions.js"
export * from "./vector-store/qdrant-client.js"
export * from "./processors/parser.js"
export * from "./embedders/openai.js"
export * from "./embedders/openai-compatible.js"
export * from "./embedders/openrouter.js"
export * from "./embedders/gemini.js"
export * from "./embedders/mistral.js"
export * from "./embedders/bedrock.js"
export * from "./embedders/ollama.js"
export * from "./embedders/vercel-ai-gateway.js"
export * from "./embedders/serialized-embedder.js"
export * from "./embedders/embedder-lane.js"
