// Thin re-export shim. The implementations were relocated to `@shofer/core`
// (`fs/fs.ts`) during the Task-cluster carve-out so the host-agnostic core can
// own them. Non-SCC `src` consumers (and the many `vi.mock("../utils/fs")`
// test walls) keep importing from here unchanged.
export { createDirectoriesForFile, fileExistsAtPath } from "@shofer/core"
