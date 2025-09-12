---
allowed-tools: Write, Bash, Read
argument-hint: <agent-name> "<description>" ["<system-prompt>"]
description: Create a sub-agent with its corresponding slash command (command-subagent pattern)
---

# Command-Subagent Pattern Generator

You will create a new sub-agent and its corresponding slash command based on the provided arguments.

## Arguments provided: $ARGUMENTS

## Task:

First, check if arguments are provided. If no arguments or if the first argument is "help", show usage information instead of creating files.

If arguments are provided, parse them and create two files:

1. **Sub-agent file**: `~/.claude/agents/<agent-name>.md`
2. **Slash command file**: `~/.claude/commands/<agent-name>.md`

### Help Display:

If no arguments or first argument is "help", display:

```
Usage: /cmd-suba <agent-name> "<description>" ["<system-prompt>"]

Creates a sub-agent and corresponding slash command (command-subagent pattern)

Arguments:
  agent-name    : Name of the sub-agent (use hyphens, no spaces)
  description   : When the sub-agent should be used (in quotes)
  system-prompt : Optional custom prompt for the sub-agent (in quotes)

Examples:
  Basic:
    /cmd-suba test-runner "Run tests automatically"

  With custom prompt:
    /cmd-suba code-reviewer "Review code" "You are an expert reviewer. Focus on security and performance."

  Multi-line prompt:
    /cmd-suba debugger "Debug errors" "Expert debugger.
    1. Analyze errors
    2. Find root cause
    3. Fix issues"

Creates:
  ~/.claude/agents/<agent-name>.md     - Sub-agent definition
  ~/.claude/commands/<agent-name>.md   - Slash command to launch it

After creation, use /<agent-name> to invoke the sub-agent.
```

### Parsing Instructions:

If valid arguments are provided, parse as follows:

- First word: agent name (e.g., `test-runner`)
- Text in first quotes: agent description
- Text in second quotes (optional): system prompt

### File Creation:

#### 1. Sub-agent file (`~/.claude/agents/<agent-name>.md`):

```markdown
---
name: <agent-name>
description: <description>
---

<system-prompt or default prompt>
```

If no system prompt is provided, use this default:
"You are a specialized assistant for the task described above. Execute your responsibilities efficiently and report results clearly."

#### 2. Slash command file (`~/.claude/commands/<agent-name>.md`):

```markdown
---
description: Launch <agent-name> sub-agent
---

Use the <agent-name> subagent to complete the following task: $ARGUMENTS
```

### Steps to execute:

1. Parse the arguments to extract agent-name, description, and optional system-prompt
2. Check if the agent already exists
3. Create the agents directory if it doesn't exist: `mkdir -p ~/.claude/agents`
4. Create the sub-agent file
5. Create the slash command file
6. Report success with the created file paths

### Error Handling:

- If agent-name already exists, ask for confirmation before overwriting
- If parsing fails, provide clear error message about expected format
- Ensure both files are created successfully before reporting completion

Execute this task now.
