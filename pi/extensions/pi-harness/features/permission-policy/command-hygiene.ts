const COMMAND_HYGIENE_GUIDANCE = `## Bash command hygiene (preference, not a hard constraint)

The Bash tool already captures stdout and stderr. Do not create a temporary file merely to inspect, filter, summarize, or pass command output to another command.

Before using Bash, prefer the first applicable option:

1. An available dedicated read, edit, or write tool that directly performs the task. Never assume a tool exists when it is not available.
2. An existing repository script or the CLI's native --summary, --format, or --json mode.
3. One directly executable literal command with project-relative arguments.
4. A short transparent pipeline only when stdout is genuinely the next command's stdin.
5. A file only when the user requested a persistent artifact or the CLI requires native file input. Prefer the write tool or a native file option such as --body-file or --output, and keep the path project-bounded.

- Treat one Bash call as one independently verifiable step by default. Run independent inspections or checks sequentially as separate Bash calls, inspect each result, and only then choose the next command. Do not batch unrelated work with ;, &&, or multiline command blocks merely to reduce tool calls.
- Avoid >, >>, tee, $(<file), and /tmp intermediates when they only move data for agent-side inspection. Do not write command output merely to read or filter it in a later command.
- Avoid long jq filters when a read tool or native summary answers the question. If jq is genuinely needed, use a literal filter and a project-relative input file; do not use jq options that load additional files.
- For long or multiline content passed to a CLI, use a file only when the CLI has a native file-input option. Prefer the write tool and a project-bounded path instead of shell redirection, command substitution, or an ANSI-C-quoted or escaped payload. A data file is not an ad-hoc executable script.
- Avoid convenience-only eval, sh -c, xargs, generated heredoc or temporary scripts, dynamic command assembly, and ad-hoc package execution through bun x, bunx, npx, or pnpm dlx. Existing package scripts such as bun run test are repository scripts, not this package-runner case.
- For repository search, prefer rg --no-config with explicit project-internal paths.

Preferred examples:

- Use bun run qualify:pi-permission-judge --summary instead of redirecting the full report and filtering it later.
- Use bit issue update ID --body 'short literal body' or a short bit issue comment add instead of --body "$(</tmp/body.md)".
- When a multiline bit issue body contains no single quote, keep it in one direct single-quoted --body argument; literal newlines are allowed. For example: bit issue create --title 'Task' --body 'line one
line two'. Do not synthesize the body with a heredoc, command substitution, or temporary file.
- Use the read tool for an existing JSON or text file.
- Use rg --no-config ... | head -200 instead of writing search results and reading them back.

If dynamic shell, an ad-hoc script, or a less direct form is genuinely required for correctness or a requested artifact, first state briefly why it is needed and the exact target scope. Describe the command's concrete relationship to the current task instead of merely claiming that it is safe. Do not compress complex work into a fragile one-liner; use the necessary approach when a simpler command shape would reduce correctness or capability.`;

const appendCommandHygiene = (systemPrompt: string): string =>
  `${systemPrompt.trimEnd()}\n\n${COMMAND_HYGIENE_GUIDANCE}`;

export { appendCommandHygiene, COMMAND_HYGIENE_GUIDANCE };
