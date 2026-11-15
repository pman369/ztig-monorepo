# ZTIG: Zero-Touch Intent Graph Monorepo

Production implementation monorepo for the Zero-Touch Intent Graph (ZTIG) autonomous state synchronization and contract drift guardrail.

## Monorepo Layout

```
ztig-monorepo/
├── packages/
│   ├── core/                  # Core ZTIG engine (@ztig/core)
│   │   ├── src/
│   │   │   ├── types.ts       # Intent graph and surface data contracts
│   │   │   ├── ast-sieve.ts   # Tree-sitter WASM AST sieve & skeleton extractor
│   │   │   ├── drift-detector.ts # Surface delta & semantic velocity math
│   │   │   ├── merge-patch.ts # RFC 7396 JSON Merge Patch implementation
│   │   │   ├── cold-start.ts  # Cold-start repo reverse-engineering
│   │   │   └── orchestrator.ts# Transactional VFS & topological repair scheduler
│   │   └── test/              # 16 unit tests covering AST sieve, pins, drift, repair
│   └── cli/                   # Developer & CI tool (ztig)
│       ├── src/
│       │   ├── cli.ts         # Commander CLI entry point
│       │   ├── evaluator.ts   # Diff evaluator & graph checker
│       │   └── git-differ.ts  # Git diff extractor
│       └── test/              # Integration tests for pull request drift evaluation
├── .github/
│   └── workflows/
│       └── ztig-ci.yml        # Production CI/CD drift check workflow
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.json
└── vitest.workspace.ts
```

## Quick Start

### Installation & Build

```bash
# Install dependencies across all packages
pnpm install

# Build all workspace packages
pnpm build

# Run all test suites
pnpm test
```

### CLI Usage (`ztig`)

The `ztig` CLI provides discoverable subcommands with built-in help:

```bash
# Display help menu
node packages/cli/dist/cli.js --help

# Initialize a new ztig.json graph
node packages/cli/dist/cli.js init

# Inspect existing nodes, invariants, and edges
node packages/cli/dist/cli.js inspect

# Evaluate pull request changes against the intent graph
node packages/cli/dist/cli.js evaluate-drift --base origin/main --fail-on-drift=true
```

## GitHub Actions CI/CD Integration

The workflow in `.github/workflows/ztig-ci.yml` runs on every pull request:
1. Clones full git history (`fetch-depth: 0`) to resolve branch diffs against `origin/main`.
2. Sets up `pnpm@9` and Node 20 with pnpm store caching.
3. Builds packages and runs the test suite.
4. Executes `ztig evaluate-drift --fail-on-drift=true`, blocking merges if any pinned code is violated or unpinned contracts drift.
