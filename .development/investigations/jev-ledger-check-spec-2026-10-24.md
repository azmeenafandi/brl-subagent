# Jev ritual made checkable — issue #366

jev: **medium (0.71)** · risk **C2** · worktree **y** (the worktree cell scored n — it only counts `src/`/`presets/`;
this changes tracked tooling + CI and ships via a PR). Review: C2 focused.

## Context (verified)

Rule 22 (strict Jev) was skipped twice (2026-10-13, 2026-10-23) while the classifier was available. The call itself is
a **codemode** capability (`models.getModelOfType` + `models.classify`); `pi-ai` exposes `createModels`/`classify`,
but the provider/auth wiring is host-side — a standalone script cannot run the query reliably. **So the mechanical
gate goes on the artifact, not the call:** every dispatch already records `jev: level (confidence) · risk · worktree`
in its spec and its calibration-log row; a skipped query shows up as a **bare level** (no confidence) or a missing
line. The ledger is tracked, so that artifact is checkable in CI.

Ledger today: **61 rows since 2026-10-12** (the strict-Jev cutoff); one is the documented 2026-10-12 ritual-gap row
with an explicit marker — the checker must pass it.

## Design

**`.pi/skills/worktree/jev-check.mjs`** — one small Node script, three modes:

1. `--line '<classifier-json>'` — validate `{level, conf, risk, worktree}` and print the **exact** dispatch line
   (`jev: medium (0.84) · C2 · worktree y`). Reject a missing/invalid confidence (the skipped form) with a clear
   error. This closes the gap between the codemode answer and the recorded line: one command, no hand-formatting.
2. `--ledger [path]` — parse the calibration log's table; for every row dated **≥ 2026-10-12**, the Jev cell must
   contain a confidence `(0.xx)` **or** an explicit gap marker (`unavailable`, `not classified`, `n/a`, `ritual
   gap`). Report every offender (date + dispatch + cell) and exit 1. Fail loudly if no rows parse (a silent pass is
   the class this check exists to kill).
3. `--selftest` — fixture-driven proof: a bare level fails; a confident line passes; each marker passes; a
   pre-cutoff bare row is ignored; a malformed table is an error. Deterministic, no network.

**Wire into CI** (`.github/workflows/ci.yml`): `node .pi/skills/worktree/jev-check.mjs --selftest` and
`--ledger .development/investigations/jev-calibration-log.md`, beside the budget guard.

**References:**
- `references/jev-advisory.md`: the pipeline (codemode block → `--line` → paste), the required line, and the ledger
  check; make "a bare level is a finding" explicit.
- `references/review-dispatch.md`: add the review check — *the spec/dispatch carries a queried `jev: level
  (confidence)` line; a bare level or a missing line is a finding.*
- `SKILL.md` (Rule 22): the helper + the CI check.

## Out of scope

Automating the classifier call itself (codemode stays the query path; Phase 2 is unscheduled in `ROADMAP.md`),
editing historical ledger rows, the extension runtime.

## Acceptance

- `--line` on a valid classifier JSON prints the exact line; on a missing confidence it exits non-zero.
- `--ledger` passes the real log (61 rows) and fails a fixture with a bare level; `--selftest` proves both.
- CI runs both; the full suite and `tsc` unaffected (no `src/` change — the budget ratio is untouched).
- The three references state the requirement; a review brief missing the check is itself a process gap.

## Risks

- **False positive blocking PRs** — the marker vocabulary is lenient, the selftest covers the pass path, and the
  parse guard fails loudly instead of silently passing an unparsed file.
- **Drift between the ledger format and the parser** — the table schema is stable (date/dispatch/class/jev/…); the
  parse guard catches a format change.
