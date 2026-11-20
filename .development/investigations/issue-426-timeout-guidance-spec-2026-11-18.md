# #426 E — the portable timeout guidance (the `timeout-guidance` cycle)

**Issue:** #426 — E (calibration). **Spec:** 2026-11-18 · **status: revised after critique round 4 (5 findings applied); ready for implementation** · **cycle:** `timeout-guidance` (U1).
**Risk:** C2 focused — the plan critic's call (the change is the registered, model-facing API guidance, not display prose; Rule 10 permits the upward rerate; the blind classifier said C3 0.96). The review-time recheck must use C2.
**Jev:** `jev: medium (0.52) · C3 · worktree n` (the plan-critique dispatch line, 2026-11-18, label `plan-critique-426`). **Round 2:** `jev: medium (0.62) · C3 · worktree n` (label `plan-critique-426-r2`, 2026-11-20). **Round 3:** `jev: medium (0.62) · C3 · worktree n` (label `plan-critique-426-r3`, 2026-11-20). **Round 4:** `jev: medium (0.62) · C3 · worktree n` (label `plan-critique-426-r4`, 2026-11-20).

## Context (verified)

The only live defect in #426 is E: the `delegate_task` **`promptGuidelines`** item 5 (`src/delegate-handler.ts:2167`) says *"Simple: 30s. Medium: 60s. Complex: 120s+. xhigh thinking: at least 120s."* The measured p50/p90 are 5–9m / 8–20m, so the shipped advice is 10–20× below the data; it is the one place a short deadline can still be chosen from the product's own text, and the #428 timeout (a 10m deadline on a 20m+ plan critic) is the observed failure class.

The line also mixes units: it says **seconds** (`30s`, `60s`, `120s+`) while the `timeout` parameter is **milliseconds** (`Set timeout (in ms)` at `:2151`; the README row says "Max milliseconds"). The model must convert, and the seconds scale is itself 10–20× below the measured minutes — both the value and the unit are wrong.

The line is **always shipped** in the tool registration surface — it is **not** gated by `processChecks` (that flag gates the dispatch pre-flight and the thinking switch; the `promptGuidelines` array is static). The semantics also live in `AGENT.md` §Deadlines and retries, the README `timeout` row (`:93`), and the registered `parameters.timeout` description (`src/schema.ts:127-133`; fixture line 86).

**The runtime contract the guidance must not overstate (critique major 2):**

- a **background** run with **no** explicit timeout gets the 30-minute default; the default is **not an enforced floor** — a shorter explicit value is accepted; a **foreground** run has **no default deadline**;
- an explicit **positive** value is honored as given, **except** a raw value `≥ 2³¹−1` ms **or a nonpositive value** (both normalize to "no timeout": for a background run the 30-minute default then applies; a foreground run has none) and the opt-in `processChecks` high/xhigh **foreground** switch, which may drop the explicit timeout (implemented in the dispatch pre-flight, `src/delegate-handler.ts:569-710`; `:2158` is the background-default guideline, not the switch);
- the 2-hour figure is a **fallback for an unknown shape**, not a universal safety guarantee; a slow/local model can need more; the reference cap is **not a runtime ceiling** (the only removal is the normalization of raw `≥2³¹−1`/nonpositive values).

**The decision locked by the maintainer (2026-11-18):** "safe for everyone" — the portable principle, the default, the explicit override and the 2h fallback are universal; the per-shape numbers are a **reference-workload** table, not universal priors; a user's own run history is the personal layer (a future unit, not this one).

## Recon (Rule 13 — codegraph @ `cc3a026`)

- target: `src/delegate-handler.ts` (the `delegate_task` registration surface)
- impact(delegate-handler.ts, depth 2): **31 affected symbols across 31 files**; **29 test files**
- **Graph gap (a finding, not a silent skip):** the source-reading guardrail `src/__tests__/conductor-guardrails.test.ts:46` pins the guidance text but is **not** in the graph's impact (it reads the registered text rather than importing the module); the critique found it with `rg`. It is in scope (blocker 1).
- change sites: `src/delegate-handler.ts:2151` and `:2167`; `src/schema.ts:127-133` (the registered `parameters.timeout` description); `src/__tests__/fixtures/registration-surface-876bb5d.json` (the `:2151`/`:2167` guidelines and the schema description at `:86`); `src/__tests__/conductor-guardrails.test.ts:46`; `src/__tests__/registration-surface.test.ts`; `AGENT.md` §Deadlines and retries. The README row `:93` is already correct (the normalization is documented; the opt-in switch is not user-facing) — no README change.

**Fresh recon (2026-11-20, HEAD `53fc8e7`; source unchanged since `cc3a026`).** Index refreshed; impact reproduces **31 affected symbols / 31 files / 29 test files**; the edit sites remain `:2151`/`:2167` and `src/schema.ts:127-133` (fixture :86); the graph gap is confirmed. Two follow-ups were fixed in this spec: the test target is the **guardrail numbered 5** (the `promptGuidelines` element carrying `5. **Timeout**` / the new `**5. Timeout:**`), **not** `promptGuidelines[5]` (the `Use outputFile` item) — so the `\d+s` pin cannot be vacuous; and the high-thinking foreground switch is referenced at **`src/delegate-handler.ts:569-710`** (`processChecks`), **not** `:2158` (that line is the background-default guideline and does not mention the switch).

## Evidence — the replay (2026-11-18)

**Provenance.** Log: `.pi/subagent-logs/brl-subagent.log` (gitignored, `.gitignore:11`; the source is mutable — the historical hash pins the snapshot). SHA-256 at the critique's completion: `7ed3f82fe9ceb75fc16bffde0873d7d6fa958176c815ab7632264725b6e8cfc8`; the **current** log has hashed `882f0d4d…` (round 2) and `4a9568eb…` (round 3); the historical snapshot is not available, so the historical hash cannot be re-verified. Window: **2026-11-04T14:37Z → 2026-11-18T13:45Z** (the later `plan-critique-426` run at 14:22Z is excluded by the window). Selection: every `Background agent spawned` with a matching `Background run settled`; the model from the spawn; the duration = settle − spawn; the status from the settle; **no other exclusions**; the **completed-only** stats are the cap basis, the failed runs (23 transport + one user abort) are not legitimate work. Quantile method: linear interpolation at `(n−1)×p`. Probes are **not** a separate validated class; they are inside their model's cohort (e.g. the 14.32m "TRIAGE / reachability probe" in the deepseek cohort).

| model cohort (descriptive) | n (done/failed) | completed p50 | p90 | p99 | max | reference cap |
|---|---|---|---|---|---|---|
| deepseek-flash (implementation + probes + 24 failures: 23 transport + 1 abort) | 106 (82/24) | 9.1m | 19.8m | 26.9m | 28.4m | **60m** |
| muse-spark / muse-ember (review) | 70 (60/10) | 4.8m | 8.2m | 16.0m | 16.3m | **20–30m** |
| gpt-6.1-terra (critique) | 39 (37/2) | 1.6m | 6.1m | 10.0m | 10.6m | **30m** |
| qwen3.8-max (critique; n=2) | 2 (2/0) | 29.7m | — | — | 35.1m | **60m** (caveat) |
| all background | 217 (181/36) | 5.2m | 15.7m | 26.9m | 35.1m | **2h fallback** |

- The **model cohorts are descriptive**, not validated task classes: the deepseek cohort includes probes and 24 failures (23 transport + 1 user abort); the completed-only stats are the cap basis.
- The **review median** is 4.5m across all 70 runs (linear interpolation) and 4.8m completed-only; the earlier 4.6m figure was the spark all-status median — corrected.
- The **failed runs are excluded from the caps** (the 24 deepseek failures — 23 transport + one abort — all exceed 2m; counting them as legitimate work was a critique finding).
- **The current 2m "complex" cap**, completed runs only: **68/82 deepseek (83%)**, **58/60 review (97%)**, **17/37 terra (46%)**, **2/2 qwen** — it would have killed most legitimate work. The 30s/60s bands are worse.
- **The tail check** (the reason the values swing):
  - **review 15m → 20–30m**: 2/60 completed review runs exceed 15m; the max is 16.3m;
  - **critique 30m → 60m**: the qwen 35.1m (1/2); terra's max is 10.6m (30m fine);
  - **implementation → 60m**: the deepseek completed max is 28.4m; a 30m cap is only 1.6m above it;
  - **probe**: no separate cap — use the **30-minute background default** for a background probe unless local evidence supports shorter; a foreground/inline probe (`background: false`) has no default — pass an explicit timeout; the n=4 sample (max 14.3m) is descriptive only;
  - **2h**: 0/217 above 120m in this snapshot; it is the **fallback for an unknown shape**, not a guarantee.

## Design

### 1. `src/delegate-handler.ts:2167` — the portable policy (always shipped)

Replace item 5 with:

> **5. Timeout:** A deadline is a cap, not a schedule: over-allocating is cheap, under-allocating is expensive. The `timeout` parameter is milliseconds; think in minutes. The 30-minute **background** default applies only when no valid timeout remains after normalization — it is a default, not an enforced floor; a **foreground** run has no default deadline. An explicit **positive** value is honored as given, except a raw value ≥ 2³¹−1 ms **or a nonpositive value** (both normalize to no timeout; a background run then gets the 30m default, a foreground run has none) and the opt-in high-thinking foreground switch that may drop it. When in doubt **pass `timeout: 7200000`** (2 hours); for slow/local models or long tasks, pass more. Reference-workload priors: `AGENT.md` §Deadlines and retries.

### 2. `src/delegate-handler.ts:2151` — the parameter semantics, reconciled

Replace with:

> Set timeout (in ms) to limit how long a subagent can run. Useful for tasks that might hang or get stuck. Background runs default to a 30-minute deadline when no timeout is given; a foreground run has no default. An explicit **positive** timeout is honored as given — except a raw value ≥ 2³¹−1 ms **or a nonpositive value** (both normalize to no timeout; for a background run the 30-minute default then applies, a foreground run has none) and the opt-in high-thinking foreground switch that may drop it. 30 minutes is a **background** default, not a ceiling.

The `AGENT.md` deadline bullet gets the same exceptions (the valid positive range, the overflow/nonpositive normalization, the background default vs the foreground none, and the opt-in switch); the README row already documents the normalization and is unchanged.

### 3. `src/schema.ts:127-133` — the registered parameter description

Replace with:

> Maximum time in milliseconds the subagent is allowed to run. A **background** run with no valid timeout (none passed, or normalized away) gets the 30-minute default deadline; a **foreground** run has no default. An explicit **positive** timeout is honored as given, except values that normalize to no timeout (a raw value `≥ 2^31-1` or a nonpositive value; a background run then gets the 30-minute default, a foreground run has none) and the opt-in `processChecks` high/xhigh foreground switch, which may drop an explicit timeout. **Foreground expiry** kills the process (SIGTERM, 5s grace, then SIGKILL); the expired attempt's result is a timeout error, and with `retryOnTimeout: true` the tool may retry automatically and return the later result. **Background expiry** requests a cooperative abort — a prompt that ignores it keeps running; the run's **timeout snapshot** (`failed`/`timeout`) is written at expiry, and a later settle **amends** that record (never re-classifies it).

The schema is model-facing and fixture-pinned at `registration-surface-876bb5d.json:86`; update the fixture with the schema description. The README row already documents the normalization; the opt-in switch is not user-facing.

### 4. `AGENT.md` §Deadlines and retries — the reference table

Append after the existing deadline bullet:

```
**Reference priors (2026-11-18 snapshot).** The table uses minutes; the `timeout` parameter itself is milliseconds. Reference workload: this repo, 2026-11-04T14:37Z → 2026-11-18T13:45Z; 217 settled background runs; the model cohorts are descriptive (each includes whatever tasks that model ran); the completed-only stats are the cap basis. Your mileage will vary: use your own run history when you have it; the 2h fallback is for an unknown shape, not a guarantee; a slow/local model needs more — pass a larger explicit timeout (a valid positive value is honored unless the opt-in high/xhigh foreground switch drops it; the only removals are that switch and the normalization of raw ≥2³¹−1/nonpositive values: a background run then gets the 30m default, a foreground run has none). The reference cap is not a runtime ceiling.

| model cohort (descriptive) | n (done/failed) | completed p50 | p90 | p99 | max | reference cap |
|---|---|---|---|---|---|---|
| deepseek-flash (implementation + probes + 24 failures: 23 transport + 1 abort) | 106 (82/24) | 9.1m | 19.8m | 26.9m | 28.4m | 60m |
| muse-spark / muse-ember (review) | 70 (60/10) | 4.8m | 8.2m | 16.0m | 16.3m | 20–30m |
| gpt-6.1-terra (critique) | 39 (37/2) | 1.6m | 6.1m | 10.0m | 10.6m | 30m |
| qwen3.8-max (critique; n=2) | 2 (2/0) | 29.7m | — | — | 35.1m | 60m (caveat) |
| all background | 217 (181/36) | 5.2m | 15.7m | 26.9m | 35.1m | 2h fallback |

- The cap is a **reference ceiling above the observed tail** for that model cohort's completed work, not a runtime ceiling or a target. A run that hits it is aborted (background) or killed (foreground); pass a larger explicit timeout if you know the task/model needs it (a valid positive value is honored unless the opt-in high/xhigh foreground switch drops it; raw ≥2³¹−1/nonpositive values normalize to no timeout, background then 30m, foreground none).
- The 30-minute **background** default applies when no valid timeout remains after normalization; a **foreground** run has no default. It is a default, not an enforced floor.
- Quick probes are not a separate validated cohort; the 4-run sample is descriptive only. Use the 30-minute **background** default for a **background** probe unless your own history supports a shorter cap; a **foreground/inline** probe (`background: false`) has no default — pass an explicit `timeout` if it needs a cap. The opt-in high/xhigh foreground switch may drop an explicit timeout.
- The qwen row is n=2 — a caveat, not a rule; the 60m cap covers it, and the 2h fallback is for an unknown shape.
```

### 5. README — no change

The `timeout` row (`:93`) already states the default and the normalization; the opt-in switch is not user-facing. The reference table is conductor guidance, not user docs.

### 6. The pins

- `src/__tests__/fixtures/registration-surface-876bb5d.json` — update the `:2151` and `:2167` guidelines **and the schema description at `:86`**.
- `src/__tests__/conductor-guardrails.test.ts:46` — **the blocker**: update the assertion from `"Set timeout based on task complexity"` to the new guidance (the test reads the registered text; the exact old phrase must not survive).
- `src/__tests__/registration-surface.test.ts` — the test captures the registered `tools`, their `promptGuidelines` and their `parameters` (there is no `surface` variable); the `parameters` comparison covers the schema description via the fixture. Target the **guardrail numbered 5** — the `promptGuidelines` array element carrying `5. **Timeout**` / the new `**5. Timeout:**`, **not** `promptGuidelines[5]` (the `Use outputFile` item). Assert that element contains the new unit/line (`The `timeout` parameter is milliseconds`, `default, not an enforced floor`, `2 hours (7,200,000 ms)`) and that **none of the retired bands** (`30s`, `60s`, `120s`) appears in it. **Stronger unit pin:** assert that guardrail contains **no `\d+s`-suffix number** (`expect(guardrail5).not.toMatch(/\b\d+\s*s\b/)`), so any seconds/ms confusion is rejected, not just the three known bands. A whole-surface substring check is not sufficient (a phrase elsewhere could satisfy it).

## Acceptance

- Both `:2151` and `:2167` are replaced; the parameter schema description (`src/schema.ts:127-133`) is reconciled; the fixture updates the two guidelines and the schema description (`:86`); the old `30s`/`60s`/`120s` bands are absent from the source, the fixture, and the conductor-guardrails assertion; **no `\d+s`-suffix number appears in the guardrail numbered 5**; the new lines state the unit, the **background-only** default (not a floor; foreground has none), the valid positive range, and the overflow/nonpositive + opt-in-switch exceptions.
- `conductor-guardrails.test.ts` and `registration-surface.test.ts` pass (the latter includes the `parameters`/schema description); the targeted suites are run first.
- `AGENT.md` carries the reference table, the model-cohort label, the done/failed counts (**23 transport + one abort** in the deepseek row), the completed-only stats (terra **1.6m/6.1m**), the 2h fallback, the reference-not-runtime-ceiling note, and the background-vs-foreground probe note.
- The README is unchanged; the `:2151`, `AGENT.md` and **schema** wording is reconciled with the runtime contract (the background default vs the foreground none, the positive range, the overflow/nonpositive normalization, and the opt-in switch).
- Full suite, `npx tsc --noEmit`, `docs-arch`, `docs-decisions`, `git diff --check` green; the flow budget (allowance 120 + 2× net source growth) is respected.
- No runtime/default/deadline behavior changes.
- A real point-of-use probe (Rule 9 / C2, `.pi/skills/worktree/SKILL.md:85-89`): load the **candidate worktree** in an isolated pi (`pi -ne -e <worktree>`; `.pi/skills/worktree/references/local-development.md:41-53`), exclude the installed npm copy, record the worktree path/HEAD and the pi invocation, and observe the registered `delegate_task` `promptGuidelines`/`parameters` text from that candidate; no stale/dual copy. Fixture/typecheck alone are not sufficient.
- The PR merges to `dev`; after the merge, **stop at the release checkpoint** (`.pi/skills/worktree/SKILL.md:64-73`): state it and wait for the maintainer's decision; reload/update is user-triggered. Then close #426 manually (PRs to `dev` do not auto-close; the default branch is `main`); the B/C/D triggers are recorded in the close row.

## Non-goals

- No runtime timeout/default change; the 30m default, `armDeadline`, `normalizeTimeout` and the deadline ownership are untouched.
- No B/C/D (soft stage, stall watchdog, extension) — all still trigger-parked.
- No local-history/personalization feature; no telemetry.
- No table in the prompt; no "universal priors" claim; no README duplication; no release (the maintainer's call).
- **No change to the `timeout` parameter's unit: it stays milliseconds.** The wire unit is deliberate — JS timers/`setTimeout`, the SDK convention, the run records' `timeoutMs`, the retry snapshots and the existing 7200000 values. A unit change (seconds, a `{value, unit}` object, a `timeoutMs` rename) is a breaking API change with a migration, out of scope for this unit; the guidance states the unit once and uses minutes for the human scale.

## Critique round 1 (2026-11-18)

`project-plan-critic` (terra, medium) — **Verdict: needs-work**, audited `cc3a026`. Disposition — **all six accepted**:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | blocker | `conductor-guardrails.test.ts:46` pins the old phrase; the spec's scope omitted it | Accepted — added to scope; the assertion updates to the new guidance; the targeted suites |
| 2 | major | "floor"/"no ceiling" overstate the runtime; a shorter explicit background timeout is accepted, `≥2³¹−1` ms normalizes to the default, and the opt-in high-thinking foreground switch may drop the timeout | Accepted — the line now says **default, not an enforced floor**; both exceptions stated; `:2151` and `AGENT.md` reconciled |
| 3 | major | the model cohort is presented as a task shape; probes sit inside the implementation model; failures counted as legitimate; the 4-probe row has no membership rule | Accepted — the table is **model cohorts** with done/failed and completed-only stats; the probe row is removed (30m default; descriptive only) |
| 4 | major | the 15m probe cap has <1m margin on n=4 and is presented as a cap | Accepted — no probe cap; **use the 30m default** unless local evidence supports shorter; the n=4 sample is descriptive only |
| 5 | minor | percentile method/probe selection unspecified; the muse median is 4.5, not 4.6; the log is ignored/mutable | Accepted — the provenance records the hash, window, selection, quantile method and exclusions; the median is corrected (4.5 all / 4.8 completed) |
| 6 | minor | the illustrative `surface` variable does not exist; the whole-surface substring check is weak | Accepted — the assertion targets the registered `delegate_task` guardrail numbered 5 (the `promptGuidelines` element carrying `5. **Timeout**`; not array index 5) and checks the retired bands are absent |

**Verified sound by the critic:** HEAD `cc3a026`; the issue is open and the handoff records the locked direction/cycle; the join reproduces 217/181/36, the model counts and the tail maxima (two muse >15m, one qwen >30m, none >2h); `codegraph-check.py` reports a HEAD-built index; the edit surfaces are tracked; `AGENT.md` ships; the ms conversions are correct; **C2 focused** is the review class (the registered, model-facing API guidance).

## Critique round 2 (2026-11-20)

`project-plan-critic` (terra, medium) — **Verdict: needs-work**, audited `53fc8e7`. Disposition — **all six accepted and applied; round 3 in flight**:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | major | The proposed text gives an overflowed timeout "the default" for all runs and says "there is no ceiling"; foreground has no default, overflow/nonpositive values normalize to no timeout, and nonpositive values are another exception to "honored as given". | Accepted — qualify by execution mode and the valid positive range (background 30m vs foreground none; overflow/nonpositive; the opt-in switch). |
| 2 | major | The scope omits the registered parameter schema description (`src/schema.ts:127-133`; fixture line 86), which independently says overflow "normalizes to the default". | Accepted — add the schema description and the fixture's schema description to the scope and reconcile. |
| 3 | major | "Use the 30-minute default for a probe" is ambiguous for the documented inline probe (`background: false`); foreground has no default. | Accepted — distinguish the background probe default from an explicit foreground cap. |
| 4 | major | The terra completed p50/p90 are **1.6m / 6.1m**, not 1.8m / 6.0m, under the stated join/interpolation. | Accepted — correct both tables. |
| 5 | minor | The 24 deepseek failures are **23 transport + 1 user abort**, not all transport. | Accepted — label as 23 transport + 1 abort; completed-only counts unchanged. |
| 6 | minor | The literal unit assertion (`the timeout parameter is milliseconds`) does not match the proposed text (capitalization/backticks). | Accepted — make the prose and assertion agree exactly, or specify a normalized match. |
| — | note | The historical log hash `7ed3…` cannot be re-verified; the current log hashes to `882f…` and the historical snapshot is not available. | Accepted — record in Remaining risks; the join reproduces 217/181/36 from the current log. |

**Verified sound:** HEAD `53fc8e7`; `git diff --stat cc3a026 HEAD` is two `.development` docs only; the replay join reproduces 217/181/36 with matching cohort counts; array index 5 is the output-file guideline, not guardrail 5; `delegate-handler.ts:569-710` is the process-checks switch; `codegraph-check.py` reports a HEAD-built index (nested test paths excluded from its boundaries); no repo files were modified. The **round-2 fixes are applied**; round 3 is in flight.

## Critique round 3 (2026-11-20)

`project-plan-critic` (terra, medium) — **Verdict: needs-work**, audited `53fc8e7`. Disposition — **all five accepted and applied; round 4 in flight**:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | major | The schema description and the AGENT.md table omit the high-thinking foreground switch, contradicting the acceptance criterion and the other guidance. | Accepted — add the switch exception to both surfaces. |
| 2 | major | The schema says an exceeded timeout kills the subagent and returns an error, including for background; background expiry is a cooperative abort, not a guaranteed kill/inline error. | Accepted — state the foreground kill/error and the background cooperative abort + limitation separately. |
| 3 | major | The C2 acceptance has fixture/unit checks but no real point-of-use probe. | Accepted — add a real dispatch/registration probe and record the observed model-facing guidance. |
| 4 | minor | "Default applies only when no timeout is passed" contradicts the normalization (nonpositive/overflow also produce the default). | Accepted — say "when no valid timeout remains after normalization." |
| 5 | minor | "Closes on merge" is ambiguous for a PR to `dev` (default branch is `main`). | Accepted — specify the manual close after the `dev` merge (or defer to the default branch). |
| — | note | The current log hash has changed to `4a9568eb…`; the historical snapshot remains unavailable. | Accepted — update the provenance note. |

**Verified sound:** HEAD `53fc8e7`; `git diff --stat cc3a026 HEAD` is two `.development` docs only; `registration-surface.test.ts:130-149` compares the registered `parameters` (including the schema description) against the fixture; guardrail 5 is a content target; the unit assertion matches; the replay joins 217/217 (181 done / 36 failed), terra 1.61/6.12m, deepseek 23 connection + one abort; the reference table distinguishes the runtime ceiling and the background/inline probes; the README no-change and C2 are consistent. The **round-3 fixes are applied**; round 4 is in flight.

## Critique round 4 (2026-11-20)

`project-plan-critic` (terra, medium) — **Verdict: needs-work**, audited `53fc8e7`. Disposition — **all five accepted and applied; ready for implementation**:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | major | Background classification is not deferred until settle; an abort-ignoring prompt can still run after the `failed`/`timeout` snapshot exists. | Accepted — state the snapshot is written at expiry and a later settle amends it. |
| 2 | major | Foreground expiry does not always make the tool return an error; `retryOnTimeout` can retry and succeed. | Accepted — describe the attempt's timeout result and qualify the tool result with retry. |
| 3 | major | The live probe does not identify how the candidate worktree reaches the running pi or how to exclude the installed npm copy. | Accepted — specify the isolated `pi -ne -e <worktree>`, the candidate path/HEAD and the recorded provenance; require the observed model-facing text from that candidate. |
| 4 | major | The post-merge close ritual omits the required release checkpoint and wait. | Accepted — sequence the stop/checkpoint/maintainer decision before closing #426 or the cycle. |
| 5 | minor | "When in doubt use 2 hours" does not explicitly instruct passing `timeout`. | Accepted — "pass `timeout: 7200000`". |
| — | note | The historical log snapshot remains unavailable; its original hash was not re-verified. | Accepted — keep the provenance caveat. |

**Verified sound:** HEAD `53fc8e7`; `git diff --name-only cc3a026 HEAD -- src AGENT.md README.md` empty; the schema fixture-pinned at line 86 and compared at `registration-surface.test.ts:130-149`; the switch in the schema/reference table; guardrail 5 is the numbered item; `defaultBranchRef` is `main`; C2 focused; no files modified. The **round-4 fixes are applied**; the spec is ready for implementation.

## Remaining risks

- The historical log snapshot is not available: the current log has hashed `882f0d4d…` (round 2) and `4a9568eb…` (round 3); the spec's historical `7ed3f82f…` cannot be re-verified; the join reproduces 217/181/36 from the current log.
- The model cohorts are descriptive, not validated task classes; the user's own history is the personal layer.
- The 2h is a fallback for an unknown shape, not a universal guarantee; a slow/local model may need more; the reference cap is not a runtime ceiling (the only removals are the opt-in switch and the normalization of raw ≥2³¹−1/nonpositive values).
- The review 20–30m and the qwen n=2 are reference figures, not predictions; the 60m cap covers the observed 35.1m.
- The probe sample is removed from the table; no probe cap is asserted; a background probe uses the 30m default and a foreground probe has none.
- The `conductor-guardrails.test.ts`, the fixture's guidelines **and the fixture's schema description / `parameters` comparison** are the pins; the targeted assertion must fail if a retired band returns or the phrase moves elsewhere.
- No runtime behavior changes; the C2 review checks the guidance against the runtime contract.

## Unit shape

One worktree `feat/timeout-guidance` from the spec commit; implementer `project-implementer` + `deepseek/deepseek-flash`; the spec is input, committed to `dev` before the worktree, and is not a PR file. Scope: `src/delegate-handler.ts` (`:2151` + `:2167`), `src/schema.ts:127-133`, `src/__tests__/fixtures/registration-surface-876bb5d.json` (the guidelines and the schema description `:86`), `src/__tests__/conductor-guardrails.test.ts`, `src/__tests__/registration-surface.test.ts`, `AGENT.md`. README unchanged. Verification includes the real point-of-use probe (the isolated `pi -ne -e <worktree>`; Acceptance). Review: **C2 focused** (the critic's call; the review-time recheck must be C2). The PR merges to `dev`; after the merge, stop at the release checkpoint and wait for the maintainer before closing #426 (PRs to `dev` do not auto-close; the default branch is `main`); the `timeout-guidance` cycle close ritual runs after the merge. Release: the maintainer's call (no version proposed here).
