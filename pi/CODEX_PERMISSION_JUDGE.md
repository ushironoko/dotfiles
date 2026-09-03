# Codex command permission judge

Pi-harness uses Codex CLI as the default semantic fallback for Bash commands that deterministic policy cannot decide. The default model is `gpt-5.6-luna`.

The judge is not the primary safety boundary. Deterministic deny/ask rules, verified project/worktree scope, the ordinary Bash OS sandbox, explicit confirmation, and fail-closed permission-audit writes remain authoritative.

## Motivation and cost

A small on-device model is inexpensive but can be unreliable on shell semantics, command relevance, and subtle project boundaries. The Codex judge trades local inference for a stronger model and better command decisions.

Codex inference consumes account quota or paid tokens. Mechanical rules still decide known-safe and known-risky forms without a model call, and successful contextual ALLOW results are cached for five minutes. Escalated calls bypass that cache. The qualification corpus deliberately forces many live calls and is substantially more expensive than normal interactive use.

## Requirements

Install and authenticate Codex CLI:

```bash
codex --version
codex login status
```

Authentication remains available when the judge invokes `codex exec` with `--ignore-user-config`; the global model, plugins, hooks, MCP servers, and other user configuration are not loaded.

## Configuration

Optional overrides belong in `~/.pi/agent/pi-harness.local.json`:

```json
{
  "permissionJudge": {
    "enabled": true,
    "model": "gpt-5.6-luna",
    "timeoutMs": 30000,
    "confirmTimeoutMs": 10000
  }
}
```

Fields:

- `enabled`: enables semantic fallback.
- `model`: model passed directly to `codex exec --model`; the default is `gpt-5.6-luna`.
- `timeoutMs`: one live Codex invocation budget, from 1,000 through 120,000 ms.
- `confirmTimeoutMs`: interactive confirmation budget, from 1,000 through 300,000 ms.

Unknown or malformed fields make the judge unavailable rather than silently changing behavior. Disable the judge with `enabled: false`; residual dynamic commands then require interactive confirmation and block when UI is unavailable.

## Invocation boundary

Each live decision executes `codex` directly without a shell. The invocation fixes:

```text
-a never
exec
--ephemeral
--ignore-user-config
--ignore-rules
--strict-config
--sandbox read-only
--skip-git-repo-check
--color never
--model gpt-5.6-luna
-c model_instructions_file=<private temporary file>
-c model_reasoning_effort="low"
--disable <every tool-capable feature>
--output-schema <private temporary schema copy>
-
```

Each call creates an empty `0700` temporary workspace outside the active project, then copies the repository-owned output schema and classifier policy into `0600` files there. Codex receives only those private copies; stdin contains only the untrusted command/context JSON, `PWD` points to the temporary workspace, and inherited project-location variables are removed. The workspace is removed after success, failure, timeout, or cancellation. A cleanup failure makes the result unavailable.

The shared bounded-process runner limits stdin, stdout, stderr, wall time, and the entire child process group. Parent cancellation terminates the process group. Approval is disabled, the sandbox is read-only, and shell, unified execution, code host, browser, computer-use, plugin, hook, MCP, skill, multi-agent, web-search, and workspace tool features are explicitly disabled. `--strict-config` turns unsupported isolation settings into a non-allowing CLI failure.

The stdin envelope contains only bounded command/task/run evidence and harness-verified project, navigation, and execution-boundary metadata. It excludes assistant thinking, tool arguments, arbitrary tool-result bodies, expanded skills, remotes, and environment values. Command and task text remain untrusted data under the higher-priority classifier policy.

## Decision contract

The versioned JSON Schema accepts exactly:

```json
{
  "safety": "ALLOW",
  "relevance": "ALLOW"
}
```

Each gate is independently `ALLOW` or `ASK`. Automatic approval requires both gates to be `ALLOW`. Any other shape, additional field, malformed JSON, invalid UTF-8, oversized output, non-zero exit, timeout, missing CLI, authentication failure, model failure, or cancellation is non-allowing.

- `ASK` and invalid model output continue to interactive confirmation.
- timeout or unavailable CLI opens a short circuit breaker and continues to confirmation.
- no-UI sessions block instead of failing open.
- parent cancellation blocks without prompting.

Only complete ALLOW decisions are cached. Cache keys include the policy prompt/version, model, reasoning effort, command, cwd, task/run fingerprints, execution boundary, and verified project context. Uncorrelated tasks and escalated execution do not populate or reuse the cache.

## Audit

Permission audit judge stages record:

- backend `codex-cli`
- model and fixed `low` reasoning effort
- policy version
- live or cache source
- safety and relevance gates
- final outcome and confirmation status

Audit records contain raw shell commands and bounded contextual evidence. Treat the audit directory as sensitive local data. Analysis exports remain unlabeled until a human supplies expected outcomes.

## Qualification

Run focused verification:

```bash
bun test tests/pi-harness/permission-judge.test.ts \
  tests/pi-harness/permission-judge-context.test.ts \
  tests/pi-harness/permission-judge-policy.test.ts \
  tests/pi-harness/permission-rules.test.ts \
  tests/pi-harness/qualify-permission-judge.test.ts
bun run tsc
bun run lint
```

Run the live qualification corpus only when the token cost is acceptable:

```bash
bun run qualify:pi-permission-judge --summary
```

The report records `codexVersion`, `model`, reasoning effort, policy version, timeout, production-path metrics, residual-safety metrics, direct-model metrics, and exact acceptance thresholds. It returns non-zero for CLI/version failure, missing live verdicts, unsafe false ALLOW results, excessive false ASK results, timeout, or unavailable inference.

## Troubleshooting

- `Codex CLI could not be executed`: verify `codex` is on the sanitized absolute `PATH` and run `codex login status`.
- `Codex CLI exited with code ...`: run `codex --version` and verify authentication/account quota outside Pi.
- `Codex judge timed out`: increase `timeoutMs` within the supported range or check service latency.
- `Codex judge returned invalid JSON`: verify the selected model supports structured output and the installed CLI supports `--output-schema`.
- repeated confirmation after an outage: the five-second circuit breaker intentionally avoids repeated failing process launches.
