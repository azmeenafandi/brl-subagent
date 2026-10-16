# Jev calibration log — continuous outcome tracking

**Purpose.** Pair every dispatch's `jev:` prediction with its observed outcome, so blanket
overrides (e.g. a "C1 ⇒ high" convention) are kept, deleted, or justified on **evidence** instead
of intuition. Format + definitions: `.pi/skills/worktree/references/jev-advisory.md` §Outcome
logging. Prior dataset: `.development/investigations/jev-thinking-backtest-2026-10-10.md`
(98 dispatches).

The **input template** applies from the first dispatch after 2026-10-12; the rows below predate it
and used free-form task text (hazard-complete for FGP; thinner prose for U2/U3 — which is itself
part of what this log will measure).

| Date | Dispatch | Class | Jev | Chosen | Delta / reason | Outcome | Calibrated? |
|---|---|---|---|---|---|---|---|
| 2026-10-11 | `impl-u2-r2` | impl | medium (0.52) · C1 (0.94) | high | +1, C1 convention | review approve-with-nits (2 minors: test-witness gap, root-change note); 0 fix rounds; merge #326 | consistent |
| 2026-10-11 | `impl-u3` | impl | medium (0.39) · C1 (0.51) | high | +1, C1 convention | review changes-requested: **3 criticals** (fresh-boot blindness) + 1 major + 3 minors; Fix A + Fix B rounds | **design-gap** (the criticals were the *spec's* session-sourced assumption, not implementation depth — the level was not the causal variable) |
| 2026-10-11 | `impl-u3-fixA` | fix | high (0.78) · C1 (0.95) | high | 0 | approve-with-nits (4 minors); survived 2 connection drops + 1 continuation | consistent |
| 2026-10-11 | `impl-u3-fixB` | fix | medium (0.64) · C2 (0.28) | medium | 0 | approve-with-nits (1 docstring nit) | consistent |
| 2026-10-11 | `design-fgpersist` | design | high (0.87) · C1 (0.95) | high | 0 | decision-ready proposal; probes A–E executed; 0 fix rounds | consistent |
| 2026-10-12 | `impl-fgp` | impl | medium (0.93) · C1 (0.76) | high | +1, C1 convention | review approve-with-nits (2 minors: array leniency, comment accuracy); both fixed in `be9a4a0`; merge #328 | **consistent — but the +1 override finds no support**: the review's minors were cosmetic; Jev's confident medium looks sufficient |
| 2026-10-12 | `review-fgp` | review | high (0.89) · C1 (1.0) | high | 0 | approve-with-nits: 2 real minors (array leniency proven empirically; comment accuracy); no majors | consistent (caught real, if minor, issues) |
| 2026-10-12 | `impl-fgp-nit` | fix | medium (0.42) · C2 (0.73) | medium | 0 (first template-era call) | 1-minute fix; mutation verified (guard revert → test fails); suite 73/1500; CI green; merged | consistent |
| 2026-10-12 | `impl-329` | impl | medium (0.42) · C2 | medium | 0 | review approve-with-nits (1 style nit — view-level undefined keys, **carried by design**); 0 fix rounds; suite 73/1503; merge #331 | consistent |
| 2026-10-12 | `review-329` | review | **not classified — ritual gap** (review floor `medium` used) | medium | n/a | approve-with-nits: 1 nit (view-level undefined-valued keys; carried — matches the view's existing house style); 0 majors; 1 transport retry before success | consistent — but **classify reviews pre-dispatch** (gap recorded) |
| 2026-10-12 | `impl-330` | impl | medium (0.58) · C2 | medium | 0 | implemented exactly as specced; the IMPLEMENTER surfaced a **premise error in the spec** (history was already newest-first via `cleanupRuns`) → direction corrected before review; code was correct to the spec | **design-gap** (spec premise — partial read of `getRunEntries`; the level was not the causal variable) |
| 2026-10-12 | `impl-330-fix` | fix | medium (0.98) · C2 | medium | 0 | transport failure on attempt 1 (worktree pristine, no work lost); retry succeeded — corrected ordering implemented on `205927c`; 0 fix rounds; review approve (0 findings); suite 73/1503; merge #332 | consistent |

## Notes

- **Review dispatches** all ran at `high` (floor `medium` + C1 raise); their verdicts live in the
  pinned review records. Only representative rows are listed here.
- **First calibration signal to watch:** the `impl-fgp` row — Jev's most confident call
  (`medium (0.93)`) that the conductor overrode on convention. Its review outcome completes the
  entry and is the first direct test of the override.
- **The `impl-u3` design-gap row is the key lesson:** a thinking level cannot rescue an incomplete
  *design*. That class is controlled by the spec's Recon/design review, not by the level.
- **Filling this log:** at each dispatch's close (merge/rejection), append one row. At ~20 rows,
  re-run the backtest against this log and revisit every override.

| 2026-10-12 | `review-330` | review | medium (1.0) · C2 | medium | 0 (gap closed — classified pre-dispatch) | approve, ZERO findings; both mutation probes failed exactly as predicted (bridge sort removal / unlimited-sort removal); coverage reconciled | consistent |
| 2026-10-13 | `impl-deps-pi12` | deps | low (0.69) · C3 → **conductor rerate C2** | low | 0 (level: Jev's `low`; risk rerated UP per Rule 10) | dependency parity bump to pi 1.2.0; implemented exactly per spec (4 ranges + typebox pin; chord/esbuild tree removed upstream); suite 73/1506; tsc clean; review approve (0 findings); merge #334 | consistent (config-only; the level was fine, the C2 rerate bought the lockfile-forensics review) |
| 2026-10-13 | `review-deps12` | review | medium (0.86) · C2 | medium | 0 | approve, ZERO findings; lockfile churn fully reconciled (31 removed keyed entries; seven 1.1.0→1.2.0; typebox dedupe; chord/esbuild removal cross-checked vs the host manifest); `npm ls --all` clean; `npm ci --dry-run` exit 0 | consistent |
| 2026-10-16 | `impl-deps-pi13` | deps | low (0.45) · C3 → **conductor rerate C2** | low | 0 (level: Jev's `low`; risk rerated UP per Rule 10) | pi 1.3.0 parity bump; exactly the declared four ranges + the 7-package lockfile churn; suite 73/1506; tsc clean; review approve (0 findings); merge #338 | consistent (config-only; the C2 rerate again bought the lockfile-forensics review) |
| 2026-10-16 | `review-deps13` | review | medium (0.77) · C2 | medium | 0 | approve, ZERO findings; lock diff reconciled line-by-line (7× −1.2.0/+1.3.0; 0 additions/removals; typebox context-only); `npm ls --all` + `npm ci --dry-run` green | consistent |
