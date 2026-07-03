/**
 * Host-agnostic surface for the Category II `SkillsManager` (VS Code `src`).
 *
 * Unlike the code-index / git-index / live-memory managers (workspace-keyed
 * singletons reached via a factory), the `SkillsManager` is **per-provider**:
 * `ShoferProvider` constructs one and hands it out via
 * `TaskProviderLike.getSkillsManager()`. It therefore flows to the core-resident
 * callers (`system.ts`, the `skills` prompt section) as a parameter, and needs no
 * global registry — only this portable interface so those callers stop importing
 * the concrete class.
 */
import type { SkillMetadata, SkillContent } from "@shofer/types"

/**
 * The narrow slice of the concrete `SkillsManager` the portable core reads:
 * mode-filtered skill discovery (system-prompt section) and skill-content lookup
 * (the `skills` / `run_slash_command` tools). `getSkillContent` mirrors the
 * `SkillLookup` shape so a `SkillsManagerLike` can be passed wherever a
 * `SkillLookup` is expected.
 */
export interface SkillsManagerLike {
	getSkillsForMode(currentMode: string): SkillMetadata[]
	getSkillContent(name: string, currentMode?: string): Promise<SkillContent | null>
}
