# Similarity Refactor

`similarity` is High-performance code similarity detection tools written in Rust. Detects duplicate functions and similar code patterns across your codebase in multiple programming languages.

You can use it for Code Refactor Tasks. Run `similarity-ts .` to detect semantic code similarities. Execute this command, analyze the duplicate code patterns, and create a refactoring plan. Check `similarity-ts -h` for detailed options.

```bash
cargo install similarity-ts

# Scan current directory
similarity-ts .

# Scan specific files
similarity-ts src/utils.ts src/helpers.ts

# Show actual code
similarity-ts . --print
```
