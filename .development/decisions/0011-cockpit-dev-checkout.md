# 0011. The cockpit: development lives in the dev checkout, main stays pristine

- **Status:** Accepted
- **Date:** 2026-09-30
- **Issues:** #247, #248

## Context

The docs, knowledge graph, dev tooling, and shared `node_modules` lived in the *main* checkout while every task worktree branches from `dev` — so the graph described the release snapshot and a contributor checkout got none of the tooling. The dependency install was owned by the checkout nobody developed in.

## Decision

- The cockpit is the `dev` checkout: `.development/`, `graphify-out/`, `.pi/` tools, and the shared `node_modules`.
- `main` is a pristine release checkout, and every code change goes through a worktree cut from `dev`.
- Developer docs and tooling are tracked on `dev` for contributor parity.
- The knowledge graph describes `dev` and is refreshed at every merge by `graph-refresh.sh`, never by a hook side effect.

## Consequences

- Tracked docs and tools flow to `main` at release merges (accepted — the npm artifact stays clean via its `files` allowlist).
- The release ritual no longer includes a graph refresh.
- Merging a dev PR requires nothing special unless the cockpit held untracked copies.
