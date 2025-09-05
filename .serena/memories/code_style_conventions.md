# Code Style and Conventions

## TypeScript Configuration
- **Module System**: ESM only (type: "module" in package.json)
- **Target**: ES2022 with Node.js environment
- **File Naming**: kebab-case for all files (enforced by unicorn/filename-case rule)
- **No Classes**: Prefer functional programming approach
- **No .d.ts files**: Use declare global in .ts files when needed

## Linting Rules (OXC/oxlint)
- **Strictness**: High - no explicit any, unused vars as warnings
- **Import Management**: Circular imports are errors, no automatic sorting
- **TypeScript**: Explicit return types optional, non-null assertions warned
- **Categories**: 
  - correctness: error
  - suspicious: warn
  - pedantic: off
  - perf: warn
  - style: warn

## Code Organization
- **Functional First**: Avoid classes, prefer pure functions
- **Error Handling**: 
  - Async: await/catch pattern with proper error handling
  - Sync: try/catch with Error cause propagation
  - Never suppress errors without proper handling
- **Dependencies**: 
  - Use exact versions (not ^5.0.0 or @latest)
  - Prefer language features over external libraries
  - Avoid PreRelease versions

## Directory Structure Rules
- `src/` contains all source code organized by feature
- `tests/` mirrors src structure with .test.ts files
- Configuration files in project root
- No global type definitions without proper scoping