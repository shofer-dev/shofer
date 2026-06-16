import { Command } from "./commands"

interface BuiltInCommandDefinition {
	name: string
	description: string
	argumentHint?: string
	content: string
}

const BUILT_IN_COMMANDS: Record<string, BuiltInCommandDefinition> = {
	init: {
		name: "init",
		description: "Analyze codebase and create concise AGENTS.md files for AI assistants",
		content: `<task>
Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Code style guidelines including imports, formatting, types, naming conventions, error handling, etc.
</task>

<initialization>
  <purpose>
    Create (or update) a concise AGENTS.md file that enables immediate productivity for AI assistants.
    Focus ONLY on project-specific, non-obvious information that you had to discover by reading files.
    
    CRITICAL: Only include information that is:
    - Non-obvious (couldn't be guessed from standard practices)
    - Project-specific (not generic to the framework/language)
    - Discovered by reading files (config files, code patterns, custom utilities)
    - Essential for avoiding mistakes or following project conventions
    
    Usage notes:
    - The file you create will be given to agentic coding agents (such as yourself) that operate in this repository
    - Keep the main AGENTS.md concise - aim for about 20 lines, but use more if the project complexity requires it
    - If there's already an AGENTS.md, improve it
    - If there are Claude Code rules (in CLAUDE.md), Cursor rules (in .cursor/rules/ or .cursorrules), or Copilot rules (in .github/copilot-instructions.md), make sure to include them
    - Be sure to prefix the file with: "# AGENTS.md\\n\\nThis file provides guidance to agents when working with code in this repository."
  </purpose>
  
  <todo_list_creation>
    If the update_todo_list tool is available, create a todo list with these focused analysis steps:
    
    1. Check for existing AGENTS.md files
       CRITICAL - Check these EXACT paths IN THE PROJECT ROOT:
       - AGENTS.md (in project root directory)
       - .shofer/rules-code/AGENTS.md (relative to project root)
       - .shofer/rules-debug/AGENTS.md (relative to project root)
       - .shofer/rules-ask/AGENTS.md (relative to project root)
       - .shofer/rules-architect/AGENTS.md (relative to project root)
       
       IMPORTANT: All paths are relative to the project/workspace root, NOT system root!
       
       If ANY of these exist:
       - Read them thoroughly
       - CRITICALLY EVALUATE: Remove ALL obvious information
       - DELETE entries that are standard practice or framework defaults
       - REMOVE anything that could be guessed without reading files
       - Only KEEP truly non-obvious, project-specific discoveries
       - Then add any new non-obvious patterns you discover
       
       Also check for other AI assistant rules:
       - .cursorrules, CLAUDE.md, .roorules
       - .cursor/rules/, .github/copilot-instructions.md
    
    2. Identify stack
       - Language, framework, build tools
       - Package manager and dependencies
    
    3. Extract commands
       - Build, test, lint, run
       - Critical directory-specific commands
    
    4. Map core architecture
       - Main components and flow
       - Key entry points
    
    5. Document critical patterns
       - Project-specific utilities (that you discovered by reading code)
       - Non-standard approaches (that differ from typical patterns)
       - Custom conventions (that aren't obvious from file structure)
    
    6. Extract code style
       - From config files only
       - Key conventions
    
    7. Testing specifics
       - Framework and run commands
       - Directory requirements
    
    8. Compile/Update AGENTS.md files
       - If files exist: AGGRESSIVELY clean them up
         * DELETE all obvious information (even if it was there before)
         * REMOVE standard practices, framework defaults, common patterns
         * STRIP OUT anything derivable from file structure or names
         * ONLY KEEP truly non-obvious discoveries
         * Then add newly discovered non-obvious patterns
         * Result should be SHORTER and MORE FOCUSED than before
       - If creating new: Follow the non-obvious-only principle
       - Create mode-specific files in .shofer/rules-*/ directories (IN PROJECT ROOT)
       
    Note: If update_todo_list is not available, proceed with the analysis workflow directly without creating a todo list.
  </todo_list_creation>
</initialization>

<analysis_workflow>
  Follow the comprehensive analysis workflow to:
  
  1. **Discovery Phase**:
     CRITICAL - First check for existing AGENTS.md files at these EXACT locations IN PROJECT ROOT:
     - AGENTS.md (in project/workspace root)
     - .shofer/rules-code/AGENTS.md (relative to project root)
     - .shofer/rules-debug/AGENTS.md (relative to project root)
     - .shofer/rules-ask/AGENTS.md (relative to project root)
     - .shofer/rules-architect/AGENTS.md (relative to project root)
     
     IMPORTANT: The .shofer folder should be created in the PROJECT ROOT, not system root!
     
     If found, perform CRITICAL analysis:
     - What information is OBVIOUS and must be DELETED?
     - What violates the non-obvious-only principle?
     - What would an experienced developer already know?
     - DELETE first, then consider what to add
     - The file should get SHORTER, not longer
     
     Also find other AI assistant rules and documentation
     
  2. **Project Identification**: Identify language, stack, and build system
  3. **Command Extraction**: Extract and verify essential commands
  4. **Architecture Mapping**: Create visual flow diagrams of core processes
  5. **Component Analysis**: Document key components and their interactions
  6. **Pattern Analysis**: Identify project-specific patterns and conventions
  7. **Code Style Extraction**: Extract formatting and naming conventions
  8. **Security & Performance**: Document critical patterns if relevant
  9. **Testing Discovery**: Understand testing setup and practices
  10. **Example Extraction**: Find real examples from the codebase
</analysis_workflow>

<output_structure>
  <main_file>
    Create or deeply improve AGENTS.md with ONLY non-obvious information:
    
    If AGENTS.md exists:
    - FIRST: Delete ALL obvious information
    - REMOVE: Standard commands, framework defaults, common patterns
    - STRIP: Anything that doesn't require file reading to know
    - EVALUATE: Each line - would an experienced dev be surprised?
    - If not surprised, DELETE IT
    - THEN: Add only truly non-obvious new discoveries
    - Goal: File should be SHORTER and MORE VALUABLE
    
    Content should include:
    - Header: "# AGENTS.md\\n\\nThis file provides guidance to agents when working with code in this repository."
    - Build/lint/test commands - ONLY if they differ from standard package.json scripts
    - Code style - ONLY project-specific rules not covered by linter configs
    - Custom utilities or patterns discovered by reading the code
    - Non-standard directory structures or file organizations
    - Project-specific conventions that violate typical practices
    - Critical gotchas that would cause errors if not followed
    
    EXCLUDE obvious information like:
    - Standard npm/yarn commands visible in package.json
    - Framework defaults (e.g., "React uses JSX")
    - Common patterns (e.g., "tests go in __tests__ folders")
    - Information derivable from file extensions or directory names
    
    Keep it concise (aim for ~20 lines, but expand as needed for complex projects).
    Include existing AI assistant rules from CLAUDE.md, Cursor rules (.cursor/rules/ or .cursorrules), or Copilot rules (.github/copilot-instructions.md).
  </main_file>
  
  <mode_specific_files>
    Create or deeply improve mode-specific AGENTS.md files IN THE PROJECT ROOT.
    
    CRITICAL: For each of these paths (RELATIVE TO PROJECT ROOT), check if the file exists FIRST:
    - .shofer/rules-code/AGENTS.md (create .shofer in project root, not system root!)
    - .shofer/rules-debug/AGENTS.md (relative to project root)
    - .shofer/rules-ask/AGENTS.md (relative to project root)
    - .shofer/rules-architect/AGENTS.md (relative to project root)
    
    IMPORTANT: The .shofer directory must be created in the current project/workspace root directory,
    NOT at the system root (/) or home directory. All paths are relative to where the project is located.
    
    If files exist:
    - AGGRESSIVELY DELETE obvious information
    - Remove EVERYTHING that's standard practice
    - Strip out framework defaults and common patterns
    - Each remaining line must be surprising/non-obvious
    - Only then add new non-obvious discoveries
    - Files should become SHORTER, not longer
    
    Example structure (ALL IN PROJECT ROOT):
    \`\`\`
    project-root/
    ├── AGENTS.md                    # General project guidance
    ├── .shofer/                        # IN PROJECT ROOT, NOT SYSTEM ROOT!
    │   ├── rules-code/
    │   │   └── AGENTS.md           # Code mode specific instructions
    │   ├── rules-debug/
    │   │   └── AGENTS.md           # Debug mode specific instructions
    │   ├── rules-ask/
    │   │   └── AGENTS.md           # Ask mode specific instructions
    │   └── rules-architect/
    │       └── AGENTS.md           # Architect mode specific instructions
    ├── src/
    ├── package.json
    └── ... other project files
    \`\`\`
    
    .shofer/rules-code/AGENTS.md - ONLY non-obvious coding rules discovered by reading files:
    - Custom utilities that replace standard approaches
    - Non-standard patterns unique to this project
    - Hidden dependencies or coupling between components
    - Required import orders or naming conventions not enforced by linters
    
    Example of non-obvious rules worth documenting:
    \`\`\`
    # Project Coding Rules (Non-Obvious Only)
    - Always use safeWriteJson() from src/utils/ instead of JSON.stringify for file writes (prevents corruption)
    - API retry mechanism in src/api/providers/utils/ is mandatory (not optional as it appears)
    - Database queries MUST use the query builder in packages/evals/src/db/queries/ (raw SQL will fail)
    - Provider interface in packages/types/src/ has undocumented required methods
    - Test files must be in same directory as source for vitest to work (not in separate test folder)
    \`\`\`
    
    .shofer/rules-debug/AGENTS.md - ONLY non-obvious debugging discoveries:
    - Hidden log locations not mentioned in docs
    - Non-standard debugging tools or flags
    - Gotchas that cause silent failures
    - Required environment variables for debugging
    
    Example of non-obvious debug rules worth documenting:
    \`\`\`
    # Project Debug Rules (Non-Obvious Only)
    - Webview dev tools accessed via Command Palette > "Developer: Open Webview Developer Tools" (not F12)
    - IPC messages fail silently if not wrapped in try/catch in packages/ipc/src/
    - Production builds require NODE_ENV=production or certain features break without error
    - Database migrations must run from packages/evals/ directory, not root
    - Extension logs only visible in "Extension Host" output channel, not Debug Console
    \`\`\`
    
    .shofer/rules-ask/AGENTS.md - ONLY non-obvious documentation context:
    - Hidden or misnamed documentation
    - Counterintuitive code organization
    - Misleading folder names or structures
    - Important context not evident from file structure
    
    Example of non-obvious documentation rules worth documenting:
    \`\`\`
    # Project Documentation Rules (Non-Obvious Only)
    - "src/" contains VSCode extension code, not source for web apps (counterintuitive)
    - Provider examples in src/api/providers/ are the canonical reference (docs are outdated)
    - UI runs in VSCode webview with restrictions (no localStorage, limited APIs)
    - Package.json scripts must be run from specific directories, not root
    - Locales in root are for extension, webview-ui/src/i18n for UI (two separate systems)
    \`\`\`
    
    .shofer/rules-architect/AGENTS.md - ONLY non-obvious architectural constraints:
    - Hidden coupling between components
    - Undocumented architectural decisions
    - Non-standard patterns that must be followed
    - Performance bottlenecks discovered through investigation
    
    Example of non-obvious architecture rules worth documenting:
    \`\`\`
    # Project Architecture Rules (Non-Obvious Only)
    - Providers MUST be stateless - hidden caching layer assumes this
    - Webview and extension communicate through specific IPC channel patterns only
    - Database migrations cannot be rolled back - forward-only by design
    - React hooks required because external state libraries break webview isolation
    - Monorepo packages have circular dependency on types package (intentional)
    \`\`\`
  </mode_specific_files>
</output_structure>

<worktree_conventions>
  Ensure the project follows the embedded worktree convention:
  
  1. **Check .gitignore**: Verify that .shofer/worktrees/ is listed in .gitignore.
     If not, append .shofer/worktrees/ to .gitignore. This prevents worktree
     directories from being accidentally committed to the main repository.
     (Note: do NOT add .shofer/ itself to .gitignore — only .shofer/worktrees/.)
  
  2. **Worktree location convention**: All worktrees created via Shofer's
     worktree UI or the \`worktree\` tool (available in Orchestrator mode) are
     placed under workspaceroot/.shofer/worktrees/projectname-randomid/. This is
     auto-generated and not user-configurable.
  
  3. **Available slash commands**: The project has worktree management slash
     commands in .shofer/commands/ that assist with merging and cleanup:
     - merge-worktree-cleanup — merge a worktree branch + delete branch + remove worktree
     - rebase-worktree — rebase a worktree branch onto base
     - rebase-worktree-cleanup — rebase + fast-forward + delete branch + remove worktree
  
  4. **Orchestrator mode**: The built-in orchestrator mode has access to
     the \`worktree\` native tool for creating, listing, merging, and destroying
     worktrees programmatically. It does NOT have execute_command access.
</worktree_conventions>

<quality_criteria>
  - ONLY include non-obvious information discovered by reading files
  - Exclude anything that could be guessed from standard practices
  - Focus on gotchas, hidden requirements, and counterintuitive patterns
  - Include specific file paths when referencing custom utilities
  - Be extremely concise - if it's obvious, don't include it
  - Every line should prevent a potential mistake or confusion
  - Test: Would an experienced developer be surprised by this information?
  - If updating existing files: DELETE obvious info first, files should get SHORTER
  - Measure success: Is the file more concise and valuable than before?
</quality_criteria>

Remember: The goal is to create documentation that enables AI assistants to be immediately productive in this codebase, focusing on project-specific knowledge that isn't obvious from the code structure alone.`,
	},
	"migrate-from-roocode": {
		name: "migrate-from-roocode",
		description: "Rename legacy Roo-Code/Cline config files to Shofer equivalents",
		content: `<task>
Rename legacy Roo-Code and Cline configuration files in this project to their
Shofer equivalents. Do NOT modify file contents — only rename/move files and
directories. Create parent directories as needed.
</task>

<initialization>
	 <todo_list_creation>
	   If the update_todo_list tool is available, create a todo list with these steps:

	   1. Scan for legacy files at workspace root
	   2. Rename workspace-root files (.rooignore, .roomodes, .roorules*, .clinerules*, .shoferrules*, cline_mcp_settings.json)
	   3. Convert legacy file-based rules to directory-based (.roorules → .shofer/rules/)
	   4. Handle mode-specific rule files (.roorules-code → .shofer/rules-code/)
	   5. Handle legacy MCP config (cline_mcp_settings.json → .shofer/mcp.json)
	   6. Verify migration completeness
	 </todo_list_creation>
</initialization>

<migration_mapping>
	 <workspace_root_renames>
	   Rename these files at the workspace root (simple rename):

	   | Legacy                    | Modern             | Notes                                          |
	   |---------------------------|--------------------|------------------------------------------------|
	   | \`.rooignore\`            | \`shoferignore\`   | Ignore patterns for Shofer tools               |
	   | \`.roomodes\`             | \`shofer/shofermodes\`    | Custom mode definitions                        |
	 </workspace_root_renames>

	 <file_to_directory_migrations>
	   These legacy SINGLE FILE rules must become DIRECTORY-based.
	   For each: create the directory if it doesn't exist, then move the
	   legacy file into it as the first rule file.

	   <rules_to_rules_dir>
	     | Legacy                  | Modern                                     |
	     |-------------------------|--------------------------------------------|
	     | \`.roorules\`           | \`.shofer/rules/<original-filename>.md\`   |
	     | \`.clinerules\`         | \`.shofer/rules/<original-filename>.md\`   |
	     | \`.shoferrules\`        | \`.shofer/rules/<original-filename>.md\`   |

	     HOW: Create .shofer/rules/ directory. Move the legacy file INTO it
	     with a descriptive name (e.g., .roorules → .shofer/rules/roorules.md).
	     If .shofer/rules/ already exists with content, append the legacy
	     file's content as an additional rule file instead.
	   </rules_to_rules_dir>

	   <mode_rules_to_mode_dir>
	     Legacy mode-specific rule files use a SUFFIX pattern like
	     \`.roorules-{mode}\` where {mode} is one of: code, architect, ask,
	     debug, reviewer, search, opinion, browser, orchestrator.

	     | Legacy                     | Modern                                              |
	     |----------------------------|-----------------------------------------------------|
	     | \`.roorules-{mode}\`       | \`.shofer/rules-{mode}/<original-filename>.md\`     |
	     | \`.clinerules-{mode}\`     | \`.shofer/rules-{mode}/<original-filename>.md\`     |
	     | \`.shoferrules-{mode}\`    | \`.shofer/rules-{mode}/<original-filename>.md\`     |

	     HOW: For each legacy mode rules file, create .shofer/rules-{mode}/
	     directory and move the file into it. If the target directory already
	     has rules, add the legacy file alongside them.
	   </mode_rules_to_mode_dir>
	 </file_to_directory_migrations>

	 <mcp_config_migration>
	   | Legacy                      | Modern                  |
	   |-----------------------------|-------------------------|
	   | \`cline_mcp_settings.json\` | \`.shofer/mcp.json\`    |

	   The legacy format may use Claude-style MCP server entries without an
	   explicit \`"type"\` field. Shofer requires \`"type": "stdio"\` for all
	   command-based servers (see mcp.md for the full Shofer MCP schema).

	   HOW:
	   1. Read cline_mcp_settings.json with \`read_file\`
	   2. Parse the JSON — the top-level structure should have an \`"mcpServers"\`
	      key mapping server names to their config objects
	   3. For each server entry that has a \`"command"\` field but NO \`"type"\`
	      field, inject \`"type": "stdio"\` to make it Shofer-compatible
	   4. Wrap all servers under \`"mcpServers"\` key with \`"type"\` already
	      injected (Shofer's .shofer/mcp.json uses the same top-level format as
	      Claude's .mcp.json — \`{"mcpServers": {...}}\`)
	   5. Write to .shofer/mcp.json using \`write_to_file\`
	   6. If .shofer/mcp.json ALREADY exists, do NOT overwrite — instead save as
	      .shofer/mcp-migrated.json and advise the user to manually merge

	   Example conversion:
	     BEFORE (legacy):
	       {"mcpServers": {"my-tool": {"command": "node", "args": ["server.js"]}}}
	     AFTER (Shofer):
	       {"mcpServers": {"my-tool": {"type": "stdio", "command": "node", "args": ["server.js"]}}}
	 </mcp_config_migration>

	 <other_ai_assistant_files>
	   These files are NOT renamed but SHOULD be reported to the user
	   for manual review:

	   | File               | Suggestion                                       |
	   |--------------------|--------------------------------------------------|
	   | \`CLAUDE.md\`      | Merge relevant content into AGENTS.md            |
	   | \`.cursorrules\`   | Merge relevant content into AGENTS.md            |
	   | \`.cursor/rules/\` | Copy relevant rules into .shofer/rules/          |
	   | \`.windsurfrules\` | Merge relevant content into AGENTS.md            |
	 </other_ai_assistant_files>
</migration_mapping>

<execution_rules>
	 1. **Use the \`file\` tool** with \`subcommand="mv"\` for all renames
	    and moves — do NOT use \`execute_command\` with mv/cp/rm.
	    The \`file\` tool captures changes in the File Changes Panel.

	 2. **Create parent directories first** with \`create_directory\` before
	    moving files into them. Example: create .shofer/rules/ before
	    moving .roorules → .shofer/rules/roorules.md.

	 3. **Check for existing targets before moving.** If the target already
	    exists (e.g., both .roorules and .shofer/rules/ exist), do NOT
	    overwrite — instead move the legacy file into the target directory
	    with a descriptive name.

	 4. **List files first.** Use \`list_files\` (recursive=false) at the
	    workspace root before each rename to confirm the legacy file exists
	    and the target doesn't conflict.

	 5. **Report action taken** in the final result. For each legacy file
	    found: state what it was renamed to, or if it was skipped (with reason).

	 6. **Do NOT read file contents** except for MCP config migration.
	    The MCP conversion (cline_mcp_settings.json → .shofer/mcp.json)
	    requires reading the JSON to inject \`"type": "stdio"\` into each
	    server entry. For all other files, this is a pure rename operation —
	    use only list_files, create_directory, and file(mv).

	 7. **Stop after migration** — do not modify any file contents.
	    Do not edit AGENTS.md, .shofer/shoferignore, .shofer/shofermodes, or the
	    migrated files.
</execution_rules>

<quality_criteria>
	 - Every legacy file at the workspace root is accounted for
	 - Targets are checked for existence to avoid data loss
	 - Parent directories are created before moves
	 - The final summary lists every file touched
	 - No file CONTENTS are modified — this is purely rename/move
	 - Use the \`file\` tool (not shell commands) for all moves
</quality_criteria>

After migration, print a summary like:

\`\`\`
Migration complete:
	 ✓ .rooignore → .shofer/shoferignore
	 ✓ .roomodes → .shofer/shofermodes
	 ✓ .roorules → .shofer/rules/roorules.md
	 ✓ .roorules-code → .shofer/rules-code/roorules-code.md
	 ⚠ cline_mcp_settings.json skipped — .shofer/mcp.json already exists
\`\`\``,
	},
	"migrate-from-copilot": {
		name: "migrate-from-copilot",
		description: "Migrate GitHub Copilot configuration files to Shofer equivalents",
		content: `<task>
Migrate GitHub Copilot configuration files in this project to their Shofer
equivalents. This involves moving skill directories, merging instruction files,
converting agent definitions to custom modes, and converting targeted instructions
to Shofer rules.
</task>

<initialization>
	 <todo_list_creation>
	   If the update_todo_list tool is available, create a todo list with these steps:

	   1. Scan for all Copilot config files (.github/copilot-instructions.md, .github/instructions/, .github/agents/, .github/skills/)
	   2. Move and merge .github/copilot-instructions.md into AGENTS.md or .shofer/custom-instructions.md
	   3. Convert .github/instructions/*.instructions.md to .shofer/rules/ files
	   4. Convert .github/agents/*.agent.md to .shofer/shofermodes custom mode entries
	   5. Move .github/skills/*/ directories to .shofer/skills/
	   6. Report .vscode/settings.json Copilot settings for manual cleanup
	   7. Verify migration completeness
	 </todo_list_creation>
</initialization>

<migration_mapping>
	 <global_instructions>
	   The primary Copilot instructions file:
	   | Copilot                                | Shofer Action                                                                 |
	   |----------------------------------------|-------------------------------------------------------------------------------|
	   | \`.github/copilot-instructions.md\`    | Merge content into \`AGENTS.md\` (appended with a "Copilot Instructions" heading). If AGENTS.md doesn't exist, create it. If AGENTS.md already has Copilot content, skip. |

	   HOW:
	   1. Read .github/copilot-instructions.md
	   2. Check if AGENTS.md exists — if not, create it with:
	      \`# AGENTS.md\n\nThis file provides guidance to agents when working with code in this repository.\n\n## Copilot Instructions (migrated)\n\n<copilot instructions content>\`
	   3. If AGENTS.md exists, search for "Copilot Instructions" — if found, skip (already migrated)
	   4. If not found, APPEND the copilot content under a "## Copilot Instructions (migrated)" heading

	   After merging, DO NOT delete the original .github/copilot-instructions.md —
	   Copilot still uses it. Report it as "merged (original retained)".

	   **Note:** Copilot Memory (the cloud-synced 28-day repository memory graph that
	   captures coding styles, shared abstractions, and cross-file dependencies) is a
	   Copilot runtime feature with no file-based equivalent. It does not produce
	   migratable artifacts and cannot be transferred to Shofer.
	 </global_instructions>

	 <targeted_instructions>
	   Copilot's targeted instruction files with \`applyTo\` glob patterns:
	   | Copilot                                       | Shofer Action                                                          |
	   |-----------------------------------------------|------------------------------------------------------------------------|
	   | \`.github/instructions/*.instructions.md\`    | Extract content (strip YAML frontmatter), save as \`.shofer/rules/<name>.md\` |

	   HOW for each file:
	   1. Read the file — extract YAML frontmatter (description, applyTo)
	   2. Strip the frontmatter — keep only the markdown body
	   3. Prepend a header comment with the original filename and applyTo glob:
	      \`<!-- migrated from .github/instructions/<name>.instructions.md -->\n<!-- original applyTo: <glob> -->\n\n\`
	   4. Write to .shofer/rules/<name>.md (create .shofer/rules/ directory if needed)
	   5. If a file with the same name already exists in .shofer/rules/, append with a separator

	   After migration, DO NOT delete the original files — Copilot still uses them.
	 </targeted_instructions>

	 <agent_definitions>
	   Copilot's custom agent definitions:
	   | Copilot                              | Shofer Action                                                                               |
	   |--------------------------------------|---------------------------------------------------------------------------------------------|
	   | \`.github/agents/*.agent.md\`        | Convert each agent to a custom mode entry in \`.shofer/shofermodes\`                               |

	   HOW for each agent file:
	   1. Read the file — extract YAML frontmatter (name, description, tools if present)
	   2. Read the markdown body — this becomes the mode's roleDefinition
	   3. Map Copilot tools to Shofer tool groups:
	      - "terminal" → execute group
	      - "file-viewer" → read group
	      - "file-editor" → write group
	      - "browser" → browser group
	      - If no tools listed or unrecognized, default to ["read", "mcp"]
	   4. Check if .shofer/shofermodes exists:
	      - If no: create it with the new mode entry (create .shofer/ directory first)
	      - If yes: read it and append the new mode (if slug doesn't already exist)
	   5. The mode slug is the agent name lowercased with hyphens (e.g., "Terraform Expert" → "terraform-expert")
	   6. YAML format to append:
	      \`\`\`yaml
	      customModes:
	        - slug: <slug>
	          name: "<agent name>"
	          roleDefinition: "<agent instructions>"
	          groups: [<mapped groups>]
	          source: project
	      \`\`\`

	   After migration, DO NOT delete the original agent files.

	   **Note:** Copilot Cloud Agents (Agent Sessions — autonomous agents running in
	   isolated GitHub Actions environments for up to 59 minutes) are a Copilot
	   cloud runtime feature. Shofer provides equivalent background-task orchestration
	   via its Orchestrator mode and the \`new_task\` tool with \`is_background=true\`.
	   Cloud Agent session definitions are NOT represented as .agent.md files and
	   cannot be migrated.
	 </agent_definitions>

	 <skills>
	   Copilot Agent Skills (same format as Shofer skills):
	   | Copilot                                  | Shofer Action                                         |
	   |------------------------------------------|-------------------------------------------------------|
	   | \`.github/skills/<name>/SKILL.md\`       | Move entire directory to \`.shofer/skills/<name>/\`   |

	   HOW for each skill directory:
	   1. List .github/skills/ to discover all skill subdirectories
	   2. For each skill dir, check if .shofer/skills/<name>/ already exists
	   3. If target doesn't exist: create .shofer/skills/<name>/ and use \`file mv\` to move each file
	   4. If target exists: skip with a warning — manual merge required
	   5. After moving all files, remove the now-empty .github/skills/<name>/ directory
	   6. After all skills are moved, remove .github/skills/ if empty

	   This is a MOVE operation — the skill is relocated, not copied.
	 </skills>
</migration_mapping>

<execution_rules>
	 1. **Use the \`file\` tool** with \`subcommand="mv"\` for moves/renames.
	    Use \`write_to_file\` for creating new files (AGENTS.md, .shofer/rules/*.md).
	    Use \`apply_diff\` or \`insert_edit\` for appending to existing files.

	 2. **Create parent directories first** with \`create_directory\` before
	    writing or moving files into them (.shofer/rules/, .shofer/skills/).

	 3. **Never overwrite existing files.** Always check with \`list_files\`
	    before writing. If the target exists, append or skip with a warning.

	 4. **Read before converting.** Use \`read_file\` on Copilot config files
	    to extract frontmatter and body content for conversion.

	 5. **Report every action.** For each file found, state what was done:
	    merged, moved, converted, skipped (with reason), or reported for manual review.

	 6. **Do NOT delete Copilot source files.** Copilot may still be in use.
	    The migration is non-destructive — it creates Shofer equivalents while
	    preserving the originals. The one exception: skills (move, not copy).

	 7. **Check .vscode/settings.json** for \`github.copilot.*\` keys and
	    report them for manual cleanup. Do NOT modify settings.json.
</execution_rules>

<quality_criteria>
	 - Every Copilot config file/directory is discovered and accounted for
	 - Content transformations preserve the original meaning
	 - Targets are checked for existence to avoid overwrites
	 - Agent→mode conversions produce valid .shofer/shofermodes YAML
	 - Skills are moved (not copied) to avoid duplication
	 - Source files are preserved (except skills, which are moved)
	 - The final summary lists every file touched with its outcome
</quality_criteria>

After migration, print a summary like:

\`\`\`
Migration complete:
	 ✓ .github/copilot-instructions.md → merged into AGENTS.md (original retained)
	 ✓ .github/instructions/react.instructions.md → .shofer/rules/react.md
	 ✓ .github/instructions/api.instructions.md → .shofer/rules/api.md
	 ✓ .github/agents/terraform-expert.agent.md → .shofer/shofermodes (custom mode added)
	 ✓ .github/skills/error-handling/ → moved to .shofer/skills/error-handling/
	 ⚠ .vscode/settings.json — 3 Copilot settings found for manual review
\`\`\``,
	},
	"migrate-from-claude": {
		name: "migrate-from-claude",
		description: "Migrate Claude Code configuration files to Shofer equivalents",
		content: `<task>
Migrate Claude Code (and Claude Cowork) configuration files in this project to
their Shofer equivalents. This involves merging instruction files, converting
rules to Shofer rules, moving skills, converting subagent definitions to custom
modes, and relocating MCP configuration.
</task>

<initialization>
	 <todo_list_creation>
	   If the update_todo_list tool is available, create a todo list with these steps:

	   1. Scan for all Claude Code config (CLAUDE.md, .claude/rules/, .claude/subagents/, .claude/skills/, .claude/settings*.json, .mcp.json)
	   2. Merge CLAUDE.md (and .claude/CLAUDE.md) into AGENTS.md
	   3. Merge hierarchical CLAUDE.md files from subdirectories
	   4. Convert .claude/rules/*.md to .shofer/rules/
	   5. Convert .claude/subagents/ to .shofer/shofermodes custom mode entries
	   6. Move .claude/skills/ to .shofer/skills/
	   7. Migrate .mcp.json to .shofer/mcp.json
	   8. Report .claude/settings.json and .claude/settings.local.json for manual review
	   9. Verify migration completeness
	 </todo_list_creation>
</initialization>

<migration_mapping>
	 <core_instructions>
	   Claude's primary project instruction files:
	   | Claude                            | Shofer Action                                                               |
	   |-----------------------------------|-----------------------------------------------------------------------------|
	   | \`CLAUDE.md\` (workspace root)    | Merge content into \`AGENTS.md\` under "## Claude Code Instructions (migrated)" |
	   | \`.claude/CLAUDE.md\`             | Same as above (check if CLAUDE.md already covered it)                       |
	   | \`<subdir>/CLAUDE.md\`            | Each becomes \`.shofer/rules/claude-<dirname>.md\`                          |

	   HOW for root CLAUDE.md (and .claude/CLAUDE.md):
	   1. If both exist, use the root one (preferred by Claude)
	   2. Read the file
	   3. Check if AGENTS.md exists — if not, create it with the Claude content
	   4. If AGENTS.md exists, search for "Claude Code Instructions" — if found, skip
	   5. If not found, APPEND under a "## Claude Code Instructions (migrated)" heading

	   HOW for hierarchical CLAUDE.md files (e.g., src/api/CLAUDE.md):
	   1. For each, extract the subdirectory name
	   2. Write content to .shofer/rules/claude-<subdir-name>.md
	   3. Include a header: \`<!-- migrated from <original-path> -->\`

	   After merging, DO NOT delete original CLAUDE.md files — Claude Code still uses them.

	   **Note:** Claude Code's Auto Memory feature (autonomous tracking of build behaviors,
	   successful commands, and debugging insights across sessions) is a Claude runtime
	   capability with no file-based equivalent. It does not produce migratable artifacts.
	 </core_instructions>

	 <rules>
	   Claude's granular rules with \`applyTo\` patterns:
	   | Claude                       | Shofer Action                                                    |
	   |------------------------------|------------------------------------------------------------------|
	   | \`.claude/rules/*.md\`       | Convert to \`.shofer/rules/<name>.md\`                           |

	   HOW for each rule file:
	   1. Read the file — extract YAML frontmatter (description, applyTo)
	   2. Strip the frontmatter — keep only the markdown body
	   3. Prepend a header comment:
	      \`<!-- migrated from .claude/rules/<filename> -->\n\`
	      If applyTo glob exists: \`<!-- original applyTo: <glob> -->\n\n\`
	   4. Write to .shofer/rules/<filename> (create .shofer/rules/ directory if needed)
	   5. If target already exists, append with a markdown separator (\`---\`)

	   DO NOT delete original files.
	 </rules>

	 <subagents>
	   Claude's subagent definitions:
	   | Claude                                       | Shofer Action                                                       |
	   |----------------------------------------------|---------------------------------------------------------------------|
	   | \`.claude/subagents/*.json\`                 | Convert to \`.shofer/shofermodes\` custom mode entries                     |
	   | \`.claude/subagents/*.md\`                   | Same — extract frontmatter (name, systemPrompt, allowedTools)       |

	   HOW for each subagent:
	   1. Read the file
	   2. For JSON: parse name, systemPrompt, allowedTools
	      For Markdown: extract YAML frontmatter (name, description, tools)
	   3. Map Claude allowedTools to Shofer tool groups:
	      - "fileViewer" → read group
	      - "fileEditor" → write group
	      - "terminal" → execute group
	      - "browser" → browser group
	      - If no tools or unrecognized → ["read", "mcp"]
	   4. The mode slug = agent name lowercased with hyphens
	   5. Append to .shofer/shofermodes (create .shofer/ first if needed):
	      \`\`\`yaml
	      customModes:
	        - slug: <slug>
	          name: "<agent name>"
	          roleDefinition: "<systemPrompt>"
	          groups: [<mapped groups>]
	          source: project
	      \`\`\`
	   6. DO NOT delete original subagent files.

	   **Note:** Claude Code's \`/batch\` engine (automatic decomposition of large tasks
	   into isolated Git worktree units) is a Claude runtime feature. Shofer provides
	   equivalent worktree orchestration via its Orchestrator mode and the \`worktree\`
	   native tool — these are not migrated from subagent definitions.
	 </subagents>

	 <skills>
	   Claude Agent Skills (same standard as Shofer):
	   | Claude                                  | Shofer Action                                         |
	   |-----------------------------------------|-------------------------------------------------------|
	   | \`.claude/skills/<name>/SKILL.md\`      | Move entire directory to \`.shofer/skills/<name>/\`   |

	   HOW — identical to Copilot migration:
	   1. List .claude/skills/ to discover all skill subdirectories
	   2. For each, check if .shofer/skills/<name>/ already exists
	   3. If not: create target dir and use \`file mv\` for each file
	   4. If exists: skip with warning
	   5. Remove empty .claude/skills/<name>/ after move
	   6. Remove .claude/skills/ if empty

	   This is a MOVE — not a copy.
	 </skills>

	 <mcp_config>
	   Claude's project-level MCP:
	   | Claude          | Shofer Action                                                                     |
	   |-----------------|-----------------------------------------------------------------------------------|
	   | \`.mcp.json\`   | Convert format and write to \`.shofer/mcp.json\` if target does not already exist |
	   | \`.mcp.json\`   | (GitHub Copilot version — Copilot does NOT use local .mcp.json; see migration/copilot.md)   |

	   Claude's .mcp.json uses STDIO-based MCP servers without an explicit
	   \`"type"\` field. Shofer requires \`"type": "stdio"\` for all
	   command-based entries (see mcp.md for the full Shofer schema).

	   HOW:
	   1. Read .mcp.json with \`read_file\`
	   2. Parse the JSON — top-level structure: \`{"mcpServers": {...}}\`
	   3. For each server entry that has a \`"command"\` field but NO \`"type"\`
	      field, inject \`"type": "stdio"\`
	   4. Preserve ALL other fields: \`command\`, \`args\`, \`env\` — these are
	      compatible with Shofer as-is
	   5. Write the converted JSON to .shofer/mcp.json using \`write_to_file\`
	   6. If .shofer/mcp.json ALREADY exists, do NOT overwrite — save as
	      .shofer/mcp-migrated.json and advise manual merge

	   Example conversion:
	     BEFORE (Claude):
	       {"mcpServers": {
	         "sqlite-db-explorer": {
	           "command": "uvx",
	           "args": ["mcp-server-sqlite", "--db-path", "./data/dev.db"]
	         },
	         "custom-tool": {
	           "command": "node",
	           "args": ["./scripts/mcp-tool-server.js"],
	           "env": {"API_SECRET_KEY": "local_dev_key"}
	         }
	       }}
	     AFTER (Shofer):
	       {"mcpServers": {
	         "sqlite-db-explorer": {
	           "type": "stdio",
	           "command": "uvx",
	           "args": ["mcp-server-sqlite", "--db-path", "./data/dev.db"]
	         },
	         "custom-tool": {
	           "type": "stdio",
	           "command": "node",
	           "args": ["./scripts/mcp-tool-server.js"],
	           "env": {"API_SECRET_KEY": "local_dev_key"}
	         }
	       }}

	   After writing .shofer/mcp.json, do NOT delete the original .mcp.json —
	   Claude Code still uses it. Report it as "converted (original retained)".
	 </mcp_config>

	 <settings_report>
	   Claude's project and local settings — no direct Shofer equivalent:
	   | Claude                              | Action                                                    |
	   |-------------------------------------|-----------------------------------------------------------|
	   | \`.claude/settings.json\`           | Report for manual review (hooks, permissions, model prefs, Auto Mode) |
	   | \`.claude/settings.local.json\`     | Report for manual review (personal overrides)              |

	   These contain team-wide tool permissions, lifecycle hooks, model
	   preferences, and the \`autoMode\` risk-classifier configuration. Shofer does
	   not have a direct equivalent — the user should manually transfer relevant
	   settings to Shofer's VS Code settings (see configuration.md) or the Shofer
	   Settings UI. The Auto Mode classifier (bypassing ~83% of manual permission
	   prompts) has no Shofer counterpart; review Shofer's auto-approval settings
	   in the Settings UI as an alternative.
	 </settings_report>

	 <worktree_include>
	   | Claude                 | Shofer Action                                      |
	   |------------------------|----------------------------------------------------|
	   \`worktreeinclude\`   | Already supported — NO action needed               |

	   Shofer natively supports worktreeinclude files under \`.shofer/\`
	   with the same syntax. If the file already exists, it will be picked up
	   automatically.
	 </worktree_include>
</migration_mapping>

<execution_rules>
	 1. **Use the \`file\` tool** with \`subcommand="mv"\` for moves/renames
	    (.mcp.json, skill directories). Use \`write_to_file\` for creating
	    new files. Use \`apply_diff\` or \`insert_edit\` for appending.

	 2. **Create parent directories first** with \`create_directory\`
	    before writing or moving (.shofer/rules/, .shofer/skills/).

	 3. **Never overwrite existing files.** Check with \`list_files\`
	    before writing. Append or skip if target exists.

	 4. **Read before converting.** Use \`read_file\` on Claude config files
	    to extract frontmatter/JSON for subagent→mode conversion.

	 5. **Report every action.** For each file: merged, moved, converted,
	    skipped (with reason), or reported for manual review.

	 6. **Do NOT delete Claude source files** (except skills which are
	    moved, and .mcp.json which is renamed). Claude Code may still be in use.

	 7. **Handle hierarchical CLAUDE.md files.** Check common subdirectories:
	    src/, lib/, apps/, packages/. List_files recursive to discover them.
</execution_rules>

<quality_criteria>
	 - Every Claude config file/directory is discovered and accounted for
	 - Hierarchical CLAUDE.md files are preserved with their directory context
	 - Subagent→mode conversions produce valid .shofer/shofermodes YAML
	 - Skills are moved (not copied)
	 - .mcp.json is safely migrated (no overwrites)
	 - Settings files are clearly reported for manual follow-up
	 - Source files are preserved (except skills + .mcp.json)
	 - The final summary lists every file with its outcome
</quality_criteria>

After migration, print a summary like:

\`\`\`
Migration complete:
	 ✓ CLAUDE.md → merged into AGENTS.md (original retained)
	 ✓ src/api/CLAUDE.md → .shofer/rules/claude-api.md
	 ✓ .claude/rules/db-migrations.md → .shofer/rules/db-migrations.md
	 ✓ .claude/subagents/security-auditor.json → .shofer/shofermodes (custom mode added)
	 ✓ .claude/skills/generate-test/ → moved to .shofer/skills/generate-test/
	 ✓ .mcp.json → renamed to .shofer/mcp.json
	 ℹ worktreeinclude — already supported, no action needed
\`\`\``,
	},

	"migrate-from-opencode": {
		name: "migrate-from-opencode",
		description: "Migrate OpenCode configuration files to Shofer equivalents",
		content: `<task>
Migrate OpenCode configuration files in this project to their Shofer
equivalents. This involves merging instruction files, converting agent
definitions to custom modes, moving skills, and converting the opencode.json
permissions model.
</task>

<initialization>
	 <todo_list_creation>
	   If the update_todo_list tool is available, create a todo list with these steps:

	   1. Scan for all OpenCode config (AGENTS.md, .opencode/agent/, .opencode/skill/, opencode.json/.jsonc)
	   2. Merge AGENTS.md into Shofer's AGENTS.md
	   3. Convert .opencode/agent/*.md to .shofer/shofermodes custom mode entries
	   4. Move .opencode/skill/ directories to .shofer/skills/
	   5. Report opencode.json permissions for manual review
	   6. Verify migration completeness
	 </todo_list_creation>
</initialization>

<migration_mapping>
	 <core_instructions>
	   OpenCode's primary instruction file:
	   | OpenCode            | Shofer Action                                                               |
	   |---------------------|-----------------------------------------------------------------------------|
	   | \`AGENTS.md\`       | Merge content into Shofer's \`AGENTS.md\` under "## OpenCode Instructions (migrated)" |

	   HOW:
	   1. Read AGENTS.md
	   2. Check if Shofer's AGENTS.md exists — if not, create it with the OpenCode content
	   3. If AGENTS.md exists, search for "OpenCode Instructions" — if found, skip
	   4. If not found, APPEND under a "## OpenCode Instructions (migrated)" heading

	   After merging, DO NOT delete the original AGENTS.md — OpenCode still uses it.
	   Report it as "merged (original retained)".

	   **Note:** OpenCode automatically falls back to reading \`CLAUDE.md\` if
	   \`AGENTS.md\` does not exist. If both exist and \`migrate-from-claude\` has
	   already been run, the AGENTS.md content may overlap — deduplicate by
	   skipping content already present from the Claude migration.
	 </core_instructions>

	 <agent_definitions>
	   OpenCode's custom agent personas:
	   | OpenCode                                  | Shofer Action                                                       |
	   |-------------------------------------------|---------------------------------------------------------------------|
	   | \`.opencode/agent/*.md\`                  | Convert to \`.shofer/shofermodes\` custom mode entries                     |
	   | \`~/.config/opencode/agent/*.md\`         | Report for manual review (global agents outside project scope)      |

	   HOW for each project agent file (.opencode/agent/*.md):
	   1. Read the file — extract agent name from the filename or heading
	   2. The body becomes the mode's roleDefinition
	   3. OpenCode agents don't declare tools explicitly — default to ["read", "write", "execute", "mcp"]
	   4. The mode slug = agent name lowercased with hyphens
	   5. Append to .shofer/shofermodes (create .shofer/ first if needed):
	      \`\`\`yaml
	      customModes:
	        - slug: <slug>
	          name: "<agent name>"
	          roleDefinition: "<agent instructions>"
	          groups: ["read", "write", "execute", "mcp"]
	          source: project
	      \`\`\`
	   6. DO NOT delete original agent files.

	   Global agents (\`~/.config/opencode/agent/*.md\`) are outside the project
	   scope — report them for manual review. The user may want to recreate them
	   as Shofer global custom modes.
	 </agent_definitions>

	 <skills>
	   OpenCode Agent Skills (same standard format as Shofer):
	   | OpenCode                                   | Shofer Action                                         |
	   |--------------------------------------------|-------------------------------------------------------|
	   | \`.opencode/skill/<name>/SKILL.md\`        | Move entire directory to \`.shofer/skills/<name>/\`   |

	   OpenCode also reads Claude-compatible \`.claude/skills/\` directories —
	   if \`migrate-from-claude\` has already been run, those skills have already
	   been moved. Only process skills under \`.opencode/skill/\` that don't
	   already exist in \`.shofer/skills/\`.

	   HOW — identical to Claude/Copilot migration:
	   1. List .opencode/skill/ to discover all skill subdirectories
	   2. For each, check if .shofer/skills/<name>/ already exists
	   3. If not: create target dir and use \`file mv\` for each file
	   4. If exists: skip with warning
	   5. Remove empty .opencode/skill/<name>/ after move
	   6. Remove .opencode/skill/ if empty

	   This is a MOVE — not a copy.
	 </skills>

	 <tool_configuration>
	   OpenCode's provider, model, and permission configuration:
	   | OpenCode                     | Shofer Action                                              |
	   |------------------------------|------------------------------------------------------------|
	   | \`opencode.json\`            | Report for manual review                                   |
	   | \`opencode.jsonc\`           | Report for manual review                                   |

	   opencode.json / opencode.jsonc contains:
	   - \`provider\` — LLM provider and model configuration (Anthropic, OpenAI,
	     OpenRouter, local models via LM Studio/Atomic Chat)
	   - \`permission\` — tool-level allow/deny/ask policies

	   These do NOT have a direct Shofer file-based equivalent. Report the file
	   for manual review and advise the user:
	   - Provider/model config → transfer to Shofer's API Configuration in Settings UI
	   - Tool permissions → review Shofer's auto-approval settings in Settings UI

	   Do NOT modify or delete opencode.json / opencode.jsonc.
	 </tool_configuration>

	 <mcp_integration>
	   OpenCode does NOT store MCP server definitions at the project level.
	   There is no \`.opencode/mcp.json\` or equivalent project file.

	   - **Server definitions** live in the global/user-level MCP config
	     (the same \`claude_desktop_config.json\` that Claude Desktop uses).
	     These are outside the project scope and cannot be migrated automatically.
	   - **Tool permissions** live in \`opencode.json\` → \`permission\`:
	     e.g. \`"mymcp_*": "ask"\` — these are name-based glob patterns that
	     gate individual MCP tools.
	   - **LSP integration** is governed by the \`lsp\` tool permission in
	     \`opencode.json\`.

	   | Feature                     | Migration Action                                                   |
	   |-----------------------------|-------------------------------------------------------------------|
	   | MCP server definitions      | No project file — servers live in global \`claude_desktop_config.json\` |
	   | MCP tool permissions        | Report \`opencode.json\` permission block for manual review        |
	   | LSP integration             | Shofer natively supports LSP diagnostics — no migration needed    |
	   | \`lsp\` tool permission     | Review in Shofer's auto-approval settings                         |

	   **Server entry compatibility:** If the user wants to manually recreate
	   their global MCP servers as project-level \`.shofer/mcp.json\` entries,
	   the server shape is compatible — OpenCode/Claude use the same
	   \`{command, args, env}\` standard. The only conversion needed is
	   injecting \`"type": "stdio"\` (Shofer infers it from \`command\` presence
	   but the schema expects it; see mcp.md §Configuration). Wrap servers under
	   \`{"mcpServers": {...}}\` — the same top-level key as Claude's \`.mcp.json\`.

	   Example — an OpenCode/Claude server entry converted to \`.shofer/mcp.json\`:
	   \`\`\`json
	   {
	     "mcpServers": {
	       "my-server": {
	         "type": "stdio",
	         "command": "node",
	         "args": ["path/to/server.js"],
	         "env": { "KEY": "value" },
	         "timeout": 60,
	         "disabled": false
	       }
	     }
	   }
	   \`\`\`
	   (The \`cwd\`, \`disabledTools\`, and \`toolGroups\` fields are optional;
	   see mcp.md for the full schema.)

	   **Permission conversion:** OpenCode's \`permission\` block uses
	   \`"allow"\` / \`"deny"\` / \`"ask"\` per tool name. Shofer controls this
	   via the auto-approval Settings UI — there is no file-based equivalent.
	   Report the \`opencode.json\` permission block for manual review.

	   **Note:** OpenCode's live LSP code diagnostics (intercepting real-time
	   compiler feedback and type errors) is matched by Shofer's native
	   diagnostics integration. No migration action is needed.
	 </mcp_integration>

	 <content_exclusion>
	   OpenCode relies on \`.gitignore\` for content exclusion (privacy-first,
	   local-execution architecture). Shofer also honors \`.gitignore\` for file
	   search and read operations, and additionally supports \`.shofer/shoferignore\`
	   for Shofer-specific exclusions.

	   | OpenCode        | Shofer Action                                              |
	   |-----------------|------------------------------------------------------------|
	   | \`.gitignore\`  | Already shared — no migration needed                       |

	   If the project has sensitive files tracked only in \`.gitignore\`, they are
	   already protected. No additional migration action is needed.
	 </content_exclusion>
</migration_mapping>

<execution_rules>
	 1. **Use the \`file\` tool** with \`subcommand="mv"\` for moves/renames
	    (skill directories). Use \`write_to_file\` for creating new files.
	    Use \`apply_diff\` or \`insert_edit\` for appending.

	 2. **Create parent directories first** with \`create_directory\`
	    before writing or moving (.shofer/skills/).

	 3. **Never overwrite existing files.** Check with \`list_files\`
	    before writing. Append or skip if target exists.

	 4. **Read before converting.** Use \`read_file\` on OpenCode config files
	    to extract content for agent→mode conversion.

	 5. **Report every action.** For each file: merged, moved, converted,
	    skipped (with reason), or reported for manual review.

	 6. **Do NOT delete OpenCode source files** (except skills which are
	    moved). OpenCode may still be in use.

	 7. **Check for cross-tool overlap.** If \`migrate-from-claude\` or
	    \`migrate-from-copilot\` has already been run, avoid duplicating
	    content in AGENTS.md or .shofer/shofermodes. Check for existing entries
	    before appending.
</execution_rules>

<quality_criteria>
	 - Every OpenCode config file/directory is discovered and accounted for
	 - AGENTS.md merge avoids duplication with prior Claude/Copilot migrations
	 - Agent→mode conversions produce valid .shofer/shofermodes YAML
	 - Skills are moved (not copied)
	 - opencode.json is clearly reported for manual follow-up
	 - Source files are preserved (except skills)
	 - The final summary lists every file with its outcome
</quality_criteria>

After migration, print a summary like:

\`\`\`
Migration complete:
	 ✓ AGENTS.md → merged into Shofer's AGENTS.md (original retained)
	 ✓ .opencode/agent/frontend-architect.md → .shofer/shofermodes (custom mode added)
	 ✓ .opencode/skill/docker-deploy/ → moved to .shofer/skills/docker-deploy/
	 ℹ opencode.json — provider, model, and permission config for manual review
	 ℹ ~/.config/opencode/agent/ — 2 global agents for manual review
\`\`\``,
	},
	"merge-worktree": {
		name: "merge-worktree",
		description: "Merge worktree branch into base with a merge commit (no cleanup)",
		content: `<task>
You are merging a worktree branch into the base branch using a merge commit (--no-ff). The worktree and branch are left intact after the merge. The user may specify the branch name; if not provided, infer it from the current branch (typically worktree/shofer-<suffix>).
</task>

## Step 1: Gather information

Run these commands in parallel:

\`\`\`bash
git branch --show-current
\`\`\`

\`\`\`bash
git worktree list
\`\`\`

\`\`\`bash
git branch --list 'worktree/*'
\`\`\`

From the output, identify:
- **SOURCE_BRANCH**: the worktree branch to merge. If the user specified one, use it. Otherwise, use the current branch if it starts with worktree/. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out (from git worktree list)
- **BASE_BRANCH**: the target branch. Check if main or master exists locally. Prefer whichever exists. If both, prefer main.
- **BASE_WORKTREE_PATH**: the filesystem path of the worktree with BASE_BRANCH checked out

## Step 2: Validate

- SOURCE_BRANCH exists (git branch --list <SOURCE_BRANCH>)
- BASE_BRANCH exists (git branch --list <BASE_BRANCH>)
- SOURCE_BRANCH != BASE_BRANCH

Commits unique to SOURCE_BRANCH:

\`\`\`bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
\`\`\`

If this is empty, the branch has no unique commits. Report: "<SOURCE_BRANCH> has no unique commits relative to <BASE_BRANCH>. There is nothing to merge."

## Step 3: Switch to the base worktree

You MUST be in the base worktree before merging. If you are currently in SOURCE_WORKTREE_PATH, switch away:

\`\`\`bash
cd <BASE_WORKTREE_PATH> && git checkout <BASE_BRANCH>
\`\`\`

Pull latest (ask first):

\`\`\`bash
git pull origin <BASE_BRANCH>
\`\`\`

## Step 4: Merge

\`\`\`bash
git merge <SOURCE_BRANCH> --no-ff
\`\`\`

### If conflicts occur:

1. git diff --name-only --diff-filter=U -- list conflicted files
2. For each conflicted file, use git blame and git log to understand the intent behind both sides of the conflict
3. Make intelligent decisions: keep both changes when they are independent (bugfix + feature), prefer the more recent change when they overlap, prioritize bugfixes over refactors
4. **BAIL-OUT**: If you are unsure about the correct resolution for ANY file -- if both sides contain substantial, conflicting logic changes, or if the intent is unclear from git history -- do NOT guess. Run git merge --abort to return to pre-merge state. Tell the user: "Unsure how to resolve conflicts in [files]. Aborted the merge. You will need to resolve these manually." Stop here.
5. After resolving all files: git add . && git commit -m "merge: resolve conflicts merging <SOURCE_BRANCH> into <BASE_BRANCH>"

### If merge succeeds:
Show the merge commit: git log -1 --oneline

## Step 5: Report

Summarize:
- Merged: <SOURCE_BRANCH> -> <BASE_BRANCH>
- Merge commit: <hash>
- The worktree branch <SOURCE_BRANCH> and its directory still exist (use merge-worktree-cleanup to also clean up)

Remind the user to push the base branch if appropriate: git push origin <BASE_BRANCH>

Do NOT push to origin yourself.`,
	},
	"merge-worktree-cleanup": {
		name: "merge-worktree-cleanup",
		description: "Merge worktree branch into base, then delete branch + worktree directory",
		content: `<task>
You are merging a worktree branch into the base branch, then cleaning up both the branch and the worktree directory. The user may specify the branch name; if not provided, infer it from the current branch (typically worktree/shofer-<suffix>).
</task>

## Step 1: Gather information

Run these commands in parallel:

\`\`\`bash
git branch --show-current
\`\`\`

\`\`\`bash
git worktree list
\`\`\`

\`\`\`bash
git branch --list 'worktree/*'
\`\`\`

From the output, identify:
- **SOURCE_BRANCH**: the worktree branch to merge and then delete. If the user specified one, use it. Otherwise, use the current branch if it starts with worktree/. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out (from git worktree list)
- **BASE_BRANCH**: the target branch. Check if main or master exists locally. Prefer whichever exists. If both, prefer main.
- **BASE_WORKTREE_PATH**: the filesystem path of the worktree with BASE_BRANCH checked out

## Step 2: Validate

- SOURCE_BRANCH exists (git branch --list <SOURCE_BRANCH>)
- BASE_BRANCH exists (git branch --list <BASE_BRANCH>)
- SOURCE_BRANCH != BASE_BRANCH (never delete the base branch)
- You are NOT currently in SOURCE_WORKTREE_PATH (you cannot delete the worktree you're standing in)

Commits unique to SOURCE_BRANCH:

\`\`\`bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
\`\`\`

If this is empty, the branch has no unique commits. Report: "<SOURCE_BRANCH> has no unique commits relative to <BASE_BRANCH>. There is nothing to merge." Then ask: "Do you still want to clean up (delete the branch and worktree)?" If yes, skip to Step 5.

## Step 3: Switch to the base worktree

You MUST be in the base worktree before merging:

\`\`\`bash
cd <BASE_WORKTREE_PATH> && git checkout <BASE_BRANCH>
\`\`\`

Pull latest (ask first):

\`\`\`bash
git pull origin <BASE_BRANCH>
\`\`\`

## Step 4: Merge

\`\`\`bash
git merge <SOURCE_BRANCH> --no-ff
\`\`\`

### If conflicts occur:

1. git diff --name-only --diff-filter=U -- list conflicted files
2. For each conflicted file, use git blame and git log to understand the intent behind both sides
3. Make intelligent decisions: keep both changes when independent, prefer more recent when overlapping, prioritize bugfixes over refactors
4. **BAIL-OUT**: If unsure about ANY file -- if both sides contain substantial, conflicting logic changes -- do NOT guess. Run git merge --abort. Tell the user: "Unsure how to resolve conflicts in [files]. Aborted the merge. You will need to resolve these manually." Stop here. Do NOT continue to cleanup.
5. After resolving: git add . && git commit -m "merge: resolve conflicts merging <SOURCE_BRANCH> into <BASE_BRANCH>"

### If merge succeeds:
Show the merge commit: git log -1 --oneline

## Step 5: Remove the worktree

Remove the worktree directory from git's worktree list first -- you cannot delete a branch while its worktree is still registered:

\`\`\`bash
git worktree remove <SOURCE_WORKTREE_PATH>
\`\`\`

If the worktree has uncommitted changes, remove will fail. Use --force only after confirming with the user.

## Step 6: Delete the branch

After the worktree is removed, delete the source branch:

\`\`\`bash
git branch -d <SOURCE_BRANCH>
\`\`\`

If the branch has unmerged changes, -d will fail. Use -D only after confirming with the user.

Note: If git worktree remove --force was used in Step 5, the branch may already be deleted automatically. git branch -d will report "branch not found" in that case -- this is expected.

## Step 7: Verify cleanup

Confirm everything is clean:

\`\`\`bash
git worktree list
\`\`\`

\`\`\`bash
git branch --list '<SOURCE_BRANCH>'  # should return nothing
\`\`\`

## Step 8: Report

Summarize:
- Merged: <SOURCE_BRANCH> -> <BASE_BRANCH>
- Merge commit: <hash>
- Branch deleted: <SOURCE_BRANCH>
- Worktree removed: <SOURCE_WORKTREE_PATH>

Remind the user to push: git push origin <BASE_BRANCH>

Do NOT push to origin yourself.`,
	},
	"rebase-worktree": {
		name: "rebase-worktree",
		description: "Rebase worktree branch onto base, fast-forward merge (no cleanup)",
		content: `<task>
You are rebasing a worktree branch onto the base branch, producing a linear history without a merge commit. The branch and worktree are left intact. The user may specify the branch name; if not provided, infer it from the current branch (typically worktree/shofer-<suffix>).
</task>

## Step 1: Gather information

Run these commands in parallel:

\`\`\`bash
git branch --show-current
\`\`\`

\`\`\`bash
git worktree list
\`\`\`

\`\`\`bash
git branch --list 'worktree/*'
\`\`\`

From the output, identify:
- **SOURCE_BRANCH**: the worktree branch to rebase. If the user specified one, use it. Otherwise, use the current branch if it starts with worktree/. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out
- **BASE_BRANCH**: the target branch. Check if main or master exists locally. Prefer whichever exists. If both, prefer main.
- **BASE_WORKTREE_PATH**: the filesystem path of the worktree with BASE_BRANCH checked out

## Step 2: Validate

- SOURCE_BRANCH exists (git branch --list <SOURCE_BRANCH>)
- BASE_BRANCH exists (git branch --list <BASE_BRANCH>)
- SOURCE_BRANCH != BASE_BRANCH

Show commits unique to SOURCE_BRANCH:

\`\`\`bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
\`\`\`

If empty, the branch has no unique commits. Report this and ask if the user still wants to proceed.

Fetch latest base (ask first):

\`\`\`bash
git pull origin <BASE_BRANCH>
\`\`\`

## Step 3: Rebase the source branch onto base

You must be in SOURCE_WORKTREE_PATH, on SOURCE_BRANCH:

\`\`\`bash
cd <SOURCE_WORKTREE_PATH> && git checkout <SOURCE_BRANCH>
\`\`\`

Run the rebase:

\`\`\`bash
git rebase <BASE_BRANCH>
\`\`\`

### Handling conflicts during rebase

If the rebase produces conflicts, resolve them automatically:

1. git diff --name-only --diff-filter=U -- list conflicted files
2. For each conflicted file, use git blame and git log to understand intent. Use git log <BASE_BRANCH>..<SOURCE_BRANCH> -- <file> to see what the source branch changed.
3. Resolve intelligently: keep both changes when independent, prefer more recent when overlapping, prioritize bugfixes over refactors
4. After resolving: git add <file> then git rebase --continue
5. **BAIL-OUT**: If unsure about ANY file, stop. Run git rebase --abort. Tell the user: "Unsure how to resolve conflicts in [files]. Aborted the rebase. Please resolve manually or use a merge strategy instead."

## Step 4: Fast-forward the base branch

\`\`\`bash
cd <BASE_WORKTREE_PATH> && git checkout <BASE_BRANCH> && git merge <SOURCE_BRANCH> --ff-only
\`\`\`

## Step 5: Report

Summarize:
- Rebased: <SOURCE_BRANCH> onto <BASE_BRANCH>
- Fast-forwarded: <BASE_BRANCH> to include rebased commits
- Commits applied: <count>

Remind the user:
- The worktree branch <SOURCE_BRANCH> still exists
- The worktree directory still exists
- Consider pushing: git push origin <BASE_BRANCH>
- Since this was a rebase, the remote base branch will require --force-with-lease if it had been previously pushed

Do NOT push to origin. Do NOT delete the branch or worktree.`,
	},
	"rebase-worktree-cleanup": {
		name: "rebase-worktree-cleanup",
		description: "Rebase worktree branch onto base, fast-forward merge, then delete branch + worktree",
		content: `<task>
You are rebasing a worktree branch onto the base branch and cleaning up both the branch and the worktree directory. The user may specify the branch name; if not provided, infer it from the current branch (typically worktree/shofer-<suffix>).
</task>

## Step 1: Gather information

Run these commands in parallel:

\`\`\`bash
git branch --show-current
\`\`\`

\`\`\`bash
git worktree list
\`\`\`

\`\`\`bash
git branch --list 'worktree/*'
\`\`\`

From the output, identify:
- **SOURCE_BRANCH**: the worktree branch to rebase and then delete. If the user specified one, use it. Otherwise, use the current branch if it starts with worktree/. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out
- **BASE_BRANCH**: the target branch. Check if main or master exists locally. Prefer whichever exists. If both, prefer main.
- **BASE_WORKTREE_PATH**: the filesystem path of the worktree with BASE_BRANCH checked out

## Step 2: Validate

- SOURCE_BRANCH exists (git branch --list <SOURCE_BRANCH>)
- BASE_BRANCH exists (git branch --list <BASE_BRANCH>)
- SOURCE_BRANCH != BASE_BRANCH (never delete the base branch)
- You are NOT currently in SOURCE_WORKTREE_PATH (you cannot delete the worktree you're standing in)

Commits unique to SOURCE_BRANCH:

\`\`\`bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
\`\`\`

If empty, the branch has no unique commits. Report: "<SOURCE_BRANCH> has no unique commits relative to <BASE_BRANCH>. There is nothing to rebase." Then ask: "Do you still want to clean up (delete the branch and worktree)?" If yes, skip to Step 6.

Fetch latest base (ask first):

\`\`\`bash
git pull origin <BASE_BRANCH>
\`\`\`

## Step 3: Rebase the source branch onto base

Switch to SOURCE_WORKTREE_PATH, on SOURCE_BRANCH:

\`\`\`bash
cd <SOURCE_WORKTREE_PATH> && git checkout <SOURCE_BRANCH>
\`\`\`

Run the rebase:

\`\`\`bash
git rebase <BASE_BRANCH>
\`\`\`

### Handling conflicts during rebase

1. git diff --name-only --diff-filter=U -- list conflicted files
2. For each conflicted file, use git blame and git log to understand intent. Use git log <BASE_BRANCH>..<SOURCE_BRANCH> -- <file> to see what the source branch changed.
3. Resolve intelligently: keep both changes when independent, prefer more recent when overlapping, prioritize bugfixes over refactors
4. After resolving: git add <file> then git rebase --continue
5. **BAIL-OUT**: If unsure about ANY file, stop. Run git rebase --abort. Tell the user: "Unsure how to resolve conflicts in [files]. Aborted the rebase. Please resolve manually or use a merge strategy instead." Do NOT continue to cleanup.

## Step 4: Fast-forward the base branch

\`\`\`bash
cd <BASE_WORKTREE_PATH> && git checkout <BASE_BRANCH> && git merge <SOURCE_BRANCH> --ff-only
\`\`\`

## Step 5: Report rebase result

Show the new commits now on BASE_BRANCH: git log --oneline -<N>

## Step 6: Remove the worktree

Remove the worktree directory first -- you cannot delete a branch while its worktree is still registered:

\`\`\`bash
git worktree remove <SOURCE_WORKTREE_PATH>
\`\`\`

If the worktree has uncommitted changes, remove will fail. Use --force only after confirming with the user.

## Step 7: Delete the branch

\`\`\`bash
git branch -d <SOURCE_BRANCH>
\`\`\`

If the branch has unmerged changes, -d will fail. Use -D only after confirming with the user.

## Step 8: Verify cleanup

\`\`\`bash
git worktree list
\`\`\`

\`\`\`bash
git branch --list '<SOURCE_BRANCH>'  # should return nothing
\`\`\`

## Step 9: Report

Summarize:
- Rebased: <SOURCE_BRANCH> onto <BASE_BRANCH>
- Fast-forwarded: <BASE_BRANCH>
- Branch deleted: <SOURCE_BRANCH>
- Worktree removed: <SOURCE_WORKTREE_PATH>

Remind the user to push: git push origin <BASE_BRANCH>
Since this was a rebase, the remote base branch will require --force-with-lease if it had been previously pushed.

Do NOT push to origin yourself.`,
	},
	"dryrun-rebase-worktree": {
		name: "dryrun-rebase-worktree",
		description: "Preview rebase conflicts without committing changes",
		content: `<task>
You are performing a dry-run rebase to preview what conflicts would occur, without actually completing the rebase. The user may specify the branch name; if not provided, infer it from the current branch (typically worktree/shofer-<suffix>).
</task>

## Step 1: Gather information

Run these commands in parallel:

\`\`\`bash
git branch --show-current
\`\`\`

\`\`\`bash
git worktree list
\`\`\`

\`\`\`bash
git branch --list 'worktree/*'
\`\`\`

From the output, identify:
- **SOURCE_BRANCH**: the worktree branch to test-rebase. If the user specified one, use it. Otherwise, use the current branch if it starts with worktree/. If neither is clear, ask the user.
- **SOURCE_WORKTREE_PATH**: the filesystem path of the worktree with SOURCE_BRANCH checked out
- **BASE_BRANCH**: the target branch. Check if main or master exists locally. Prefer whichever exists. If both, prefer main.

## Step 2: Validate

- SOURCE_BRANCH exists (git branch --list <SOURCE_BRANCH>)
- BASE_BRANCH exists (git branch --list <BASE_BRANCH>)
- SOURCE_BRANCH != BASE_BRANCH

Show what would be rebased:

\`\`\`bash
git log <BASE_BRANCH>..<SOURCE_BRANCH> --oneline
\`\`\`

## Step 3: Simulate the rebase

Switch to the source worktree:

\`\`\`bash
cd <SOURCE_WORKTREE_PATH> && git checkout <SOURCE_BRANCH>
\`\`\`

Run the dry-run rebase:

\`\`\`bash
git rebase <BASE_BRANCH>
\`\`\`

## Step 4: Report results

### If the rebase applies cleanly:

Report: "Rebase of <SOURCE_BRANCH> onto <BASE_BRANCH> would apply cleanly. No conflicts expected."

Show the new commit order: git log --oneline -<N>

Then abort back to original state:

\`\`\`bash
git reset --hard ORIG_HEAD
\`\`\`

### If conflicts are detected:

List them:

\`\`\`bash
git diff --name-only --diff-filter=U
\`\`\`

For each conflicted file, show the conflict markers:

\`\`\`bash
grep -n '<<<<<<<\|=======\\|>>>>>>>' <file>
\`\`\`

Report: "Conflicts would occur in <N> file(s): [list]. These will need to be resolved if you proceed with the rebase."

## Step 5: Abort and clean up

If rebase is in progress (conflicts occurred): git rebase --abort
If rebase completed successfully: git reset --hard ORIG_HEAD

Confirm clean state:

\`\`\`bash
git status --short  # should be empty
\`\`\`

\`\`\`bash
git branch --show-current  # should be SOURCE_BRANCH
\`\`\`

## Step 6: Recommend next steps

Based on the result:

- **No conflicts**: "Safe to proceed. Run rebase-worktree to rebase and fast-forward merge."
- **Conflicts found**: "Conflicts expected. You can: (a) run rebase-worktree and let the agent auto-resolve, (b) resolve them yourself, or (c) use merge-worktree (merge strategy) which may produce different conflicts."
- **Many commits**: "There are <N> commits to rebase. If conflicts occur, you may need to resolve them multiple times (once per commit). Consider merge-worktree for a single conflict resolution."`,
	},
	"worktree-status": {
		name: "worktree-status",
		description: "Detailed status report for current worktree branch",
		content: `<task>
You are producing a detailed status report for the current worktree branch. The user may specify a branch name; if not provided, use the current branch.
</task>

## Step 1: Gather basic information

Run these commands in parallel:

\`\`\`bash
git branch --show-current
\`\`\`

\`\`\`bash
git worktree list
\`\`\`

\`\`\`bash
git status --short
\`\`\`

Identify:
- **CURRENT_BRANCH**: the branch to report on
- **CURRENT_WORKTREE_PATH**: the filesystem path of the current worktree
- **BASE_BRANCH**: check if main or master exists locally. Prefer whichever exists. If both, prefer main.
- **ALL_WORKTREES**: all worktrees listed

If CURRENT_BRANCH is the base branch, skip ahead/behind and focus on files changed and last-commit info.

## Step 2: Collect status data

Run these in parallel:

\`\`\`bash
# Commits on this branch that are NOT on base
git log <BASE_BRANCH>..<CURRENT_BRANCH> --oneline
\`\`\`

\`\`\`bash
# Commits on base that are NOT on this branch
git log <CURRENT_BRANCH>..<BASE_BRANCH> --oneline
\`\`\`

\`\`\`bash
# Files changed (working tree vs HEAD)
git diff --name-status HEAD
\`\`\`

\`\`\`bash
# Last commit info
git log -1 --format="%h %s (%ar) by %an"
\`\`\`

\`\`\`bash
# Total files changed in this branch vs base
git diff --name-status <BASE_BRANCH>...<CURRENT_BRANCH>
\`\`\`

\`\`\`bash
# Uncommitted changes summary
git status --short | wc -l
\`\`\`

## Step 3: Check merge readiness

Simulate a merge to detect conflicts:

\`\`\`bash
git merge --no-commit --no-ff <CURRENT_BRANCH>
\`\`\`

If the merge fails due to conflicts: git diff --name-only --diff-filter=U, then git merge --abort
If the merge succeeds cleanly: git merge --abort

## Step 4: Present the report

Format the output clearly:

\`\`\`
## Worktree Status: <CURRENT_BRANCH>

**Path**: <CURRENT_WORKTREE_PATH>
**Base branch**: <BASE_BRANCH>
**Last commit**: <hash> "<subject>" (<relative time>) by <author>

### Ahead/Behind
- Ahead of <BASE_BRANCH>: <N> commits
- Behind <BASE_BRANCH>: <N> commits

### Files Changed (vs base)
- <N> files changed, <N> insertions, <N> deletions
- <list of changed files with status letters>

### Working Tree
- <N> uncommitted changes (tracked files)

### Merge Readiness
- No conflicts with <BASE_BRANCH> -- safe to merge
  OR
- Conflicts detected in <N> file(s): [list] -- merge will need resolution
\`\`\`

## Step 5: Recommend next steps

Based on the status:

- **Has unique commits + no conflicts**: "Ready to merge. Run merge-worktree or merge-worktree-cleanup."
- **Has unique commits + conflicts**: "Conflicts expected. Run dryrun-rebase-worktree to preview, then merge-worktree when ready."
- **No unique commits**: "This branch has no unique commits relative to <BASE_BRANCH>. You can safely delete it with merge-worktree-cleanup (no merge needed)."
- **Has uncommitted changes**: "You have <N> uncommitted changes. Commit or stash them before merging."
- **Behind base**: "This branch is <N> commits behind <BASE_BRANCH>. Consider rebasing first: rebase-worktree."
- **Current branch is base branch**: "You are on <BASE_BRANCH>. All other worktrees:" (then list each with its ahead/behind count)`,
	},
}

/**
 * Get all built-in commands as Command objects
 */
export async function getBuiltInCommands(): Promise<Command[]> {
	return Object.values(BUILT_IN_COMMANDS).map((cmd) => ({
		name: cmd.name,
		content: cmd.content,
		source: "built-in" as const,
		filePath: `<built-in:${cmd.name}>`,
		description: cmd.description,
		argumentHint: cmd.argumentHint,
	}))
}

/**
 * Get a specific built-in command by name
 */
export async function getBuiltInCommand(name: string): Promise<Command | undefined> {
	const cmd = BUILT_IN_COMMANDS[name]
	if (!cmd) return undefined

	return {
		name: cmd.name,
		content: cmd.content,
		source: "built-in" as const,
		filePath: `<built-in:${name}>`,
		description: cmd.description,
		argumentHint: cmd.argumentHint,
	}
}

/**
 * Get names of all built-in commands
 */
export async function getBuiltInCommandNames(): Promise<string[]> {
	return Object.keys(BUILT_IN_COMMANDS)
}
