# CodeGraph Phase 2 dogfood log (opened 2026-10-10)

Per ADR 0015: at each merge into `dev`, BOTH refreshes run side by side — `graph-refresh.sh`
(gate) + `codegraph-refresh.sh` (shadow). Measure: graphify refusal rate, CodeGraph sync wall
time, query parity on 5–10 real questions. Decide (retire/narrow) after a week or N merges.

## Data point #1 — merge `bad271e` (dependabot PR #310, **lockfile-only**)

- **Graphify (gate): REFUSED (#9)** after **149 s** — net −1 (1695→1694); unverified semantic
  shrink on `.development/HANDOFF.md` (5→2) and `.development/decisions/0015-codegraph-structural-index.md`
  (3→2) — both files UNCHANGED by the merge. Forced with `--allow-partial`; write verified
  (mtime + the "wrote" line): 1694 nodes / 3835 edges / 161 communities; `graph-check.py`
  39/39 modules, 379/379 symbols.
- **CodeGraph (shadow): PASS** in **5 s** — 39/39 modules, 0 missing of 379 exported
  declarations, `indexed_at_commit == bad271e == HEAD` (declared freshness, no mtime games).
- Window tally: **9 refusals, 0 involving `src/` structure.**
- Query-parity sample #1 (partial): `callers markInterrupted` → `src/run-registry.ts:220`;
  `callers createWorkBranch` → `src/git.ts:108` (definitions resolve cleanly). Caller-LIST
  extraction needs the Oct-8 methodology fix (flag/JSON shape), and `impact`'s exact argument
  form needs settling — carried to data point #2.
