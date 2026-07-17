# Local command permission judge

pi-harness uses a qualified local Ollama model as the fallback classifier for
Bash tool calls that match no deterministic permission rule. This approximates
Claude Code auto mode without sending the agent conversation or repository
contents to the judge.

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

The first cold model load can exceed the two-second shared request budget.
Keeping the model listed by `ollama ps` avoids that startup penalty. Each judge
request also sets `keep_alive: "30m"`.

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
    "confirmTimeoutMs": 30000,
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
require human confirmation or block.

## Decision order

1. Mandatory deny rule: block.
2. Explicit allow rule: approve without Ollama.
3. Built-in/dynamic/opaque ask rule: ask the user, or block without UI.
4. For an unknown command, reuse an unexpired completed `ALLOW` cache entry if
   one exists. This sends no request.
5. Before a cache-miss chat request, require `/api/status` to report
   `cloud.disabled === true`.
6. Require `/api/tags` to contain exactly one exact-name model entry whose
   `name`, `model`, and pinned digest match and which has no `remote_host` or
   `remote_model` field.
7. Query `/api/chat`, then require the exact configured response model, no
   remote metadata, a completed non-truncated response, and an entire verdict
   of `ALLOW`. Every other result asks the user or blocks without UI.

The checked-in allow entries mirror the broad Bash grants in
`claude/.claude/settings.json`. They represent explicit user trust, not a claim
that every `bun`, `find`, `gh`, or similar subcommand is intrinsically safe.
Wrappers, alternate or quoted executable paths, dynamic expansions,
redirections, and background execution do not inherit an allow entry. Quoted
literal arguments remain concrete, but embedded whitespace remains inside its
original argv word and cannot satisfy a multi-word allow prefix. A compound
command bypasses Ollama only when every executable segment is explicitly
allowed.

When Ollama is unavailable or cannot be verified, TUI/RPC sessions show a
confirmation and non-interactive/child sessions block unknown commands. A
five-second fail-closed circuit avoids paying the complete timeout repeatedly
after transport and HTTP failures; it never grants approval. Pressing
Esc/aborting pi cancels classification and does not open a new confirmation
dialog.

## Data and latency

The command-bearing `/api/chat` request receives only:

- the fixed safety-classifier system instruction;
- the literal shell command, encoded as an untrusted JSON string.

The preceding `/api/status` and `/api/tags` requests contain no command. The
judge does not send cwd, environment, files, repository state, conversation
history, or tools, and it performs no investigation. Direct numeric-loopback
TCP connections ignore ambient `HTTP_PROXY`/`HTTPS_PROXY`, and redirects are
not followed.

Status, tags, and chat share one `timeoutMs` budget. If preflight consumes the
budget, the command-bearing POST is not started. Commands over 2 KiB,
serialized classifier prompts over 3 KiB, and any response over 64 KiB are not
auto-approved. The model context is 4,096 tokens so the bounded prompt and chat
framing fit without silent left/right truncation.

Successful decisions are cached for five minutes in a 128-entry per-session
LRU. Cache keys are SHA-256 hashes over policy/model/digest/cwd/command; raw
command text is not retained in the cache. ASK, timeout, malformed, aborted,
unverified, and unavailable results are never cached.

## Security limitations

A small LLM is a best-effort classifier, not a proof of safety. Prompt text
inside comments, quoted strings, or here-documents can be adversarial. The
existing parser and deterministic deny/ask floor run first. Parser uncertainty
is blocked without consulting the classifier; classifier uncertainty must return
`ASK`. Top-level `<<` syntax and backslash-newline continuations in executable
contexts are deliberately unsupported and blocked before the judge: partial
reconstruction can otherwise hide executable substitutions or later commands.
Balanced arithmetic expansions such as
`$((1 << 2))` remain supported because their contents are consumed as one
expansion.

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
sample, so every sample performs live status, tags, and chat requests. It exits
non-zero if a request is unavailable/malformed, if no benign command is
approved, or if any destructive, privilege/exfiltration, opaque, or adversarial
sample returns `ALLOW`. Its JSON output records every literal command and
verdict.

### Checked-in default qualification record

- Qualified at: `2026-07-16T07:49:16.211Z`
- Ollama: `0.32.0`
- Model: `qwen2.5:latest` (7.6B, Q4_K_M)
- `/api/tags` manifest digest:
  `845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e`
- Shared timeout: `2000ms`
- Live verdicts: `13/13`
- Benign reads: `3/3 ALLOW`
- Destructive: `3/3 ASK`
- Privilege/exfiltration: `2/2 ASK`
- Opaque execution: `2/2 ASK`
- Prompt injection combined with destructive actions: `3/3 ASK`

Automated protocol and routing tests do not require Ollama:

```bash
bun test tests/pi-harness/permission-judge.test.ts \
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
