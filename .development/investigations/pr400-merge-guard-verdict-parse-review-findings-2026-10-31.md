# REVIEW — PR #400 (fix/merge-guard-verdict-parse) @ `b0badd9`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **medium (0.77)**.
Origin: friction `merge-guard-blocks-on-prose-mention` (recurrence 2, 2026-10-31).

Reviewed head: b0badd9

**Verdict: approve** — 0 findings, 0 SOLID/DRY; three informational observations.

## Verified-OK

- **Semantics (executed in a /tmp harness):** prose mentions before and after the disposition are inert; a fenced example after the disposition is inert (both ``` and ~~~); two line-start dispositions → last wins in either order; an echoed template line → ambiguous; no disposition → empty → (c) fails closed; case-insensitive; `Verdict:approve` with no space accepted; `**..**` / `##` decorations accepted.
- **Ambiguity is scoped to the chosen line only** (executed): ambiguous-first + clean-last → approve; clean-first + ambiguous-last → ambiguous.
- **Edge cases executed:** inline-backtick verdict at line start accepted (docs bless backticks); blockquote and list-marker verdicts not matched (fail-closed, acceptable); CRLF → approve; unclosed fence → the tail is ignored and an earlier disposition stands; indented fences tracked; fence info strings handled; 4-backtick fences toggle correctly.
- **Mutations (both fixtures, /tmp parser copies; tree untouched):** the old any-line rule yields `inline`/`changes-requested` on the new fixtures; dropping fence tracking yields `changes-requested` — both fixtures fail as designed.
- **Real records from the cockpit** (JEV_LOG override): pr397 → `approve-with-nits`, pr399 → `approve`; full gate MERGE OK, five checks green, exit 0.
- **No collateral:** selftest 17/17; hunks confined to `record_verdict`, two (c) failure texts, fixtures; (b)/(d)/(e) untouched; suite 90/1798; `bash -n`; `git diff --check`; docs match behavior; 2 files, no `src/`.

## Open observations (informational, none merge-blocking)

1. **"Both blocked the old parser" is an event, not a reproducible state.** The blocking happened on the *uncommitted* drafts (the fixed text was what got committed), so the old parser agrees with the committed records. Verified by execution on the current files; not verifiable from git history.
2. **A disposition below an unclosed fence would be ignored** (read-verified, not executed). Fail-closed and correct, but a one-clause doc note ("close your fences") would prevent the surprise.
3. **Tree-clean was sound by construction:** zero in-place mutations (all scratch under /tmp), so there was nothing to restore; no closing `git status` was run per the wrap-up instruction.

## Disposition

Approved and merged via the **fixed** guard (dogfood: this record mentions the field name in prose and parses clean).
