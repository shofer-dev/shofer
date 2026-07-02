// Each provider caching module exports an `addCacheBreakpoints` with the same name.
// Re-export them under distinct, provider-qualified names so the flat `@shofer/core`
// barrel can expose all four without a name collision (which `export *` would silently drop).
export { addCacheBreakpoints as addAnthropicCacheBreakpoints } from "./anthropic.js"
export { addCacheBreakpoints as addGeminiCacheBreakpoints } from "./gemini.js"
export { addCacheBreakpoints as addVertexCacheBreakpoints } from "./vertex.js"
export { addCacheBreakpoints as addVercelAiGatewayCacheBreakpoints } from "./vercel-ai-gateway.js"
