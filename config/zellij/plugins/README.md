# Vendored Zellij plugins

Plugins are vendored here (referenced via `file:` in `layouts/default.kdl`)
instead of `https:` locations because Zellij's on-demand download can corrupt
the WASM cache when multiple tabs fetch the same plugin concurrently — the
zjstatus wiki explicitly recommends manual installation.

## zjstatus

- Version: v0.23.0
- Source: https://github.com/dj95/zjstatus/releases/download/v0.23.0/zjstatus.wasm
- SHA-256: `e006901223524239db618021e4cc5d17f82dc4bfae5432895ba41f03f13861ff`
- License: see upstream repository (https://github.com/dj95/zjstatus)

### Updating

```bash
VERSION=v0.23.0  # replace with the new tag
curl -fsSL -o config/zellij/plugins/zjstatus.wasm \
  "https://github.com/dj95/zjstatus/releases/download/${VERSION}/zjstatus.wasm"
shasum -a 256 config/zellij/plugins/zjstatus.wasm
```

Then update the version and SHA-256 above, and re-grant plugin permissions on
next Zellij start if prompted.
