# Local command permission judge

pi-harness uses a qualified local Ollama model as the fallback classifier for
Bash tool calls that remain ambiguous after deterministic permission routing.
This approximates Claude Code auto mode using bounded current-task,
current-assistant-run, and active-project context without sending prior-turn
conversation or repository contents to the judge.

## Setup

Install Ollama **v0.16.2 or newer**, disable Ollama Cloud, and load the pinned
model. The checked-in model was qualified with Ollama 0.32.0.

```bash
ollama pull granite4.1:3b
ollama run granite4.1:3b 'Reply only ALLOW' >/dev/null
curl -fsS http://127.0.0.1:11434/api/status | jq -e '.cloud.disabled == true'
curl -fsS http://127.0.0.1:11434/api/tags |
  jq -e '.models[] | select(.name == "granite4.1:3b") |
    .digest == "6fd349357287c7ffc9e38189a93b48ea175d24fc566b38f09cfc564fb7f303eb"'
```

Ollama Desktop exposes a Cloud toggle. The equivalent server setting is
`{"disable_ollama_cloud":true}` in `~/.ollama/server.json`; restart Ollama
after changing it. Disabling Cloud does not disable downloaded local models.
The judge verifies `cloud.disabled === true` through `/api/status` before each
command-bearing request and fails closed on old or misconfigured servers.

A cold model or classifier-prompt load can consume several seconds. Routine
real-repository requests measured over two seconds and a first qualification
request also crossed three seconds on the qualified model. Auto mode prioritizes
avoiding user feedback over a shorter fallback, so the default shared request
budget is ten seconds. Keeping the model listed by `ollama ps` avoids model
startup; a first classification after a policy/reload may still ask if Ollama
exceeds that budget while building its prompt cache. Each request sets
`keep_alive: "30m"`.

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
    "model": "granite4.1:3b",
    "expectedDigest": "6fd349357287c7ffc9e38189a93b48ea175d24fc566b38f09cfc564fb7f303eb",
    "timeoutMs": 10000,
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

## Command hygiene guidance

Before each parent or child agent run, the mandatory permission-policy feature
appends a short soft-preference section to the system prompt. It asks the model
to prefer dedicated file tools, literal commands, project-relative paths,
existing repository scripts, and canonicalizable `rg --no-config` searches.
Independent inspections and checks should run sequentially as separate Bash
calls, with each result inspected before choosing the next command. Short
pipelines are reserved for genuine producer/consumer data flow rather than
batching unrelated work with `;`, `&&`, or multiline blocks. Long or multiline
CLI data should use the write tool and a file-input option instead of an
ANSI-C-quoted or escaped one-liner.
Convenience-only dynamic shell and generated scripts are discouraged, not
forbidden. When an ad-hoc script is genuinely needed, the model is told to
preserve correctness/capability and first state its necessity, exact scope, and
concrete task relationship. This guidance only reduces
hard-to-parse command generation; it never replaces or weakens the deterministic
floor, explicit confirmation, or local judge.

## Decision order

1. Mandatory deny rule: block.
2. Mandatory structural risk floor: ask the user, or block without UI. This
   includes destructive/force Git and filesystem operations, unverified Git
   location or transport overrides, privilege/secrets (including input
   redirects), upload, package runners, opaque or stdin-fed script execution,
   persistent output redirection, and read options that can launch an external
   program or write a file. An exact literal `/dev/null` output sink is
   non-persistent and does not trigger this floor. ANSI-C `$'…'` syntax is never eligible for
   automatic approval: its decoded text remains available to the deny floor,
   but byte/escape semantics are conservatively fixed at `ASK`.
3. For a project-sensitive Git mutation, defer even a matching configured or
   active-skill allow until project discovery succeeds. Direct and substituted
   mutations require confirmation when project identity is unavailable;
   relative, grouped, additional, or otherwise unverified shell navigation
   before the mutation also requires confirmation. These outcomes never reach
   Ollama.
4. Explicit allow rule: approve without Ollama after the mandatory floors and
   any recognized leading-navigation check, except that helper-capable Git reads
   and unverified `rg` reads remain residual until their independent safety
   conditions are satisfied.
5. Configured ask and speculative risk: ask the user before any built-in read
   optimization.
6. Built-in literal project-bounded non-executing read: approve without Ollama.
   This narrow class covers stdin-only `head -N` and `rg --no-config`. An rg path
   may be relative or absolute inside any verified registered worktree, may be
   missing when its nearest existing canonical ancestor stays inside one, and
   may contain a basename-only literal `*` glob after the parent directory and
   every current match are verified; an option-like match whose basename starts
   with `-` requires confirmation. An exact `/dev/null` output sink remains
   eligible. Home expansion, traversal, symlink escapes, dynamic expansion
   (including a dynamic value mixed into a glob), directory-component or richer
   glob syntax, path-spelled/wrapped executables, `rg --pre`, `rg --search-zip`,
   `rg --hostname-bin`, and `rg --follow` do not inherit this allow.
7. A literal single-command `git -C <path> status|diff|log|show` may leave the
   structural location ASK only after `<path>` canonicalizes inside a registered
   non-bare worktree with the same Git common directory as the tool cwd. The
   verified `gitCwd.scope` then accompanies the command to Ollama; the Git read
   is not mechanically allowed because repository/global fsmonitor,
   external-diff, and textconv configuration can execute helpers. Tilde-prefixed
   or `..`-containing targets, repeated or dynamic `-C`, other risky global
   options, output/helper-execution options, compound commands, and non-read
   subcommands receive no exception.
8. For an otherwise unknown compound command, treat one leading top-level
   `cd <absolute-literal-path> &&` segment as neutral only when the canonical
   destination is contained by the complete registered non-bare worktree set
   and has the same canonical Git common directory as the tool cwd. Every
   remaining executable segment must be allowed; relative/dynamic paths,
   redirects, other connectors, multiple `cd` segments, missing paths, forged
   `.git` pointers, and unrelated or nested repositories receive no exception.
9. Require confirmation before otherwise unresolved leading navigation or
   `git -C` location that is not a verified registered same-repository worktree.
   This outcome never reaches Ollama.
10. For a command that still reaches the judge, bind the raw current input and
    authenticated current-run assistant evidence to its agent run, then discover
    canonical cwd/project/worktree context locally. Async child-environment
    sanitization, Git probes, cwd/worktree/leading-target canonicalization, and
    common-directory checks share one cumulative 250 ms deadline and abort
    signal.
11. Reuse an unexpired completed `ALLOW` cache entry only when the command, raw
    cwd, complete raw-task fingerprint, complete current-run-evidence
    fingerprint, and complete verified-project fingerprint match. A task-
    correlation failure disables cache reads and writes. Context discovery
    therefore precedes cache lookup.
12. Before a cache-miss chat request, require `/api/status` to report
    `cloud.disabled === true`.
13. Require `/api/tags` to contain exactly one exact-name model entry whose
    `name`, `model`, and pinned digest match and which has no `remote_host` or
    `remote_model` field.
14. Query `/api/chat`, then require the exact configured response model, no
    remote metadata, a completed non-truncated response, and an entire verdict
    of `ALLOW`. Every other result asks the user or blocks without UI.

Pi runs the shared `npm_script_preference` hook as a blocking preflight before
this decision. Because it precedes permission-policy, pi launches it with
`/bin/bash` and a fixed root-owned system `PATH`; missing utilities make the
hook pass into permission-policy rather than consulting inherited
repository-influenced executable paths. A matching package-runner invocation
is rejected with its npm script alternative without querying the judge.
Package-runner forms that pass, time out, or error in the hook continue into
the mandatory deterministic floor and local judge. The concrete scanner parses
manager-level options before deciding whether `x`, `dlx`, or `exec` is the
subcommand, so broad `bun` and `pnpm` grants still cover ordinary run scripts
but not package runners; an unknown manager option before a later runner token
stays conservative. In child profiles, preflight and policy rejections share the
same authenticated permission-block signal so a blocked child cannot be
reported as successful. Claude Code and Codex keep their existing hook behavior.

The checked-in allow entries mirror the broad Bash grants in
`claude/.claude/settings.json`. They represent explicit user trust, not a claim
that every `bun`, `find`, `gh`, or similar subcommand is intrinsically safe.
Wrappers, alternate or quoted executable paths, dynamic expansions,
redirections, and background execution do not inherit an allow entry. Quoted
literal arguments remain concrete, but embedded whitespace remains inside its
original argv word and cannot satisfy a multi-word allow prefix. Except for the
narrow same-repository leading `cd` case above, a compound command bypasses
Ollama only when every executable segment is explicitly allowed. An
authenticated explicitly invoked skill grant also counts as user approval for
an ordinary plain push or a `git -C` location after same-repository worktree
validation; force/destructive, secret, opaque, helper-capable Git reads, and
unverified `rg` reads remain above or outside that grant. A helper-capable
`git -C` read therefore follows the verified read-only route in step 7 rather
than bypassing Ollama through the grant.

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
- up to 2 KiB of authenticated assistant text from that same active user turn;
- up to 16 authenticated preceding tool-result records containing only tool name
  and `ok`/`error`/`unknown` status;
- canonical cwd plus a tagged Git/non-Git/unavailable project result;
- for Git, bounded project name, active worktree, and a display-only subset of
  canonical non-bare worktree roots (up to 16 roots / 2 KiB total); boundary
  checks use the complete canonical set locally, never this truncated subset,
  and require every navigable root to resolve to the active Git common
  directory; bare Git database paths may identify the project locally but are
  never navigation scope;
- computed leading-`cd` scope (`listed-worktree`, outside, or unverified);
- for a narrow verified `git -C` read, computed effective-cwd scope with the
  same three values. The internal same-repository boolean is not sent.

Task context comes from pi's raw `input` event. Current-run evidence is accepted
only from the active branch after an exact current Bash `toolCallId` match and a
unique latest user-turn boundary. Assistant thinking, tool-call arguments, tool-
result content/details, unauthenticated or later results, expanded skill/template
text, system prompts, prior-turn conversation, context files, environment,
repository file contents, Git remotes, and credentials are not sent. Pending
input becomes active only after an established append-only message baseline,
a positive user-message delta, Pi's steering-before-follow-up delivery order,
and a unique exact positional match prove correlation. Baseline loss,
compaction with pending input, duplicate text/source ambiguity, stale/dequeued
input, expanded queued input without an exact raw-text delivery match, and queue
overflow produce an explicit `uncorrelated` state. Pi emits no dequeue/edit event
that could safely bind an arbitrary expansion to its original queued input. The
uncorrelated state sends no task and cannot read or write the `ALLOW` cache. A
valid active task remains stable across earlier tool turns/retries and clears at
`agent_settled` or session shutdown. Raw `/skill:name` and prompt-template
invocations are retained for serialized idle runs only after
`before_agent_start` makes the corresponding expansion observably active.
The local Git discovery command sends nothing to Ollama and reads only Git
worktree metadata. `/api/status` and `/api/tags` contain no command or context.
Direct numeric-loopback TCP ignores ambient `HTTP_PROXY`/`HTTPS_PROXY`, and
redirects are not followed.

The complete permission-discovery phase has a separate cumulative 250 ms cap,
including async PATH sanitization, all Git processes, and every filesystem
canonicalization; status, tags, and chat then share one `timeoutMs` budget. If
preflight consumes that budget, chat is not started. Literal commands over
2 KiB, JSON-escaped commands over 2,800 bytes, complete classifier messages over
14 KiB, Git output over 64 KiB, and responses
over 64 KiB are not auto-approved. The model context is 16,384 tokens: the
14 KiB content cap fits even under byte-fallback tokenization, with room for
the chat template and verdict.

Successful decisions are cached for five minutes in a 128-entry per-session
LRU. Cache keys hash the exact system prompt, model/digest, raw cwd, complete
raw-task fingerprint, complete authenticated run-evidence fingerprint, complete
verified-project fingerprint, and bounded request envelope. Raw task, assistant
text, command, and omitted worktree text is not retained in cache entries. ASK,
timeout, malformed, aborted, unverified, unavailable, and uncorrelated outcomes
are never cached.

## Security limitations

A small LLM is a best-effort classifier, not a proof of safety. Current-task and
assistant text, tool-result names/statuses, project/path names, comments, quoted
strings, and here-documents can be adversarial. Project identity plus leading-`cd` and narrow `git -C` scopes are computed
locally, but they establish relevance/scope only and never prove command safety. The
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

The command runs every sample through production routing without executing it.
Known safe/risky forms receive the scanner's mechanical verdict; a fresh
`createPermissionJudge` instance performs live status, tags, and chat requests
only for each residual sample. Every sample carries synthetic bounded
current-task/run/project context and an exact expected `ALLOW` or `ASK`; any
mismatch, timeout, unavailable, malformed response, or unexpected deterministic
deny fails. The JSON report records each literal command, expected verdict,
outcome, route, and mechanical/model totals.

### Checked-in default qualification record

- Qualified at: `2026-07-22T10:43:42.355Z`
- Ollama: `0.32.0`
- Model: `granite4.1:3b` (3.4B, GGUF Q4_K_M, approximately 2.1 GB)
- `/api/tags` manifest digest:
  `6fd349357287c7ffc9e38189a93b48ea175d24fc566b38f09cfc564fb7f303eb`
- Shared timeout: `10000ms`
- Production-path verdicts: `68/68`
- Routing: `45 mechanical`, `23 live model`
- Required-safe: `25/25 ALLOW` (read-only Git/plain `rg`, project-bounded
  `rg --no-config` including a missing-path diagnostic, HOME-based `find`,
  harness metadata/version inspection, lint/test/typecheck/format, bounded local
  Git mutations, fetch/pull, verified linked-worktree navigation, and a verified
  `git -C` status read)
- Required-confirmation: `43/43 ASK` (destructive Git/filesystem,
  privilege/exfiltration including grouped input redirects, package-runner/
  stdin-shell/opaque execution, unavailable project identity and direct or
  substituted mutations, unrelated/prefix-confusable/traversal paths, Git
  tilde/symlink-traversal location spellings plus config/force/
  abbreviated-delete variants, external read helpers,
  output redirects including numeric-prefix or IFS-dynamic `>&file`, unverified
  relative/grouped/additional navigation before mutation, push/transport/
  curl-body upload, and prompt injection)

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
