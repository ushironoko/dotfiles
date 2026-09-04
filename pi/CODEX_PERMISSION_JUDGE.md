# Codex command permission judge

Pi-harness uses a pinned Codex CLI as the semantic fallback for Bash commands that deterministic policy cannot decide. The default model is `gpt-5.6-luna`.

The judge is not the primary safety boundary. Deterministic deny/ask rules, verified project and worktree scope, the ordinary Bash OS sandbox, explicit confirmation, and fail-closed permission-audit writes remain authoritative.

## Motivation and cost

A small on-device model can be unreliable on shell semantics, task relevance, and project boundaries. The Codex judge trades local inference for stronger command classification.

Codex inference consumes account quota or paid tokens. Mechanical rules decide known-safe and known-risky forms without a model call. Successful contextual ALLOW results are cached for five minutes only while the pinned runtime identity remains unchanged. Escalated calls bypass the cache. The qualification corpus deliberately forces many live calls and is substantially more expensive than ordinary use.

## Trust anchor and authentication

The judge is disabled unless machine-local configuration provides both:

- the canonical absolute path of the Codex executable;
- the lowercase SHA-256 of those exact executable bytes.

The supported runtime is `codex-cli 0.145.0`. The executable must be a regular, single-link, owner-controlled file beneath canonical ancestors owned by the current user or root and not writable by group or other. The runtime verifies path, digest, owner, mode, device, inode, size, link count, and ancestor identity before cache lookup, before and after each process, and before returning ALLOW. A replacement or metadata change fails closed and invalidates cached approvals.

These checks detect changes but do not make Node's path-based spawn atomic with verification. A malicious process already running as the same UID can replace user-owned paths between the final check and kernel execution. The executable digest also does not cover an interpreter, shared libraries, or adjacent runtime assets that the executable may load. A pre-existing same-UID host compromise and modification of these transitive dependencies are outside the judge boundary; do not describe the checks as complete TOCTOU prevention.

Find the canonical path and digest without relying on them as runtime discovery:

```bash
CODEX_PATH="$(realpath "$(command -v codex)")"
printf '%s\n' "$CODEX_PATH"
shasum -a 256 "$CODEX_PATH"
"$CODEX_PATH" --version
```

Authenticate the installed CLI normally. The judge accepts only a canonical, private `~/.codex/auth.json` with the known Codex authentication fields. It validates a bounded snapshot and copies only that file into an isolated `CODEX_HOME` with mode `0600`. It does not copy user configuration, rules, skills, plugins, hooks, MCP settings, memories, or AGENTS files. Unknown authentication fields, symlinks, hardlinks, public modes, mutable ancestry, or oversized input make the judge unavailable.

## Configuration

Trust anchors and optional overrides belong only in `~/.pi/agent/pi-harness.local.json`:

```json
{
  "permissionJudge": {
    "enabled": true,
    "executablePath": "/canonical/absolute/path/to/codex",
    "expectedExecutableSha256": "64-lowercase-hex-characters",
    "model": "gpt-5.6-luna",
    "timeoutMs": 30000,
    "confirmTimeoutMs": 10000
  }
}
```

Fields:

- `enabled`: enables semantic fallback only when both trust anchors are valid.
- `executablePath`: canonical absolute executable path; PATH lookup is never used.
- `expectedExecutableSha256`: expected SHA-256 of the executable bytes.
- `model`: model passed directly to `codex exec --model`; the default is `gpt-5.6-luna`.
- `timeoutMs`: one live Codex invocation budget, from 1,000 through 120,000 ms.
- `confirmTimeoutMs`: interactive confirmation budget, from 1,000 through 300,000 ms.

Unknown, null, malformed, missing, or out-of-range fields make the judge unavailable rather than silently changing behavior. Disable it with `enabled: false`; residual dynamic commands then require interactive confirmation and block when UI is unavailable.

After an intentional Codex upgrade, review the new release's configuration and tool construction, rerun the live isolation and qualification checks, then update both the canonical path and digest. An unreviewed version is unsupported even if its command-line syntax appears compatible.

## Invocation boundary

Each decision executes the configured absolute executable directly, never through a shell. The invocation fixes:

```text
-a never
exec
--ephemeral
--ignore-user-config
--ignore-rules
--strict-config
--skip-git-repo-check
--color never
--model gpt-5.6-luna
-c model_instructions_file=<private trusted policy file>
-c model_catalog_json=<private pinned catalog file>
-c model_reasoning_effort="low"
-c default_permissions="pi_permission_judge"
-c permissions.pi_permission_judge.filesystem={":root"="deny",<workspace>="read"}
-c permissions.pi_permission_judge.network.enabled=false
-c <fixed instruction, project-doc, request-input, and web-search disables>
--disable <fixed tool-capable feature manifest>
--output-schema <private schema file>
-
```

The private model catalog pins the supported model to direct-tool mode with shell disabled, no apply-patch tool, no multi-agent mode, text-only input, and no search support. This prevents mutable user or remote model metadata from restoring CodeMode executors. Strict configuration rejects unsupported fields instead of ignoring an intended boundary.

Every call creates sibling `0700` workspace, HOME, CODEX_HOME, and TMPDIR directories under `~/.pi/agent/pi-harness/permission-judge`. That runtime root must be canonical, private, owner-controlled, and outside every registered project worktree. The trusted classifier policy, output schema, and model catalog are written as `0600` files. The complete invocation directory is removed after success, failure, timeout, or cancellation; a cleanup failure makes the result unavailable.

The child receives a fixed minimal environment. Provider, proxy, CA, loader, shell-startup, Git, package-manager, project-location, and inherited credential variables are not propagated. Only the validated auth snapshot enters isolated CODEX_HOME.

The named Codex permission profile denies filesystem access at `:root`, grants read access only to the private classifier workspace, and disables network. The pinned visible tool inventory is exactly `functions.update_plan` and `functions.view_image`; there is no process execution, write, request-input, web, MCP, plugin, hook, skill, browser, computer-use, or multi-agent tool. `view_image` remains confined to the private workspace, which contains only trusted judge inputs and the hostile project-instruction probe.

Before its first classification, each judge process runs a structured capability attestation with a hostile workspace `AGENTS.md` and a valid image immediately outside the readable workspace. It requires the exact pinned tool inventory, requires the instruction sentinel to be invisible, and invokes `view_image` once to require that the outside image is denied. Missing, duplicate, extra, renamed, or malformed tools, visible project instructions, readable outside-workspace data, a changed model surface, an unsupported CLI version, or a failed probe makes the judge unavailable. The attestation is not an allowlist expansion mechanism.

The shared bounded-process runner limits stdin, stdout, stderr, wall time, and the entire child process group. Parent cancellation terminates the process group. Approval is disabled.

The stdin envelope contains only bounded command/task/run evidence and harness-verified project, navigation, and execution-boundary metadata. It excludes assistant thinking, tool arguments, arbitrary tool-result bodies, expanded skills, remotes, and environment values. Command and task text remain untrusted data under the higher-priority classifier policy.

## Decision contract

The versioned JSON Schema accepts exactly:

```json
{
  "safety": "ALLOW",
  "relevance": "ALLOW"
}
```

Each gate is independently `ALLOW` or `ASK`. Automatic approval requires both gates to be `ALLOW`. Any other shape, additional field, malformed JSON, invalid UTF-8, oversized output, non-zero exit, timeout, missing authentication, model failure, isolation failure, runtime identity change, or cancellation is non-allowing.

- `ASK` and invalid model output continue to interactive confirmation.
- timeout or unavailable CLI opens a short circuit breaker and continues to confirmation.
- no-UI sessions block instead of failing open.
- parent cancellation blocks without prompting.

Only complete ALLOW decisions are cached. Cache keys include the policy, schema, isolation profile and model-catalog fingerprints, model, reasoning effort, executable runtime identity, command, cwd, task/run fingerprints, execution boundary, and verified project context. Uncorrelated tasks and escalated execution do not populate or reuse the cache.

## Audit

Permission audit judge stages record:

- backend `codex-cli`;
- model and fixed `low` reasoning effort;
- policy version;
- live or cache source;
- safety and relevance gates;
- final outcome and confirmation status.

Audit records contain raw shell commands and bounded contextual evidence. Treat the audit directory as sensitive local data. Analysis exports remain unlabeled until a human supplies expected outcomes.

## Qualification

Run focused verification:

```bash
bun test tests/pi-harness/permission-judge.test.ts \
  tests/pi-harness/permission-judge-runtime.test.ts \
  tests/pi-harness/permission-judge-context.test.ts \
  tests/pi-harness/permission-judge-policy.test.ts \
  tests/pi-harness/permission-rules.test.ts \
  tests/pi-harness/qualify-permission-judge.test.ts
bun run tsc
bun run lint
```

Run the production-faithful live corpus only when the token cost is acceptable:

```bash
bun run qualify:pi-permission-judge --summary
```

The report records the Codex version, canonical executable and SHA-256, model, reasoning effort, policy/schema/isolation fingerprints, corpus version, timeout, production-path metrics, residual-safety metrics, direct-model metrics, and exact acceptance thresholds. It returns non-zero for CLI/version failure, missing live verdicts, unsafe false ALLOW results, residual required-ASK misses, excessive false ASK results, timeout, or unavailable inference.

## Troubleshooting

- `Codex judge is disabled by configuration`: add both machine-local executable trust anchors or set `enabled: false` intentionally.
- `Codex judge runtime identity changed`: recheck the canonical file, digest, ownership, modes, ancestors, and runtime root; do not update the digest until the new binary is reviewed.
- `Codex CLI could not be executed`: run the configured absolute executable directly, verify `codex-cli 0.145.0`, authentication, strict settings, and capability inventory.
- `Codex judge timed out`: increase `timeoutMs` within the supported range or check service latency.
- `Codex judge returned invalid JSON`: verify the selected model supports the pinned structured response.
- repeated confirmation after an outage: the five-second circuit breaker intentionally avoids repeated failing process launches.
