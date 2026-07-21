# Local command permission judge

pi-harness uses a qualified local Ollama model as the fallback classifier for
Bash tool calls that match no deterministic permission rule. This approximates
Claude Code auto mode using bounded current-task and active-project context,
without sending conversation history or repository contents to the judge.

## Setup

Install Ollama **v0.16.2 or newer**, disable Ollama Cloud, and load the pinned
model. The checked-in model was qualified with Ollama 0.32.0.

```bash
ollama pull qwen2.5
ollama run qwen2.5:latest 'Reply only ALLOW' >/dev/null
curl -fsS http://127.0.0.1:11434/api/status | jq -e '.cloud.disabled == true'
curl -fsS http://127.0.0.1:11434/api/tags |
  jq -e '.models[] | select(.name == "qwen2.5:latest") |
    .digest == "845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e"'
```

Ollama Desktop exposes a Cloud toggle. The equivalent server setting is
`{"disable_ollama_cloud":true}` in `~/.ollama/server.json`; restart Ollama
after changing it. Disabling Cloud does not disable downloaded local models.
The judge verifies `cloud.disabled === true` through `/api/status` before each
command-bearing request and fails closed on old or misconfigured servers.

The first cold model or classifier-prompt load can exceed the two-second shared
request budget. Keeping the model listed by `ollama ps` avoids model startup;
a first classification after a policy/reload may still ask once while Ollama
builds its prompt cache. Each request sets `keep_alive: "30m"`.

Ollama's local HTTP API is unauthenticated. pi-harness trusts the local account
and the process bound to the configured loopback port. It verifies the server's
reported Cloud state, model metadata, and manifest digest, but separate status,
tags, and chat connections cannot eliminate a hostile local process or an
adversarial model swap between requests.

## Configuration

The judge is enabled by default. Override it in the machine-local
`~/.pi/agent/pi-harness.local.json`:

```json
{
  "permissionJudge": {
    "enabled": true,
    "url": "http://127.0.0.1:11434/api/chat",
    "model": "qwen2.5:latest",
    "expectedDigest": "845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e",
    "timeoutMs": 2000,
    "keepAlive": "30m"
  }
}
```

Set `enabled` to `false` to restore the previous rule-only behavior. The URL
must use HTTP with literal `127.0.0.1` or `[::1]`, the exact `/api/chat` path,
and no credentials, query, fragment, or redirect. The judge derives
`/api/status` and `/api/tags` on that same numeric-loopback origin.
The model must include an explicit tag such as `:latest` so its configured name
exactly matches `/api/tags`. `expectedDigest` must be the exact lowercase 64-hex
manifest digest returned by that endpoint. Models with a `:cloud` tag or name
containing `cloud` are rejected.
Invalid explicit settings never fall back to a remote or different model; they
require human confirmation or block. Interactive permission confirmations have
no countdown: they remain open until the user responds or aborts the active pi
operation (for example with Esc).

## Decision order

1. Mandatory deny rule: block.
2. Explicit allow rule: approve without Ollama.
3. Built-in/dynamic/opaque ask rule: ask the user, or block without UI.
4. ANSI-C `$'…'` syntax is never eligible for automatic approval. Its decoded
   text remains available to the concrete deny floor, but byte/escape semantics
   are conservatively fixed at `ASK` instead of being approximated as Bash argv.
5. For an otherwise unknown compound command, treat one leading top-level
   `cd <absolute-literal-path> &&` segment as neutral only when the canonical
   destination is contained by the complete registered non-bare worktree set
   and has the same canonical Git common directory as the tool cwd. Every
   remaining executable segment must be explicitly allowed; relative/dynamic
   paths, redirects, other connectors, multiple `cd` segments, missing paths,
   forged `.git` pointers, and unrelated or nested repositories do not receive
   this exception.
6. For a command that still reaches the judge, bind the raw current input to
   its agent run and discover canonical cwd/project/worktree context locally.
   Async child-environment sanitization, Git probes, cwd/worktree/leading-target
   canonicalization, and common-directory checks share one cumulative 250 ms
   deadline and abort signal.
7. Derive conservative scope evidence for one literal leading `cd`: registered
   worktree, outside the registered roots, or unverified.
8. Reuse an unexpired completed `ALLOW` cache entry only when the command,
   raw cwd, complete raw-task fingerprint, and complete verified-project
   fingerprint match. A task-correlation failure disables both cache reads and
   writes. Context discovery therefore precedes cache lookup.
9. Before a cache-miss chat request, require `/api/status` to report
   `cloud.disabled === true`.
10. Require `/api/tags` to contain exactly one exact-name model entry whose
    `name`, `model`, and pinned digest match and which has no `remote_host` or
    `remote_model` field.
11. Query `/api/chat`, then require the exact configured response model, no
    remote metadata, a completed non-truncated response, and an entire verdict
    of `ALLOW`. Every other result asks the user or blocks without UI.

The checked-in allow entries mirror the broad Bash grants in
`claude/.claude/settings.json`. They represent explicit user trust, not a claim
that every `bun`, `find`, `gh`, or similar subcommand is intrinsically safe.
Wrappers, alternate or quoted executable paths, dynamic expansions,
redirections, and background execution do not inherit an allow entry. Quoted
literal arguments remain concrete, but embedded whitespace remains inside its
original argv word and cannot satisfy a multi-word allow prefix. Except for the
narrow same-repository leading `cd` case above, a compound command bypasses
Ollama only when every executable segment is explicitly allowed.

When Ollama is unavailable or cannot be verified, TUI/RPC sessions show a
confirmation and non-interactive/child sessions block unknown commands. A
five-second fail-closed circuit avoids paying the complete timeout repeatedly
after transport and HTTP failures; it never grants approval. Pressing
Esc/aborting pi cancels classification and does not open a new confirmation
dialog.

## Data and latency

The command-bearing `/api/chat` request receives only:

- the fixed safety-classifier system instruction;
- the literal shell command;
- up to 1 KiB of normalized raw input for the current agent run and its source;
- canonical cwd plus a tagged Git/non-Git/unavailable project result;
- for Git, bounded project name, active worktree, and a display-only subset of
  canonical non-bare worktree roots (up to 16 roots / 2 KiB total); boundary
  checks use the complete canonical set locally, never this truncated subset;
  bare Git database paths may identify the project locally but are never
  navigation scope;
- computed leading-`cd` scope (`listed-worktree`, outside, or unverified).

Task context comes from pi's raw `input` event. Skill/template expansion,
system prompts, prior conversation, context files, tool results, environment,
repository file contents, Git remotes, and credentials are not sent. Pending
input becomes active only after an established append-only message baseline,
a positive user-message delta, Pi's steering-before-follow-up delivery order,
and a unique positional match prove correlation. Baseline loss, compaction with
pending input, duplicate text/source ambiguity, stale/dequeued input, and queue
overflow produce an explicit `uncorrelated` state. That state sends no task and
cannot read or write the `ALLOW` cache. A valid active task remains stable across
earlier tool turns/retries and clears at `agent_settled` or session shutdown.
Raw `/skill:name` and prompt-template invocations are retained only after their
corresponding expanded turn is observably active.
The local Git discovery command sends nothing to Ollama and reads only Git
worktree metadata. `/api/status` and `/api/tags` contain no command or context.
Direct numeric-loopback TCP ignores ambient `HTTP_PROXY`/`HTTPS_PROXY`, and
redirects are not followed.

The complete permission-discovery phase has a separate cumulative 250 ms cap,
including async PATH sanitization, all Git processes, and every filesystem
canonicalization; status, tags, and chat then share one `timeoutMs` budget. If
preflight consumes that budget, chat is not started. Literal commands over 2 KiB, JSON-escaped commands over 2,800 bytes,
complete classifier messages over 10 KiB, Git output over 64 KiB, and responses
over 64 KiB are not auto-approved. The model context is 16,384 tokens: the
10 KiB content cap fits even under byte-fallback tokenization, with room for
the chat template and verdict.

Successful decisions are cached for five minutes in a 128-entry per-session
LRU. Cache keys hash the exact system prompt, model/digest, raw cwd, complete
raw-task fingerprint, complete verified-project fingerprint, and bounded request
envelope. Raw task, command, and omitted worktree text is not retained in cache
entries. ASK, timeout, malformed, aborted, unverified, unavailable, and
uncorrelated outcomes are never cached.

## Security limitations

A small LLM is a best-effort classifier, not a proof of safety. Current-task
text, project/path names, comments, quoted strings, and here-documents can be
adversarial. Project identity and the leading-`cd` scope are computed locally,
but they establish relevance/scope only and never prove command safety. The
existing parser and deterministic deny/ask floor run first. Parser uncertainty
is blocked without consulting the classifier; classifier uncertainty must return
`ASK`. Top-level `<<` syntax and backslash-newline continuations in executable
contexts are deliberately unsupported and blocked before the judge: partial
reconstruction can otherwise hide executable substitutions or later commands.
Balanced arithmetic expansions such as
`$((1 << 2))` remain supported because their contents are consumed as one
expansion. ANSI-C quoting is conservatively fixed at the deterministic ask floor:
JavaScript Unicode strings cannot reproduce every unknown escape and raw-byte
pathname that Bash can place in argv.

The contextual path applies only to commands that reach the fallback judge.
The broad explicit allow entries described above still bypass it by design, so
classifier qualification is not a global guarantee for every `bun`, `cargo`,
`find`, or `gh` subcommand.

Routine Git candidates are classified from command shape and verified project
scope only. Git hooks, filters, credential/transport helpers, and repository or
user configuration are not inspected and can add side effects to commands such
as `commit`, `fetch`, or `pull`. Auto-approval therefore assumes the active
repository and local Git configuration are trusted; this mode is not suitable
for untrusted repositories.

The policy covers LLM-issued `bash` tool calls. User-entered `!`/`!!` commands
are intentionally outside it. pi also permits later third-party `tool_call`
handlers to mutate arguments; pi-harness's own later handlers do not mutate
Bash commands, but pi currently exposes no final immutable pre-execution hook.

## Qualification

Run the checked-in production-path corpus without executing any sample:

```bash
bun run qualify:pi-permission-judge
```

The command creates a fresh production `createPermissionJudge` instance per
sample, so every sample performs live status, tags, and chat requests. Each
sample carries synthetic bounded task/project context and an exact expected
`ALLOW` or `ASK`; any mismatch, timeout, unavailable, or malformed result fails.
Samples are classified but never executed. Separate policy integration tests
cover deterministic production routing and exact chat-request counts. The JSON
report records every literal command, expected verdict, and outcome.

### Checked-in default qualification record

- Qualified at: `2026-07-21T02:25:23.937Z`
- Ollama: `0.32.0`
- Model: `qwen2.5:latest` (7.6B, Q4_K_M)
- `/api/tags` manifest digest:
  `845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e`
- Shared timeout: `2000ms`
- Live contextual verdicts: `36/36` (two consecutive complete passes)
- Required-safe: `13/13 ALLOW` (reads, lint/test/typecheck/format, local Git,
  fetch/pull, linked-worktree navigation)
- Required-confirmation: `23/23 ASK` (destructive Git/filesystem,
  privilege/exfiltration, opaque execution, unavailable project identity,
  unrelated/prefix-confusable/traversal paths, Git location/config/force
  variants, outside-project redirection, push/transport/upload, and prompt
  injection)
- Independent hold-out after prompt tuning: `5/5`

Automated protocol and routing tests do not require Ollama:

```bash
bun test tests/pi-harness/permission-judge-context.test.ts \
  tests/pi-harness/permission-judge.test.ts \
  tests/pi-harness/permission-judge-policy.test.ts \
  tests/pi-harness/permission-rules.test.ts \
  tests/pi-harness/qualify-permission-judge.test.ts
bun run check:pi-rules
bun run check:pi-imports
```

Before changing the default model or digest, rerun qualification against the
exact candidate manifest and update the version, digest, date, and results in
the same change. Any risky sample classified `ALLOW` is a release blocker for
that model/version.
