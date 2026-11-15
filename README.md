# ZTIG: Zero-Touch Intent Graph Monorepo

Production implementation monorepo for the Zero-Touch Intent Graph (ZTIG) autonomous state synchronization and contract drift guardrail.

## Problem Statement

**AI agents and autonomous code editors silently violate architectural intent — and no one notices until production breaks.**

As AI coding agents (Claude Code, Cursor, Copilot, Devin, etc.) become primary authors of production code, a critical governance gap has emerged: **there is no enforcement layer between intent and implementation.**

### The Core Problem: Silent Contract Drift

| Failure Mode | What Happens | Why It Breaks Systems |
|--------------|--------------|----------------------|
| **Intent Erosion** | Agents refactor, rename, or restructure code without understanding architectural invariants (e.g., public API surface, event contracts, data schemas) | Downstream consumers break; integration tests pass but runtime fails |
| **Pinned Contract Violation** | Hard-coded assumptions (HTTP status codes, error formats, DB column names, enum values) are changed by agents treating them as "refactorable" | Silent data corruption, API breaking changes, migration nightmares |
| **Drift Accumulation** | Small, "safe" changes compound across PRs — each passes review, but the aggregate deviates from design | No single PR is at fault; architecture death by a thousand cuts |
| **Cold-Start Blindness** | New agents/repos lack a machine-readable map of what *must not change* vs. what *can evolve* | Every agent session re-learns constraints via trial and error |
| **Review Theater** | Human reviewers check logic, not architectural conformance; CI runs tests, not intent validation | "LGTM" on changes that violate the system's own contracts |

### Why Existing Approaches Fail

| Approach | Mechanism | Fatal Flaw |
|----------|-----------|------------|
| **Architecture Decision Records (ADRs)** | Human-written markdown docs | Stale by definition; no enforcement; agents don't read them |
| **TypeScript / Schema Validation** | Static types, Zod, OpenAPI | Only catches *signature* changes; misses semantic contracts ("this endpoint must return 404, not 200 with error body") |
| **Conventional Commits / Lint Rules** | Commit message format, ESLint rules | Syntactic only; cannot express "don't rename this event" or "this error code is a public contract" |
| **CODEOWNERS / Branch Protection** | Human gatekeeping | Bottleneck; doesn't scale; reviewers miss cross-file intent |
| **Post-Merge Drift Detection** | Periodic audits, architecture reviews | Too late — drift is already in production |

### The ZTIG Solution

**Shift intent enforcement left: make architectural contracts machine-readable, version-controlled, and CI-enforced.**

1. **Intent Graph (`ztig.json`)** — Declarative, version-controlled manifest of pinned surfaces (APIs, events, schemas, error codes, CLI flags) and their invariants
2. **AST Sieve** — Tree-sitter WASM extractor that maps source code to the intent graph nodes (functions, types, routes, constants) with zero false positives
3. **Drift Detector** — Semantic diff engine comparing PR changes against the intent graph; distinguishes *allowed evolution* from *contract violation*
4. **Transactional Repair** — Topological scheduler that auto-generates minimal fix patches (RFC 7396 JSON Merge Patch) for reversible violations
5. **CI Gate** — `ztig evaluate-drift --fail-on-drift=true` blocks merges that violate pinned contracts; warnings for unpinned drift

**Result: Architectural intent becomes a first-class citizen in the SDLC — enforced at PR time, not discovered at runtime.**

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
pnpm ztig --help

# Initialize a new ztig.json graph
pnpm ztig init

# Inspect existing nodes, invariants, and edges
pnpm ztig inspect

# Evaluate pull request changes against the intent graph
pnpm ztig evaluate-drift --base origin/main --fail-on-drift=true
```

## GitHub Actions CI/CD Integration

The workflow in `.github/workflows/ztig-ci.yml` runs on every pull request:
1. Clones full git history (`fetch-depth: 0`) to resolve branch diffs against `origin/main`.
2. Sets up `pnpm@9` and Node 20 with pnpm store caching.
3. Builds packages and runs the test suite.
4. Executes `ztig evaluate-drift --fail-on-drift=true`, blocking merges if any pinned code is violated or unpinned contracts drift.
