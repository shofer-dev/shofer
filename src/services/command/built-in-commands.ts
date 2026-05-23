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
	   | \`.rooignore\`            | \`.shoferignore\`  | Ignore patterns for Shofer tools               |
	   | \`.roomodes\`             | \`.shofermodes\`   | Custom mode definitions                        |
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
	    Do not edit AGENTS.md, .shoferignore, .shofermodes, or the
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
	 ✓ .rooignore → .shoferignore
	 ✓ .roomodes → .shofermodes
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
	   4. Convert .github/agents/*.agent.md to .shofermodes custom mode entries
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
	   | \`.github/agents/*.agent.md\`        | Convert each agent to a custom mode entry in \`.shofermodes\`                               |

	   HOW for each agent file:
	   1. Read the file — extract YAML frontmatter (name, description, tools if present)
	   2. Read the markdown body — this becomes the mode's roleDefinition
	   3. Map Copilot tools to Shofer tool groups:
	      - "terminal" → execute group
	      - "file-viewer" → read group
	      - "file-editor" → write group
	      - "browser" → browser group
	      - If no tools listed or unrecognized, default to ["read", "mcp"]
	   4. Check if .shofermodes exists:
	      - If no: create it with the new mode entry
	      - If yes: read it and append the new mode (if slug doesn't already exist)
	   5. The mode slug is the agent name lowercased with hyphens (e.g., "Terraform Expert" → "terraform-expert")
	   6. YAML format to append:
	      \`\`\`yaml
	      - slug: <slug>
	        name: "<agent name>"
	        roleDefinition: "<agent instructions>"
	        groups: [<mapped groups>]
	        source: project
	      \`\`\`

	   After migration, DO NOT delete the original agent files.
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
	 - Agent→mode conversions produce valid .shofermodes YAML
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
	 ✓ .github/agents/terraform-expert.agent.md → .shofermodes (custom mode added)
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
	   5. Convert .claude/subagents/ to .shofermodes custom mode entries
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
	   | \`.claude/subagents/*.json\`                 | Convert to \`.shofermodes\` custom mode entries                     |
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
	   5. Append to .shofermodes (create if needed):
	      \`\`\`yaml
	      - slug: <slug>
	        name: "<agent name>"
	        roleDefinition: "<systemPrompt>"
	        groups: [<mapped groups>]
	        source: project
	      \`\`\`
	   6. DO NOT delete original subagent files.
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
	   | \`.mcp.json\`   | (GitHub Copilot version — Copilot does NOT use local .mcp.json; see copilot.md)   |

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
	   | \`.claude/settings.json\`           | Report for manual review (hooks, permissions, model prefs) |
	   | \`.claude/settings.local.json\`     | Report for manual review (personal overrides)              |

	   These contain team-wide tool permissions, lifecycle hooks, and model
	   preferences. Shofer does not have a direct equivalent — the user should
	   manually transfer relevant settings to Shofer's VS Code settings (see
	   configuration.md) or the Shofer Settings UI.
	 </settings_report>

	 <worktree_include>
	   | Claude                 | Shofer Action                                      |
	   |------------------------|----------------------------------------------------|
	   | \`.worktreeinclude\`   | Already supported — NO action needed               |

	   Shofer natively supports .worktreeinclude files at the workspace root
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
	 - Subagent→mode conversions produce valid .shofermodes YAML
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
	 ✓ .claude/subagents/security-auditor.json → .shofermodes (custom mode added)
	 ✓ .claude/skills/generate-test/ → moved to .shofer/skills/generate-test/
	 ✓ .mcp.json → renamed to .shofer/mcp.json
	 ⚠ .claude/settings.json — manual review needed (hooks, permissions)
	 ⚠ .claude/settings.local.json — manual review needed
	 ℹ .worktreeinclude — already supported, no action needed
\`\`\``,
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
