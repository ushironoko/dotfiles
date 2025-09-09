# Suggested Development Commands

## Development Workflow
```bash
# Run the application in development mode
bun run dev

# Build the application
bun run build

# Run all tests
bun run test
# or with vitest directly
vitest

# Type checking
bun run tsc
# or with tsc directly
tsc --noEmit

# Linting
bun run lint
# Fix linting issues automatically
bun run lint:fix

# Install locally for testing
bun run install:local
```

## Testing Commands
```bash
# Run tests with watch mode
vitest --watch

# Run tests with coverage
vitest --coverage

# Run specific test file
vitest tests/utils/fs.test.ts

# Run tests matching pattern
vitest --grep "symlink"
```

## Package Management (Bun)
```bash
# Install dependencies
bun install

# Add new dependency (exact version)
bun add package@1.2.3

# Add dev dependency
bun add -D package@1.2.3

# Update lockfile
bun install --frozen-lockfile
```

## Git Workflow
```bash
# Standard git commands for Linux/WSL
git status
git add .
git commit -m "message"
git push origin main

# View file changes
git diff
git log --oneline
```

## System Commands (Linux/WSL)
```bash
# File operations
ls -la
find . -name "*.ts"
grep -r "pattern" src/

# Process management
ps aux
kill PID

# File permissions
chmod +x script.sh
```