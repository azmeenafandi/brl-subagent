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
| 2026-10-12 | `impl-330-fix` | fix | medium (0.98) · C2 | medium | 0 | transport failure at 1m52s (connection error) — worktree pristine, no work lost; re-dispatch pending confirmation | n/a (transport; no level signal) |

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
