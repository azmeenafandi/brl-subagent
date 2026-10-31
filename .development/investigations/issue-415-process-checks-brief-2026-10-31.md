# Issue #415 — implementation brief: one umbrella `processChecks` flag

Base: worktree `fix/415-process-checks` @ `26c4976` (dev `dd61159` + this brief). Issue: #415. ADR 0019 will supersede the global part of 0018.

## Goal

Scope **both** process mechanisms — the Jev dispatch-line check (#407/#412) and rule 2's durable-shape
auto-switch (#412) — behind one project-local opt-in. Users get exactly the shape they ask for, with no new
required parameter and no rejection. This checkout opts in.

## Verified seams

- `src/dispatch-line.ts` — the parser (`parseDispatchLine`, `DISPATCH_LINE_FORM`, `JEV_UNAVAILABLE`) **and**
  `isJevLineRequired(cwd)`, which reads `package.json` `brl-subagent.requireJevLine`.
- `src/validate.ts` — `if (config.cwd !== undefined && isJevLineRequired(config.cwd)) { … }`.
- `src/params.ts` — `resolveThinkingDispatchSwitch(input)`; `THINKING_SWITCH_NOTICE`; the predicate returns
  `"switch" | "forced" | "none"`.
- `src/index.ts` — the switch is computed after template/retry resolution and before `preflightCheck` /
  `validatePreTask`; the resolved cwd is `params.cwd ?? ctx.cwd`.
- `package.json` — currently `{"brl-subagent": {"requireJevLine": true}}`.
- Tests: `dispatch-line.test.ts` (opt-in fixtures), `dispatch-preflight.test.ts` (switch fixtures + the ordering
  test), `session-manager.test.ts` (appendSystemPrompt — unaffected), `architecture-rules`/`runtime-vocabulary`
  (the runtime-vocabulary allow-list already covers `dispatch-line.ts`; keep it green).

## Design

1. **New `src/project-flags.ts`** — the single reader:
   - `readProcessChecks(cwd): boolean` — read `<cwd>/package.json`; **fail-open**: missing, unreadable, or invalid
     JSON → `false`; return `data?.["brl-subagent"]?.processChecks === true`.
   - `PROCESS_CHECK_KEYS = ["processChecks"] as const` (the ratchet's whitelist).
   - `dispatch-line.ts` keeps the parser and **drops** `isJevLineRequired` (move the read out).
2. **`validate.ts`** — `isProcessChecksEnabled(config.cwd)` instead of `isJevLineRequired`.
3. **`params.ts`** — add `processChecks: boolean` to `resolveThinkingDispatchSwitch`'s input; when `false` →
   `"none"` (no switch, no notice, the user's `background`/`timeout` stand as given).
4. **`index.ts`** — resolve the cwd once, `const processChecks = readProcessChecks(effectiveCwd)`, pass it to the
   switch predicate; the switch ordering (before the retry snapshot) is unchanged.
5. **`package.json`** — rename the field: `{"brl-subagent": {"processChecks": true}}`.
6. **Tests (red first)**:
   - **User path**: temp cwd, `package.json` without the field — dispatch `high` + `background:false` +
     `timeout: 600000` → **foreground** spawn, timeout **preserved**, no notice; a line-less task → spawns.
   - **Our path**: cwd = repo root (field present) → the switch applies (background + notice, timeout dropped);
     a line-less task → rejected before spawn.
   - **Fail-open**: malformed JSON and a missing file → `false`.
   - **Ratchet**: `src/**` contains no `brl-subagent` package.json read outside `src/project-flags.ts` (grep-based);
     this repo's `package.json` carries the field (so it cannot be silently dropped).
7. **ADR 0019** — supersedes the global part of 0018: the umbrella flag, fail-open, the ratchet, and the rule that
   the flag is dev-only and never marketed. Run `npm run docs:decisions`.
8. **Changelog** — rewrite the two #412 entries to the opt-in framing (they currently describe global behavior).
9. **Schema text** — the `background` description's "ONE pre-flight exception" becomes conditional on
   `processChecks`; `noJev`'s text stays accurate.
10. **SKILL** — one line: this checkout opts in via `package.json`; the flag is never documented as a user feature.
11. **Release ritual** — one line: exercise the published tarball from a temp project **without** the field
    (user path) before publishing.

## Non-goals

- No change to the Jev line format, the provenance log, the merge gate, or `AGENT.md`.
- No per-rule flags (the umbrella replaces `requireJevLine`).

## Stages

1. Worktree `../brl-subagent-415-process-checks` on `fix/415-process-checks`; re-stamp refs at the base sha.
2. Red tests → the reader + renames → gates (`npm run typecheck`; the CI reporter form; `docs:arch` write;
   `docs:decisions` write; check-mode docs scripts; `jev-check --selftest`).
3. C1 review; merge gate (this repo has `processChecks` on, so the line check applies to every dispatch).
