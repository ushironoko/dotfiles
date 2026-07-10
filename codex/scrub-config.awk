# scrub-config.awk — keep codex/config.toml free of machine-local state.
#
# codex and the Codex desktop app rewrite ~/.codex/config.toml at runtime and
# fill it with machine-specific values that must never enter version control:
#   - absolute filesystem paths — [projects."/abs/path"] trust, [mcp_servers.*]
#     wired to /Applications/Codex.app resources, [marketplaces.*] source paths,
#     the top-level `notify` helper path, [desktop...perPath] per-repo prefs
#     (which can include private/client repo names).
#
# Policy: nothing with an absolute path is committed. This is enforced by
# CONTENT, not by an ever-growing denylist of section names, so machine state
# codex invents in the future is stripped by default:
#   - any table (section up to the next header) whose lines contain a quoted
#     absolute path ("/...) is dropped whole;
#   - any top-level key line with a quoted absolute path (e.g. notify) is dropped;
#   - [projects.*] and [mcp_servers.*] are always dropped, path or not.
#   - [hooks.state] and its children are always dropped because trusted hashes
#     are runtime approval state even when a future hook id has no absolute path.
# Relative paths ("./x") and URLs ("https://x") are kept — the trigger is a
# quote immediately followed by a slash, which only matches absolute paths here.
#
# Used as a git clean filter (see .gitattributes / scripts/setup-git-filters.sh):
# stripping happens at `git add` time while the working tree keeps the live file,
# so codex keeps functioning. The transform is idempotent: scrub(scrub(x)) == scrub(x).

function flush(   i) {
  # Emit the buffered table only if it is neither force-dropped nor path-bearing.
  if (!(buf_has_path || buf_force_drop))
    for (i = 1; i <= n; i++) print buf[i]
  n = 0
  buf_has_path = 0
  buf_force_drop = 0
}

BEGIN { n = 0; buf_has_path = 0; buf_force_drop = 0; in_section = 0 }

# Section header ([table] or [[array.of.tables]]): flush the previous table, then
# start buffering this one.
/^\[/ {
  if (in_section) flush()
  in_section = 1
  buf[++n] = $0
  if ($0 ~ /"\//) buf_has_path = 1
  if ($0 ~ /^\[+(projects|mcp_servers)[.\]]/) buf_force_drop = 1
  if ($0 ~ /^\[+hooks\.state([.\]]|$)/) buf_force_drop = 1
  next
}

# Any line inside the current table is buffered; note if it carries a path.
in_section {
  buf[++n] = $0
  if ($0 ~ /"\//) buf_has_path = 1
  next
}

# Top-level lines (before the first table): keep unless they carry a path.
!/"\// { print }

END { if (in_section) flush() }
