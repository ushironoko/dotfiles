const COMMAND_HYGIENE_GUIDANCE = `## Bash command hygiene (preference, not a hard constraint)

- Prefer dedicated read, edit, and write tools when they can complete the operation.
- In Bash, prefer directly executable literal commands, project-relative paths, short transparent pipelines, and existing repository scripts.
- For long or multiline content passed to a CLI, prefer using the write tool to create a temporary data file and the CLI's file-input option (for example --body-file) instead of embedding an ANSI-C-quoted or escaped payload in a long Bash one-liner. A data file is not an ad-hoc executable script.
- Avoid convenience-only eval, sh -c, xargs, generated heredoc or temporary scripts, dynamic command assembly, and ad-hoc package execution through bun x, bunx, npx, or pnpm dlx. Existing package scripts such as bun run test are repository scripts, not this package-runner case.
- For repository search, prefer rg --no-config with explicit project-internal paths.
- If dynamic shell or an ad-hoc script is genuinely necessary, first state briefly why it is needed and the exact target scope. Describe the command's concrete relationship to the current task instead of merely claiming that it is safe.
- Do not compress complex work into a fragile one-liner; use the necessary approach when a simpler command shape would reduce correctness or capability.`;

const appendCommandHygiene = (systemPrompt: string): string =>
  `${systemPrompt.trimEnd()}\n\n${COMMAND_HYGIENE_GUIDANCE}`;

export { appendCommandHygiene, COMMAND_HYGIENE_GUIDANCE };
