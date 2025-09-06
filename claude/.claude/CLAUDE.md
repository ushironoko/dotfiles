# Development Workflow

- When proceeding with development, the following workflow must be adhered to:
  - Task List Creation
    - Always break down goals into issues, create task lists based on them, prioritize, and tackle them accordingly
- Follow Test-Driven Development as recommended by t_wada
  - Run tests, and when tests pass, execute lint, format, and type check for static analysis
  - When all tests and static analysis pass, commit to git in meaningful units
- When a task list item is completed, check it off the list and update it, then proceed to the next task
- Use subagents for specific tasks
  - Use test subagent for creating and running unit tests
  - Use git subagent for git operations
  - Use benchmark subagent for running benchmarks
  - Use similarity subagent for refactoring

# Coding Guidelines

- For TypeScript projects, the following rules must be adhered to:
  - Use pnpm as the package management tool
  - Always install npm modules with specific version numbers for the latest version
    - Avoid notations like `module@latest` or `module@^5.0.0`, and explicitly specify like `module@5.5.1`
    - Avoid PreRelease versions and select stable versions
  - Minimize reliance on npm modules; use language features when possible
    - For example, for use cases that can be covered by language features like lodash's `values`, use language features as much as possible
  - Use ESM for module resolution, not CommonJS module resolution
  - Prohibit `Class`; prioritize functional programming as much as possible
  - Prohibit creation of `.d.ts` files
    - When global types need to be exposed, create a type definition .ts file without module import/export and use `declare global`
    - Generally rely on file scope and module resolution for type definitions, avoiding global type definitions
  - Use `biomejs/biome` for linting
    - Read the documentation carefully and avoid customizing rules; use default settings as much as possible
    - When linting, write a `lint` script in npm scripts and execute that npm script
  - Use `biomejs/biome` for formatting
    - Read the documentation carefully and avoid customizing rules; use default settings as much as possible
    - When formatting, write a `format` script in npm scripts and execute that npm script
    - Always use 2 spaces for indentation
    - Prioritize double quotes
    - Use semicolons without relying on automatic semicolon insertion
  - Use vitest for testing
    - Test files should be created at the same level as the module file being tested, with the naming convention filename.test.ts
    - When testing, write a `test` script in npm scripts and execute that npm script
  - Use tsc for type checking
    - When type checking, write a `tsc` script in npm scripts and execute that npm script
  - Use Node.js as the runtime environment
    - When Node.js version reference is needed, refer to the `.node-version` file created by the user in the project root and follow it
  - When directly executing TypeScript files, use Node.js features like `node index.ts`
    - If execution fails, use `privatenumber/tsx` for execution
  - Error Handling
    - Write asynchronous operations with await/catch pattern and always handle exceptions in catch clauses
    - Write synchronous operations with try/catch pattern, handle errors in catch clauses as much as possible, and complete user feedback
      - If exceptions cannot be handled on the spot, they may be thrown, but always propagate error information using the cause option of Error instances
      - Meaninglessly suppressing error information is prohibited
- For project structure, the following rules must be adhered to:
  - Only allow creation of various configuration files, `src` directory, `scripts` directory, `lib` directory, `bin` directory, `docs` directory, `templates` directory, and `tests` directory in the project root
  - Under the src directory, you may freely create a directory structure suitable for the project
  - When the project supports monorepo, a `packages` directory can be created instead of the `src` directory

# About Images

- **MUST** When specifying files, convert Windows-format paths to Ubuntu mount directory paths
  - Example: Convert "C:\Users\user1\Pictures\test.jpg" to "/mnt/c/user1/Pictures/test.jpg"

# Prohibitions

- When deleting files or directories, do not execute without permission. Always ask for permission
- Do not edit content within blocks starting with `###readonly` and ending with `###readonlyend` that exist in CLAUDE.md. Only read them as instructions for the user's project