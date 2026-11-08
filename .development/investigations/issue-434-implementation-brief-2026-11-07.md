# #434 implementation brief (revision 3) — the shape guard reaches batch units

**Issue:** #434. **Risk:** C2. **Worktree:** `../brl-subagent-434` (`fix/434-unit-shape-guard`).
**Revision 3** — two critique rounds folded in. Items marked **[c1]** / **[c2]** come from those rounds
and are acceptance criteria, not suggestions.

## Recon (rule 13)

```
graph @ 6c8ee27: resolveThinkingDispatchSwitch → 2 symbol callers (index.ts, its suite),
25 affected symbols / 25 files. Verified independently on dev (codegraph status OK there);
in this worktree the index is absent, so the graph result is carried from the conductor's dev run.
grep delta: 26 raw hits (incl. comments) — no caller the graph missed.
```

## The gap

The dispatch guard judges the dispatch-level **declared** level (`declaredThinkingLevel(params.,
preset?.)`, `src/index.ts:2824`) + `params.timeout` (`src/params.ts:292-318`). Units carry their own
(`src/schema.ts:43-53`); `mergeSubTaskParams` (`:471-537`) lets the unit win per field; all four unit
sites pass `merged.timeout` (chain `:726/:751`, parallel `:1060/:1104`, graph `:1527/:1551`,
fan-out `:1878-1930`). A unit declaring `thinkingLevel:"high"` + `timeout:600000` with no top-level
pair reproduces the 2026-11-06 incident for that unit.

## The rule

Only the **drop** action is available per unit (a unit cannot become its own background dispatch).
Eligibility, all must hold:

1. `processChecks` on — the flag **threaded** from `execute` (**[c1]** never re-read: a relative
   `params.cwd` re-read measured `false` where dispatch resolved `true`);
2. `force !== true`;
3. the unit's **effective declared** level is `high`/`xhigh`. Effective declared =
   `step.thinkingLevel || dispatchDeclaredLevel` (**[c1]** never `merged.thinkingLevel`, which is
   capped: default cap `off` would silently disable the guard). `dispatchDeclaredLevel` is threaded
   from `execute` (`declaredThinkingLevel(params.thinkingLevel, globalParams.resolvedPreset?.thinkingLevel)`);
4. the unit's **merged** timeout is defined and `> 0` (only a positive timeout arms a foreground
   timer);
5. the unit **declares** `thinkingLevel` (non-empty string) **or** `timeout` (**[c2]**
   `step.timeout !== undefined`, including `0` — the merge uses `??`, so `0` *overrides* and arms
   nothing; it is a declaration but is never eligible because of clause 4);
6. the unit's shape is **foreground** (**[c2]**: the helper takes the shape explicitly; background
   fan-out units are excluded because their deadline is a legitimate budget).

Clause 5 is the #434/#431 boundary: a unit inheriting the dispatch's pair was already judged at
dispatch level, including the chain/graph exemption. Chain/graph get the guard for unit-declared
pairs and keep the exemption for inherited ones — pinned, not accidental.

**Effect:** `merged.timeout = undefined` before `createUnitRun`/snapshot/`startBackgroundAgent`
(ADR 0009 retry re-derivation).

## Notice — one per dispatch, emitted where it cannot lie

- If the dispatch arm already emitted (`THINKING_SWITCH_NOTICE` or `THINKING_TIMEOUT_DROP_NOTICE`;
  a boolean threaded from the switch site), emit **zero additional unit notices** — still drop.
  (**[c2]** the "one notice" count is about *additional* notices; the mixed case must show exactly
  one total.)
- Otherwise emit `THINKING_UNIT_TIMEOUT_DROP_NOTICE` **once per dispatch**, at the first affected
  unit **after its concurrency slot is acquired** and immediately before its run — never in a
  pre-pass (**[c2]**: merge precedes `acquireSlot`; a cancellation could otherwise be announced as
  affected without running).
- Wording must not claim completeness: no "all affected steps" phrasing. Parallel/fan-out may list
  the units that actually reached their run at emission time; chain/graph stay generic. (**[c2]**)
- One `log.info` per affected unit.

## Implementation shape

- `src/params.ts`: `shouldDropUnitTimeout({ processChecks, force, dispatchDeclaredLevel, unitShape,
  declaredLevel, declaredTimeout, mergedTimeout })` beside the dispatch predicate, documented as its
  unit projection; no restatement of the approval/background arms.
- `src/index.ts`: `applyUnitShapeGuard(ctx, step, merged)` at the four sites; a `BatchGuardContext`
  threaded to the handlers: `{ processChecks, dispatchDeclaredLevel, dispatchNoticeEmitted }`.
- `src/constants.ts`: the notice string.

## Tests (ADR 0021 §1 — no coverage percentages)

- **U1 / U1b** — parallel, unit declares high+600000, **cap `off`** and **cap `high`**: the observed
  runner timeout is `undefined`. (M8: capped-level judgement cannot pass U1.)
- **U2 / U2b** — chain step and graph node declaring high+timeout: dropped (positive graph case).
- **U3 / U3b** — inherited global high+600000 (chain, graph): remains `600000`.
- **U3c-a** — `thinkingLevel: ""` + global high + global timeout: **inherits** the level; not
  dropped on the level clause.
- **U3c-b** — `timeout: 0` + global 600000: **overrides** to 0; no timer, no notice (**[c2]**).
- **U3d** — each single-field override (level only, timeout only): dropped.
- **U4** — background fan-out: keeps 600000.
- **U5** — notice: two affected units ⇒ exactly one `sendMessage` + one `ui.notify`; mixed dispatch
  (dispatch arm emitted) ⇒ **zero additional**; wording contains no "all" claim.
- **U6 / U7 / U7b** — force; processChecks off; **relative-cwd opted-in** unit still dropped
  (**[c1]** a raw re-read mutant must fail U7b).
- **U8** — the persisted unit snapshot lacks the timeout **and** the retry's runner call receives
  `undefined`; the retry case must not pass via a second dispatch-level drop (**[c2]**: choose a
  retry whose restored params carry no top-level pair, and assert the second runner call).
- **U9** — a chain that fails before a later eligible step emits no notice for the unrun step; a
  parallel unit cancelled while waiting for a slot is not announced.
- **U10 (drift pin)** — a paired eligibility matrix: for declared pairs
  `{high,xhigh,medium,low,""} × {timeout 600000, absent, 0}`, `shouldDropUnitTimeout` agrees with
  `resolveThinkingDispatchSwitch` on the same declared pair for the foreground shape, except the
  documented unit-declaration clause. A one-sided mutation to either predicate fails U10.

## Mutants

| # | Mutation | Killer |
|---|---|---|
| M1 | remove the per-unit call | U1, U2, U2b |
| M2 | drop clause 5 | U3, U3b |
| M3 | drop the `force` clause | U6 |
| M4 | drop the `processChecks` clause | U7 |
| M5 | drop for background fan-out | U4 |
| M6 | per-unit notice, or emit when the dispatch already did | U5 |
| M7 | drop after `createUnitRun` | U8 (snapshot + runner call) |
| M8 | judge `merged.thinkingLevel` (capped) | U1 (cap `off`) |
| M9 | judge only the unit's own level, ignoring an inherited dispatch level | U3d (timeout-only override) |
| M10 | re-read `processChecks` from a relative cwd in the handler | U7b |

## Budget and boundaries

- Net test growth ≤ ~150 lines (headroom ≈ 400; reuse the dispatch-preflight runner/spawn seams).
- Non-goals: single foreground path, #439's notice contract, #453's ownership, approval-mode
  semantics, new config knobs, `resolveThinkingDispatchSwitch`'s dispatch behaviour.
- Gates from ONE JSON report: `npx vitest run --reporter=json --outputFile=/tmp/vitest-434.json`,
  `node scripts/check-test-budget.mjs /tmp/vitest-434.json`,
  `node scripts/check-readme-test-count.mjs /tmp/vitest-434.json`, `npm run typecheck`.
