# Handoff archive — 2026-11-08

Extracted verbatim from `.development/HANDOFF.md` on 2026-11-08 and replaced by a
single `## STATE` block. This is the **superseded mid-sweep snapshot**
(`Verified: ba06e95`, 2026-11-07) — it sat *below* the final one because a
handover had appended instead of replacing, and it carried a stray fragment of
the preamble with it. Kept per the handoff contract: superseded STATE is archived
verbatim, never deleted. Not current state.

```text
## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md`, `-2026-11-06.md`, `-2026-11-07b.md` (the pre-sweep snapshot) — not current state.

## STATE
Verified: ba06e95 (2026-11-07)

- **dev** @ `ba06e95` (PR #464 merge). Merged today, in order: #457 (#440 terminal-claim eviction), #458 (#436 preset field parity), #459 (#455 survivor drain), #461 (#434 per-unit shape guard), #462 (#439 post-spawn containment), #463 (#456 Jev `--worktree` stated field), #464 (#447 acceptance marker). Docs: ADR 0023 (deadline ownership), ADR 0024 (unit projection), the #453 dossier, and `12a722e` (review-dispatch note: a bulleted `Verdict:` is invisible to the gate). Worktrees live: **`453`** (implementing).
- **Released:** **v2.7.0 LIVE** — `main` @ `98bd36e`, tag `v2.7.0`, npm `latest` 2.7.0. **Release checkpoint OPEN** (rule #6): every merged fix today (#440, #436, #455, #434, #439, and #447 when it lands) is extension code, merged and unreleased. Release on the maintainer's go only.
- **Board — autonomous bug sweep.** Closed today (7): #440, #436, #455, #434, #439, #456, #447. Open `bug`: **#453** (deadline ownership — impl running, brief revision 2 after a needs-work critique), **#460** (design-open: a never-settling branch-mode run wedges the git lock + queue; do not implement from the body). Enhancement: #426, #430. PR #402 still held.
- **Suite:** 109 files / **2333** green on dev (`--reporter=json`); typecheck clean. Budget **1.96** (48,777 test / 24,853 source, ceiling 2.0 → ~930 test lines of headroom, the ratchet is healthy again after #429/#431/#443 were thin). README says `2300+`. The `recovery.test.ts` load flake is fixed (#455) and verified under full-suite load.
- **Merge gate:** `merge-guard.sh <pr> <record>` from the **cockpit**. (a) CI runs the **merge ref** — a branch-green PR can be red on README count drift (cost #459 one cycle); (b) `#<pr>`; (c) line-start `Verdict:`; (d) reviewed head **or** `conductor-verified:`; (e) exact-text provenance match; (f) `recheck-<pr>` + its own `Risk class:`. Merge commits; PRs to `dev` never auto-close — close by hand.
- **Merge-conflict routine (three times today — #439, #447, and the CHANGELOG in general):** `dev` moves under a PR, and the conflict is **CHANGELOG.md ordering only** — keep both entries newest-first, commit the merge, re-run the gates, add a `Post-review merge:` line to the record naming the merge commit and the re-verified numbers, then re-push. The reviewed code was byte-identical in both cases.
- **Dispatch models + presets:** implementer `project-implementer` + `deepseek/deepseek-flash`; reviewer `project-reviewer` + `openrouter/meta/muse-spark-1.3-contributor`; plan critic `project-plan-critic` + `openrouter/openai/gpt-6.1-terra` + **`thinkingLevel: "medium"` always**; design investigation `project-proposer` + `inheritSystemPrompt: false`. Non-probe work: explicit `background: true` + `timeout: 7200000`.
- **Jev provenance:** print the line with `--classifier … --worktree y|n --label`, then **paste it verbatim** — never hand-type (both hand-typed lines today got the level wrong). Since #456 the `worktree` field can be **stated** (a Rule-5 process fact) and the row records `stated:worktree`, so a src dispatch no longer needs an exception; `level`/`risk` stay classifier answers. 24 exceptions remain recorded from before the fix, all in `.pi/jev-dispatch-exceptions.txt`.
- **Project flag:** `{"brl-subagent": {"processChecks": true}}` gates the Jev line, the two-arm dispatch-shape pre-flight and engineering-bar injection; fail-open, one reader.

### Since the last handover
- **Five bugs closed with measured evidence, none by assertion.** #455 was a *producer* bug (SIGKILL death sampled in the same instant as the signal — 40/40 probes alive; now a bounded drain, and both the drain **and** the grace loop are bounded twice because a no-op sleep defeated the clock bound alone). #439 contained the post-spawn tail *through result construction* and fixed a sibling-count theft (a finalize claim for an unregistered id decremented a live sibling, 1 → 0). #434 applied the pre-flight to batch units, judging the **declared** level (the capped one is `off` and would silently disable it). #436 made the preset field map a type-pinned table. #440 stopped a cap overflow from forgetting the claim it just made.
- **Every fix got a plan critique when the design was contestable, and the critiques paid:** #434 and #439 each needed **three** brief revisions (declared-vs-capped level, empty-string vs `timeout: 0` inheritance, `processChecks` re-read at a relative cwd, double notices; containment boundary through result construction, hoists, sibling accounting, non-terminal advisory). Mutants were named in every brief and killed by named tests; two reviews independently re-applied them.
- **Three subagent deaths and one stall** (connection errors): `impl-436` left the brief's M2 mutant applied in its worktree, `impl-434` left partial work, `impl-455` stalled with zero transcript output after committing. **Never trust a killed agent's worktree** — read `git diff` for a reversed condition before continuing.
- **The #453 critique found three blockers in my brief** (run-entry statuses are `running|done|failed` — no `stopped`; the timer's terminal write clears the registry and the session dir survives; and `findLast` does not stop raw-entry consumers double-counting a snapshot + amendment — measured 3 runs/$5 for a $2+$3 pair). Revision 2 adds a **logical-run projection** applied before any windowing, a `failed/timeout` snapshot, and an explicit durable-surface contract.

### Next actions
1. **#453** — impl running (xhigh, Steps 0-5 of the revision-2 brief, mutants M1-M10). C1 review next; it is the last implementable `bug`.
2. **#460** — design-open; do not implement from the body.
3. **Release checkpoint** — every fix in this sweep is extension code, merged and unreleased; the maintainer decides when.

```
