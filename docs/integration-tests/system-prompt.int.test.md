# Integration Tests: System Prompt Assembly

> Feature doc: [`docs/system_prompt.md`](../docs/system_prompt.md)
> Implementation: [`src/core/prompts/system.ts`](../src/core/prompts/system.ts),
> [`src/core/prompts/sections/`](../src/core/prompts/sections/)

## Scenarios

### 1. Prompt includes role definition for current mode

**Given** Shofer is in Code mode
**When** a new task starts
**Then** the first system message contains the Code mode role definition
**And** switching to Architect mode changes the role definition accordingly

**Verification**: Inspect `apiConversationHistory[0].content` for the mode-specific
role string. Confirm it differs between modes.

### 2. Custom instructions from `.shofer/rules/` appear in prompt

**Given** a workspace with `.shofer/rules/my-rule.md` containing `"Always use TypeScript."`
**When** a new task starts
**Then** the prompt includes `"Always use TypeScript."` somewhere in the custom
instructions section

**Verification**: Search the assembled prompt string for the literal rule content.

### 3. Mode-specific rules from `.shofer/rules-code/` are included

**Given** a workspace with `.shofer/rules-code/ts-preference.md` containing
`"Prefer interfaces over type aliases."`
**When** a new task starts in Code mode
**Then** the prompt includes that rule
**And** starting a task in Ask mode does NOT include that rule

**Verification**: Assert presence/absence of the mode-specific rule across
different mode selections.

### 4. `AGENTS.md` from workspace root is loaded

**Given** a workspace with `AGENTS.md` at the root containing valid markdown rules
**When** a new task starts
**Then** the content of `AGENTS.md` appears in the assembled prompt

**Verification**: Grep the prompt for a distinctive sentence from the `AGENTS.md` file.

### 5. `.shofer/shoferignore` instructions appear in prompt

**Given** a workspace with a `.shofer/shoferignore` file
**When** a new task starts
**Then** the custom instructions section includes the `.shofer/shoferignore` instructions
block (explaining what `.shofer/shoferignore` is and how the model should treat it)

**Verification**: Search the prompt for the `.shofer/shoferignore` explanatory text
produced by `shoferIgnoreInstructions`.

### 6. MCP server info appears only when mode has MCP group AND servers are configured

**Given** MCP servers are configured (e.g., `filesystem-server`)
**When** a task starts in a mode whose `groups` includes `"mcp"`
**Then** the capabilities section mentions MCP servers
**And** starting a task in a mode without the `"mcp"` group does NOT mention MCP servers

**Verification**: Check presence of the MCP sentence (`"You have access to MCP servers..."`)
in the assembled prompt under both conditions.

### 7. MCP info is absent when MCP servers are configured but none are running

**Given** MCP server configs exist but `mcpHub.getServers()` returns an empty array
**When** a task starts in a mode with `mcp` group
**Then** the capabilities section does NOT include MCP server info

**Verification**: `shouldIncludeMcp` must be `false` when `hasMcpServers` is false,
regardless of `hasMcpGroup`.

### 8. Skills section appears only when skills exist for the current mode

**Given** a skill is defined with mode restriction `"code"`
**When** a task starts in Code mode
**Then** the prompt includes an `<available_skills>` XML block with that skill
**And** starting a task in Architect mode does NOT include the skill

**Verification**: Search the prompt for `<available_skills>` and the skill's name.

### 9. Skills section is absent when no skills match

**Given** zero skills are installed, or `skillsManager` is `undefined`
**When** a new task starts
**Then** the prompt does NOT contain `<available_skills>` or the mandatory skill
check protocol

**Verification**: Assert `getSkillsSection` returns `""` in this scenario.

### 10. Shell-aware command chaining operator is correct

**Given** the host OS is Linux with bash
**When** the rules section is generated
**Then** the command chaining note mentions `&&` (not `;`)
**And** on PowerShell, the note mentions `;`

**Verification**: Call `getCommandChainOperator()` and confirm the return value
matches the shell. Integration test runs on Linux and expects `"&&"`.

### 11. Vendor confidentiality rules appear when `isStealthModel` is true

**Given** `SystemPromptSettings.isStealthModel = true`
**When** the rules section is generated
**Then** the prompt includes instructions to never reveal the model's creator
**And** when `isStealthModel` is `false` or absent, those instructions are absent

**Verification**: Search the prompt for vendor-anonymity language (presence/absence).

### 12. Legacy `.roorules` / `.clinerules` fallback works

**Given** a workspace without `.shofer/rules/` but with a `.roorules` file
containing `"Legacy rule content."`
**When** a new task starts
**Then** the prompt includes `"Legacy rule content."` in the custom instructions

**Verification**: Place a `.roorules` file, start a task, and grep the assembled prompt.

### 13. Legacy mode-specific rule fallback works

**Given** a workspace without `.shofer/rules-code/` but with `.roorules-code`
containing `"Mode-specific legacy rule."`
**When** a task starts in Code mode
**Then** the prompt includes that rule

**Verification**: Confirm legacy mode-specific file is read and included.

### 14. Subfolder `AGENTS.md` loading when enabled

**Given** `enableSubfolderRules = true` and a subdirectory `src/` contains `AGENTS.md`
**When** a new task starts
**Then** the prompt includes rules from `src/AGENTS.md`
**And** when `enableSubfolderRules = false`, those rules are absent

**Verification**: Toggle `enableSubfolderRules` and check for subdirectory rule content.

### 15. Assembly includes all 11 sections in the correct order

**Given** a task starts with a standard configuration (skills present, MCP configured, custom rules present)
**When** the prompt is assembled
**Then** the sections appear in this relative order:

1. Role definition
2. Markdown formatting rules
3. Tool use section
4. Tool use guidelines
5. Capabilities
6. Modes listing
7. Skills listing (if any)
8. Operational rules
9. System information
10. Objective/workflow
11. Custom instructions

**Verification**: Split the prompt on `====` markers and assert section ordering
via substring index comparison.

### 16. `supportsComputerUse` and unused parameters are harmless

**Given** `supportsComputerUse`, `experiments`, `todoList`, `modelId` are passed
**When** the prompt is assembled
**Then** the output is identical whether they are truthy, falsy, or absent

**Verification**: Generate prompts with varied values for these parameters and
diff the outputs — they should be identical.
