# Contributing to teamrecall

Thank you for your interest in contributing! 🎉

## Development Setup

```bash
# Clone and install
git clone https://github.com/wangwu-30/teamrecall.git
cd teamrecall
npm install

# Run tests in watch mode
npm run test:watch

# Type check
npm run typecheck

# Build
npm run build
```

## Project Structure

```
teamrecall/
├── src/
│   ├── types.ts          # Core TypeScript types
│   ├── memory.ts         # Memory parsing and validation
│   ├── compiler.ts       # Generate agent-specific rules
│   ├── init.ts           # Initialize project structure
│   ├── doctor.ts         # Health checks
│   ├── learn.ts          # PR distillation logic
│   ├── cli.ts            # Command-line interface
│   ├── utils/
│   │   ├── atomic.ts     # Atomic file operations
│   │   └── git.ts        # Git utilities
│   └── *.test.ts         # Tests (colocated with source)
├── examples/             # Usage examples
├── .github/workflows/    # CI and auto-learn workflows
└── dist/                 # Built output (gitignored)
```

## How to Contribute

### Reporting Bugs

Open an issue with:
- What you did
- What you expected
- What happened instead
- Your environment (OS, Node version, teamrecall version)

### Suggesting Features

Open an issue tagged `enhancement` with:
- The problem you're trying to solve
- Your proposed solution
- How it fits the project's goals (git-native, zero infra, multi-agent)

### Pull Requests

1. **Fork and branch**:
   ```bash
   git checkout -b feature/your-feature
   ```

2. **Write tests**:
   - Every new function needs a test
   - Run `npm test` before committing

3. **Type check**:
   ```bash
   npm run typecheck
   ```

4. **Keep commits atomic**:
   - One logical change per commit
   - Clear commit messages

5. **Open PR**:
   - Describe what changed and why
   - Link related issues

## Code Style

- **TypeScript**: Strict mode, explicit types
- **Formatting**: No formatter enforced (yet). Follow existing style.
- **Naming**:
  - Functions: `camelCase`
  - Types: `PascalCase`
  - Files: `kebab-case.ts`

## Testing

- Use **vitest**
- Colocate tests: `memory.test.ts` next to `memory.ts`
- Test pure functions first, I/O functions with mocks if needed

```typescript
import { describe, expect, it } from "vitest";

describe("myFunction", () => {
  it("does what it says", () => {
    expect(myFunction(input)).toBe(expected);
  });
});
```

## Week 1 vs Week 2 Scope

**Week 1 (v0.1)** — Complete:
- Core types, compiler, CLI scaffold
- Tests and CI
- README and docs

**Week 2 (v0.2)** — Open for contributions:
- Full `learn` command (gh + claude -p)
- Dedupe/conflict/staleness job
- Demo repo
- GIF walkthrough

If you're interested in working on week 2 features, comment on the relevant issue!

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

Open an issue or discussion. We're here to help!
