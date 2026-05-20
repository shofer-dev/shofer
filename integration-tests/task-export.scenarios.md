# Task Export — Integration Test Scenarios

Feature under test: Markdown and JSON task export from both the task header and the History panel.  
Sources: [`export-markdown.ts`](../src/integrations/misc/export-markdown.ts), [`export-json.ts`](../src/integrations/misc/export-json.ts), [`ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts), [`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts), [`TaskActions.tsx`](../webview-ui/src/components/chat/TaskActions.tsx).

## Smoke Tests

These should pass on every build.

### S1 — Markdown export from task header (happy path)

- Start a new task, send a simple message ("1+1"), wait for the assistant response.
- Click the task header to expand the action row.
- Click the **Export** (download icon) button.
- Choose a save location.
- **Assert**: File is saved with `.md` extension. Contents contain `**User:**`, `**Assistant:**`, and the message text.
- **Assert**: The file opens in VS Code after save (preview mode).

### S2 — JSON export from task header (happy path)

- Same setup as S1.
- Click the **Export JSON** (file icon) button.
- **Assert**: File is saved with `.json` extension. File parses as valid JSON.
- **Assert**: Top-level keys include `version`, `taskId`, `task`, `mode`, `calls`, `totalTokens`, `totalCostUsd`, `totalCalls`, `totalToolCalls`.
- **Assert**: `calls[0]` has `index: 1`, a non-empty `messages` array, and sensible token counts.

### S3 — Markdown export from History panel

- Complete a task (or use an existing completed task).
- Open History panel → locate the task → click Export button in the task row.
- **Assert**: Export succeeds with same content expectations as S1.

### S4 — JSON export from History panel

- Same as S3 but click Export JSON.
- **Assert**: Export succeeds with same content expectations as S2.

## Functional Tests

### F1 — Tool calls appear in Markdown export

- Start a task that uses at least one tool (e.g., `read_file`, `execute_command`).
- Export as Markdown.
- **Assert**: The export contains `[Tool Use: read_file]` (or whichever tool was used) with its parameters.
- **Assert**: The tool result is shown as `[Tool]` or `[Tool (Error)]` with the result content.

### F2 — Tool calls appear in JSON export

- Same task as F1, export as JSON.
- **Assert**: `calls[0].toolCalls` is a non-empty array.
- **Assert**: Each tool call has `name`, `id`, `input`, and (if a result was captured) `result` with `content` and `isError`.

### F3 — Reasoning/thinking appears in both formats

- Use a model that emits reasoning/thinking blocks (e.g., Anthropic extended thinking, or DeepSeek reasoning).
- Export as both Markdown and JSON.
- **Assert (Markdown)**: Content contains `[Reasoning]` blocks.
- **Assert (JSON)**: `calls` entries have a non-empty `reasoning` string.

### F4 — Multi-turn conversation is preserved

- Send 3 separate messages and receive 3 responses.
- Export as Markdown.
- **Assert**: Each turn is separated by `---`. Roles alternate between `**User:**` and `**Assistant:**`.
- Export as JSON.
- **Assert**: `calls` array has one entry per assistant response. `totalCalls` matches.

### F5 — API protocol and model are recorded in JSON

- Export a task as JSON.
- **Assert**: Each `calls` entry has `apiProtocol` (one of `"anthropic"` or `"openai"`).
- **Assert**: Each `calls` entry has `model` (non-empty string matching the configured model).
- **Assert**: `apiProtocol` is **never** `"openai-native"` (source comment is misleading).

### F6 — Token estimation flag

- Use a provider that does **not** emit `usage` chunks in streaming mode.
- Export as JSON.
- **Assert**: `calls[]` entries have `"_tokensEstimated": true`.
- **Assert**: Token counts are non-zero (char/4 heuristic was applied).

### F7 — Real token counts (no estimation flag)

- Use a provider that **does** emit `usage` chunks (e.g., Anthropic direct).
- Export as JSON.
- **Assert**: `calls[]` entries do **not** have the `"_tokensEstimated"` key (or it is absent/`undefined`).

## Edge Case Tests

### E1 — Error-only task

- Configure an intentionally broken API endpoint or invalid key so every API call fails.
- Attempt a task that triggers at least one API call (which will fail).
- Export as JSON.
- **Assert**: `calls` array is non-empty (one entry per failed attempt).
- **Assert**: Each call has empty `messages: []` and `toolCalls: []`.
- **Assert**: Each call has a populated `error` object with at least `message`.
- **Assert**: `retryAttempt` increments across entries.

### E2 — Cancelled task

- Start a task. While the model is streaming its response, click Stop.
- Export as JSON.
- **Assert**: The cancelled call has `"cancelled": true` and a `cancelReason`.
- Export as Markdown.
- **Assert**: The partial conversation is exported up to the cancellation point.

### E3 — Empty task (no messages)

- Create a task but send no messages (or delete all messages).
- Export as Markdown.
- **Assert**: File is saved, content is minimal (no crash).
- Export as JSON.
- **Assert**: `calls` is an empty array `[]`. `totalCalls` and `totalToolCalls` are 0.

### E4 — Image attachment in conversation

- Start a task and attach an image (drag-and-drop or paste).
- Send a message about the image.
- Export as Markdown.
- **Assert**: The image is represented as `[Image]` in the transcript.
- Export as JSON.
- **Assert**: The user message in `messages` contains an `image` content block (type `"image"`).

### E5 — Very large conversation

- Run a task with 50+ tool calls / turns.
- Export as both Markdown and JSON.
- **Assert**: Export completes without OOM or timeout.
- **Assert (JSON)**: `totalCalls` and `totalToolCalls` match the expected counts.
- **Assert (Markdown)**: All turns are present, separated by `---`.

### E6 — Task with parallel subtasks

- Create a parent task that spawns 2 background subtasks.
- Export the **parent** task as JSON.
- **Assert**: The export contains only the parent's conversation — not the subtasks' conversations.
- Export one **subtask** as JSON.
- **Assert**: The subtask's export contains only its own conversation.

## Regression Tests

### R1 — File dialog cancellation

- Click Export or Export JSON, then cancel the file save dialog.
- **Assert**: No file is created. No error toast. Task remains functional.

### R2 — Export filename format

- Export a task as Markdown.
- **Assert**: Filename matches pattern `shofer_task_{month}-{day}-{year}_{hour}-{minute}-{second}-{ampm}.md`.
- Export as JSON.
- **Assert**: Filename matches pattern `shofer_task_{month}-{day}-{year}_{hour}-{minute}-{second}-{ampm}.json`.

### R3 — JSON schema stability

- Export a task as JSON.
- **Assert**: `version` field is `1`.
- **Assert**: All expected top-level keys are present with correct types (`calls` is array, `totalTokens` is object with `input`/`output`/`cacheWrite`/`cacheRead` numbers, `totalCostUsd` is number).

### R4 — History panel buttons disabled state

- Open History panel while a task is actively running.
- **Assert**: Export buttons in the task header of the running task are functional.
- **Assert**: Export buttons on completed task rows remain functional.
