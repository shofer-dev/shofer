// Ambient declarations for non-code assets imported for their side effects.
// Next.js resolves these at build time via its own loaders, but `tsc`
// type-checking (our `check-types` step) needs a module declaration so a
// side-effect import like `import "./globals.css"` type-checks.
declare module "*.css"
