#!/usr/bin/env bun
 echo "lint, format, and typecheck" 1>&2

 bun run format

 bun run lint

 bun run tsc
