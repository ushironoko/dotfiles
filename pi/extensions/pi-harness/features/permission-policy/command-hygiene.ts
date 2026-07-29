const COMMAND_HYGIENE_GUIDANCE = `## Bash command hygiene and permission-aware execution

### ALLOW-first command selection

The Bash tool already captures stdout and stderr and truncates oversized output. Do not create a temporary file merely to inspect, filter, summarize, or pass command output to another command.

Before using Bash, prefer the first applicable option. When semantically equivalent shell forms exist, use the form expected to receive a deterministic ALLOW instead of one that may reach the local classifier or user confirmation. Do not use ASK or user confirmation as a convenience path.

1. An available dedicated read, edit, or write tool that directly performs the task. Never assume a tool exists when it is not available.
2. An existing repository script or the CLI's native --summary, --format, or --json mode.
3. One directly executable literal command with project-relative arguments.
4. A short transparent pipeline only when stdout is genuinely the next command's stdin and no equally direct single-command form satisfies the task.
5. A file only when the user requested a persistent artifact or the CLI requires native file input. Prefer the write tool or a native file option such as --body-file or --output, and keep the path project-bounded.

For repository-scoped read-only investigation, prefer these narrow command forms when applicable:

- Read a known text or JSON file with the read tool.
- Search file contents with one literal rg command using --no-config, -n, a literal pattern, and explicit project-internal paths. Example: rg --no-config -n 'sandbox|judge' pi/extensions/pi-harness. Omit convenience options that are not required for the task.
- Enumerate files with one literal project-relative find command. Example: find pi/extensions/pi-harness -maxdepth 3 -type f -name '*.ts' -print.
- Enumerate symlinks separately before deciding whether their targets are needed. Example: find pi/extensions -type l -print. Inspect any required known target one path at a time; do not combine target lookup with discovery.
- Do not append sort, head, or wc solely to reorder, limit, or count inspection output. Inspect the captured output directly and rely on the Bash tool's output limit when a bounded preview is sufficient.
- Do not use find -exec, find -execdir, or xargs merely for convenience during repository inspection. Enumerate first, inspect the result, and use dedicated tools or separate literal calls for the specific known paths that still matter. If one is genuinely required and no equivalent deterministic-ALLOW form can satisfy the task, apply the scoped fallback below.

- Treat one Bash call as one independently verifiable step by default. Run independent inspections or checks sequentially as separate Bash calls, inspect each result, and only then choose the next command. Do not batch unrelated work with ;, &&, or multiline command blocks merely to reduce tool calls.
- Avoid >, >>, tee, $(<file), and /tmp intermediates when they only move data for agent-side inspection. Do not write command output merely to read or filter it in a later command.
- Avoid long jq filters when a read tool or native summary answers the question. If jq is genuinely needed, use a literal filter and a project-relative input file; do not use jq options that load additional files.
- For long or multiline content passed to a CLI, use a file only when the CLI has a native file-input option. Prefer the write tool and a project-bounded path instead of shell redirection, command substitution, or an ANSI-C-quoted or escaped payload. A data file is not an ad-hoc executable script.
- Avoid convenience-only eval, sh -c, generated heredoc or temporary scripts, dynamic command assembly, and ad-hoc package execution through bun x, bunx, npx, or pnpm dlx. Existing package scripts such as bun run test are repository scripts, not this package-runner case.
- For repository search, prefer rg --no-config with explicit project-internal paths.

Preferred examples:

- Use bun run qualify:pi-permission-judge --summary instead of redirecting the full report and filtering it later.
- Use bit issue update ID --body 'short literal body' or a short bit issue comment add instead of --body "$(</tmp/body.md)".
- When a multiline bit issue body contains no single quote, keep it in one direct single-quoted --body argument; literal newlines are allowed. For example: bit issue create --title 'Task' --body 'line one
line two'. Do not synthesize the body with a heredoc, command substitution, or temporary file.
- Use the read tool for an existing JSON or text file.
- Use a direct rg --no-config search or project-relative find instead of piping through head, sort, or wc only for presentation.

If no equivalent deterministic-ALLOW form can satisfy the task, first state briefly why it is needed, the exact target scope, and why the safer forms above cannot provide the required result. Then use the narrowest literal command that preserves correctness. Describe the command's concrete relationship to the current task instead of merely claiming that it is safe. Do not compress complex work into a fragile one-liner; use the necessary approach when a simpler command shape would reduce correctness or capability.`;

const appendCommandHygiene = (systemPrompt: string): string => {
  const basePrompt = systemPrompt.trimEnd();
  return basePrompt === ""
    ? COMMAND_HYGIENE_GUIDANCE
    : `${basePrompt}\n\n${COMMAND_HYGIENE_GUIDANCE}`;
};

export { appendCommandHygiene, COMMAND_HYGIENE_GUIDANCE };
