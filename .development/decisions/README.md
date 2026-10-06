# Architecture Decision Records

ADRs record decisions that are expensive to reverse — the structural choices that shape the extension's design. Accepted records are append-only; supersede a decision with a new ADR, never by editing an accepted one.

<!-- BEGIN GENERATED: adr-index (npm run docs:decisions) -->

_Generated from each `.development/decisions/NNNN-*.md` record by `npm run docs:decisions` — edit the records, not this block._

| # | Decision | Status | Date |
|---|---|---|---|
| 0001 | [Task-as-data fence at both execution chokepoints](./0001-task-as-data-fence.md) | Accepted | 2026-08-03 |
| 0002 | [Two execution paths: foreground subprocess, background SDK session](./0002-two-execution-paths.md) | Accepted | 2026-08-06 |
| 0003 | [Run records are the source of truth for monitor, history, retry, and metrics](./0003-run-records-source-of-truth.md) | Accepted | 2026-09-22 |
| 0004 | [Completion-push wake instead of polling](./0004-completion-push-wake.md) | Accepted | 2026-09-02 |
| 0005 | [Honest terminal status from the raw stopReason](./0005-honest-terminal-status.md) | Accepted | 2026-09-20 |
| 0006 | [File-backed presets and templates with three-tier precedence](./0006-file-backed-presets-templates.md) | Accepted | 2026-08-09 |
| 0007 | [Capability pre-flight with an explicit force override](./0007-capability-preflight.md) | Accepted | 2026-09-27 |
| 0008 | [Deadlines: one timer per run; 30 minutes is a default, not a ceiling](./0008-deadlines-one-timer-per-run.md) | Accepted | 2026-09-29 |
| 0009 | [Retry fidelity: restore the recorded execution shape, explicit values win](./0009-retry-fidelity.md) | Accepted | 2026-09-29 |
| 0010 | [Distribution: npm-only installs, staged OIDC releases](./0010-distribution-npm-only.md) | Accepted | 2026-09-12 |
| 0011 | [The cockpit: development lives in the dev checkout, main stays pristine](./0011-cockpit-dev-checkout.md) | Accepted | 2026-09-30 |
| 0012 | [Documentation that cannot drift: generated module map + executable architecture rules](./0012-documentation-cannot-drift.md) | Accepted | 2026-09-30 |
| 0013 | [TypeScript 7: the AST lives behind one unstable-API adapter](./0013-typescript-7-unstable-ast.md) | Accepted | 2026-10-03 |
| 0014 | [The TS7 AST adapter reuses one API client per worker](./0014-ts7-api-singleton.md) | Accepted | 2026-10-06 |

**14 decisions** — every one is listed because a record without a heading/Status/Date fails CI.

<!-- END GENERATED: adr-index -->

## How to add one

Take the next number (`NNNN`, four digits zero-padded), copy the skeleton into
`.development/decisions/NNNN-slug.md`, fill in `Status`, `Date`, and `Issues`, then run `npm run docs:decisions`
to regenerate the index. The guard test enforces the index, so a new record without a regenerated index — or a
malformed one — fails CI.
