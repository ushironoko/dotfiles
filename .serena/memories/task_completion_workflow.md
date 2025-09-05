# Task Completion Workflow

## Test-Driven Development Process
Following t_wada's TDD approach:

1. **Write Tests First**: Create failing tests for new functionality
2. **Make Tests Pass**: Implement minimal code to pass tests
3. **Refactor**: Improve code while keeping tests green

## Quality Assurance Pipeline
After implementing changes, run in this order:

```bash
# 1. Run all tests and ensure they pass
bun run test

# 2. Type checking
bun run typecheck

# 3. Linting
bun run lint

# 4. Fix any linting issues
bun run lint:fix
```

## Git Commit Process
Once all checks pass:

```bash
# 1. Stage changes
git add .

# 2. Commit with meaningful message
git commit -m "descriptive commit message"

# 3. Push to repository
git push origin main
```

## Testing Strategy
- **Unit Tests**: Test individual functions and modules in isolation
- **Test Location**: Place tests alongside source files (same directory)
- **Naming**: Use `.test.ts` suffix for test files
- **Coverage**: Aim for comprehensive coverage of:
  - Normal operation (happy path)
  - Error conditions
  - Edge cases
  - Boundary conditions

## Error Handling Requirements
- **Async Functions**: Use await/catch pattern, never ignore errors
- **Sync Functions**: Use try/catch, propagate errors with cause
- **User Feedback**: Provide meaningful error messages
- **Logging**: Use the logger utility for consistent output