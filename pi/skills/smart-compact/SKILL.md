---
name: smart-compact
description: "Analyzes the session context and generates focused instructions for pi's /compact command so that important information survives compaction. Use when the context window is getting tight or when you want to tidy up the session."
---

# Smart Compact

pi fork of the Claude Code `smart-compact` skill. Analyze the session
context and generate `/compact` instructions aligned with the user's
intent. pi's `/compact [instructions]` accepts optional instructions that
focus the summary — this skill produces those instructions.

## How pi compaction works (background)

- **Manual**: `/compact [instructions]` — the instructions focus the
  LLM-generated summary of older messages.
- **Auto**: triggers when context tokens exceed
  `contextWindow - reserveTokens` (default reserve: 16384). The most recent
  `keepRecentTokens` (default: 20000) are kept verbatim; only older
  messages are summarized. Auto-compaction always uses the default summary
  prompt — custom instructions only apply to manual `/compact`, which is
  why running this skill _before_ the threshold hits keeps you in control
  of what is preserved.
- **Settings**: `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`,
  under the `compaction` key (`enabled`, `reserveTokens`, `keepRecentTokens`).
- **Summary shape**: pi produces a structured summary (Goal / Constraints &
  Preferences / Progress / Key Decisions / Next Steps / Critical Context,
  plus `<read-files>` / `<modified-files>` lists tracked cumulatively
  across compactions). Instructions steer what lands in those sections.

## Execution Flow

### Phase 1: Session context analysis

Analyze the whole conversation history and extract:

- **Tasks in progress**: the implementation/fix/investigation currently underway
- **Important technical decisions**: architecture choices, library choices, design judgments
- **Unresolved issues**: errors, bugs, and problems still needing attention
- **File change history**: files changed/created during the session and why
- **Context-dependent information**: assumptions and constraints the follow-up work needs

Show the analysis result as a concise bullet list.

### Phase 2: Interview

Based on the Phase 1 analysis, ask the user what to keep. pi has no
AskUserQuestion tool — ask in plain conversation, presenting the choices as
a numbered list and telling the user that multiple selections are fine.

**Rules for generating the choices:**

- Generate the choices **dynamically** from the session content
- Make each choice concrete, containing this session's specific context
  (task names, file names, tech stack, etc.)
- Offer 2–4 choices, plus "other" free-form input

**Question template:**

```
Which information should compaction preserve with priority? (multiple selections OK)

Example choices (generated dynamically from the session):
1. Implementation progress and remaining work for <specific task>
2. Error-investigation context around <file name>
3. Design decisions and rationale for <technology>
4. API spec and type definitions for <feature>
```

**Important**: derive the choices from the session analysis — never use
preset generic choices.

### Phase 3: Instruction generation

Based on the user's answers, generate the instructions to pass to `/compact`.

**Generation guidelines:**

1. Include the user-selected items with top priority
2. Include the minimum context needed to continue the current task
3. Include concrete proper nouns: file names, function names, error messages
4. Phrase as "what to preserve", not "what to discard"
5. Write the instructions in Japanese (the user's working language)
6. Focus on **older** context: pi keeps the most recent ~`keepRecentTokens`
   verbatim anyway, so spend the instructions on earlier decisions and
   findings that would otherwise be summarized away

**Output format:**

```
以下の情報を重点的に保持してコンテキストを圧縮してください：

1. [保持項目1の具体的な内容]
2. [保持項目2の具体的な内容]
3. [保持項目3の具体的な内容]

特に以下は正確に保持してください：
- [重要な固有名詞、パス、コマンドなど]
```

### Phase 4: Hand off to the user

Present the generated instructions to the user:

```
Copy and run the following command:

/compact <generated instructions>
```

## Usage Example

```
> /smart-compact

=== Phase 1: Session context analysis ===

Main contents of this session:
- Implementing the MCPMerger feature of the dotfiles CLI
- Fixing a deep-merge bug involving defu
- Adding tests in tests/core/mcp-merger.test.ts

=== Phase 2: Interview ===

Which information should compaction preserve with priority? (multiple selections OK)

1. Investigation history and fix for the MCPMerger defu-integration bug
2. Added test cases in mcp-merger.test.ts and their intent
3. claude.json merge spec (key-preservation rules)
4. Other

> user answers: 1 and 3

=== Phase 3: Instruction generation ===

Generated instructions:
---
以下の情報を重点的に保持してコンテキストを圧縮してください：

1. MCPMergerでdefuを使ったmcpServersマージ時に、既存キーが上書きされるバグの原因と修正内容（src/core/mcp-merger.ts の mergeConfig 関数）
2. claude.jsonのマージ仕様：mcpServersキーのみマージし、apiKey等の他キーはdefu経由で保持する設計判断

特に以下は正確に保持してください：
- src/core/mcp-merger.ts, tests/core/mcp-merger.test.ts のファイルパス
- defu の非破壊マージ挙動（ターゲット側の値が優先される仕様）
---


Copy and run the following command:

/compact 以下の情報を重点的に保持してコンテキストを圧縮してください：...
```

## Notes

- `/compact` is a pi built-in command that only the user can run — same
  limitation as in Claude Code: the skill generates the instructions, and
  the user copies and executes the command manually
- Most effective when the session is long, i.e. context is approaching
  `contextWindow - reserveTokens`; run it before auto-compaction fires,
  since auto-compaction cannot take custom instructions
- To buy time before auto-compaction triggers, `reserveTokens` /
  `keepRecentTokens` can be tuned in the settings files listed above
