# Adversarial Review — PR #1: Per-Preset Model Selection

Reviewed worktree: `brl-subagent-per-preset-model` (HEAD `0497a3d`, on top of `main`)
Scope of diff: `src/index.ts` (+69/−9), `src/presets.ts` (+3), `src/types.ts` (+1)
Tests run: `npx vitest run` → **555/555 pass** (incl. the 6 new tests in `preset-model.test.ts`)

---

## Verdict summary

The core idea is sound and the wiring is *mostly* correct, but the feature is only half-delivered:

1. **Global preset model works in single/chain/parallel/graph — per-step preset models do not work at all** (and `background: true` single-mode bypasses the feature entirely).
2. The `modelRegistry.find()` call is API-correct and cannot throw (verified across pi 0.79.8–0.83.0), **but it checks catalog existence, not provider auth** — so the promised "fallback when preset model is unavailable" silently fails to trigger for unauthenticated providers, and the subagent crashes at spawn instead.
3. The 6 new tests are meaningful but cover only the parsing/persistence layer; the actual resolution logic (the heart of the PR) has zero test coverage.
4. **The tests are not part of the PR**: `src/__tests__/` is in `.gitignore` — the commit contains only `index.ts`, `presets.ts`, `types.ts`. The "6 new tests" exist only on disk and would be lost in a fresh clone / never run in CI.

---

## 1. Does preset model resolution work in all 4 modes?

| Mode | Global (top-level) preset model | Per-step/per-task preset model |
|---|---|---|
| Single (`task`, foreground) | ✅ `resolveSubagentModel(ctx, resolvedPreset)` at index.ts:2324 | n/a |
| Single (`background: true`) | ❌ **bypassed entirely** | n/a |
| Chain (`chain`) | ⚠️ works — resolved once (index.ts:516), same model for every step | ❌ ignored |
| Parallel (`tasks`) | ⚠️ works — resolved once (index.ts:899) | ❌ ignored |
| Graph (`graph`) | ⚠️ works — resolved once (index.ts:1287) | ❌ ignored |

Details:

- **Background mode gap (real bug).** In `delegate_task.execute`, the `if (params.background)` branch (index.ts:2062) spawns via `spawnBackgroundSession(pi, ctx, {...})` and returns **before** `resolveSubagentParams`/`resolveSubagentModel` are ever reached. The call passes `type: params.preset` but **no `model`** — `agent.model` ends up `'unknown'` and the session uses the conductor's model. So `preset` + `background: true` silently ignores the preset model (and, pre-existing, the preset's system prompt too). Fix: resolve the model before the background branch (or pass `subagentModel` into `spawnBackgroundSession`, which already accepts `model?: string`).

- **Per-step presets are dead config (pre-existing, but now the headline gap).** The tool schema (index.ts:1833–1890) advertises `preset` on every chain step, parallel task, and graph task. But `mergeSubTaskParams` (index.ts:350) never reads `subTask.preset` — the PR doesn't touch it. A chain that mixes `preset: rapid-prototyper` (cheap model) and `preset: security-auditor` (strong model) runs **every step on the single global model**. If "per-preset model selection" is meant to compose with per-step presets, this PR delivers only the global-preset case. The model is also resolved once *before* the step loop, so even fixing `mergeSubTaskParams` wouldn't be enough — resolution would need to move inside the loop.

- **Scheduler / retry paths** route through `delegate_task` with `params.preset` restored (`resolveRetryParams`, history.ts:142), so they inherit the (foreground) fix correctly.

- **Auto-route never fires in chain/parallel/graph** (requires `params.task`, which mode detection forbids alongside chain/tasks/graph), so no interaction there.

## 2. Is `modelRegistry.find()` correct? Could it throw?

Verified against pi SDK type definitions for **0.79.8, 0.80.10, 0.82.1, 0.83.0** — all four ship:

```ts
class ModelRegistry {
    getAll(): Model<Api>[];
    getAvailable(): Model<Api>[];
    find(provider: string, modelId: string): Model<Api> | undefined;
}
```

- **Signature is correct.** `registry.find(m.provider, m.id)` matches. The `getAll()` fallback also exists in every checked version; optional chaining covers absent `modelRegistry`/`find`/`getAll`.
- **Cannot throw in practice.** `find` → `runtime.getModel` → `getModels(provider)` returns `[]` for unknown providers and try/catches per-provider errors internally; the PR additionally wraps everything in try/catch → `false`. No uncaught throw path found.
- **Semantic problem — `find()` ≠ "available".** `find` searches the **full catalog** (`getModels()`), i.e. *all built-in providers, whether or not the user has an API key*. `modelIsAvailable()` is therefore really "exists in catalog". Two consequences:
  - A preset model from an **unauthenticated** provider passes the check → the subagent spawns with `--model provider/id` → pi fails at spawn ("No API key found for X") → the run/chain aborts with a runtime error instead of the promised fallback. The fallback only triggers when the model isn't in the catalog at all — for built-in providers that is nearly never (all catalog models are registered regardless of auth, per `ModelRuntime.rebuildProviders`).
  - The codebase already has an auth-aware notion of availability: the model selector (`tui.ts:118`) uses `ctx.modelRegistry.getAvailable()`, plus `hasConfiguredAuth(model)` / `getProviderAuthStatus(provider)` exist on the registry. The PR should use one of those (best-effort, with the try/catch retained) if the fallback is meant to protect against unavailable providers. At minimum, document that "unavailable" means "not in catalog".

## 3. Edge cases

| Input | Behavior | Verdict |
|---|---|---|
| `model: no-slash-here` (invalid format) | `parseModelString` → null → `log.warn` + fallback to configured/conductor model | ✅ graceful |
| `model: ""` / missing | `preset?.model` falsy → skip, identical to pre-PR path | ✅ |
| `model: /foo`, `model: foo/` | `idx <= 0` / `idx === len-1` → null → fallback | ✅ |
| `model: openrouter/anthropic/claude-3.5-sonnet` | split at **first** slash → `{provider:"openrouter", id:"anthropic/claude-3.5-sonnet"}` — nested ids handled correctly | ✅ |
| `model: anthropic/Claude-Opus-4-6` (wrong case) | `find` fails → warn + fallback | ✅ |
| Provider absent from catalog | warn + fallback | ✅ |
| Provider present but **no API key** | `find` succeeds → **no fallback** → spawn-time crash | ❌ (see §2) |
| Non-string `model` (e.g. YAML list) | frontmatter parser yields arrays; `parseModelString(array)` → `array.indexOf` exists → null → fallback; no throw | ✅ |
| Value junk (`# comment`, stray quotes) | lookup fails → warn + fallback | ✅ |
| Model id with `: ` (e.g. `foo/bar: baz`) | breaks naive frontmatter round-trip (see §6) | ⚠️ cosmetic |

No crash path found in `parseModelString`/`modelIsAvailable` for any input the parser can produce.

## 4. Does `resolvedPreset` flow through `resolveSubagentParams` in chain/parallel?

- **Wiring is correct for the global preset.** `resolveSubagentParams` returns `resolvedPreset: preset` (a `SubagentPreset` object; note the name shadows the input string variable — confusing but correct), and all four foreground call sites pass it: chain 516, parallel 899, graph 1287, single 2324. The pool pre-warm call (3034) correctly passes nothing (no preset context there; pool matching is by model string so a preset-model run gets a correctly-modeled fresh spawn, just no pre-warm benefit).
- **Per-step presets never reach resolution** — `mergeSubTaskParams` drops `subTask.preset`, and the model is resolved once per run anyway. See §1. If the intent is per-step preset models, this PR needs per-step resolution (resolve the step's preset → its model inside the loop, with the merge fixed).

## 5. Regression risk when no preset is set

- **No functional regression**: with `preset?.model` undefined the code path is byte-identical to pre-PR (`state.config.model` → `ctx.model` → error). Full suite passes.
- **One silent behavior change — auto-route × preset model.** In single mode, when neither `preset` nor `template` is given, `autoRoutePreset` (E2, pre-existing) keyword-matches a preset ("review"→code-reviewer, "fix"→debugger, "test"→test-engineer…). With this PR, if the auto-routed preset ever carries a `model` field, the subagent **silently switches models even though the user never chose a preset** — this is not the documented fallback, it's an override. Currently no built-in preset has `model:` (verified by grepping `presets/`), so it's latent, but the interaction should be decided and documented (e.g., only honor `model` for *explicitly chosen* presets, or accept the behavior intentionally).
- Templates bypass presets entirely (auto-route skipped when `template` set) — unaffected.

## 6. Is `model` in frontmatter parsed correctly?

- The frontmatter parser (`parseFrontmatter`, presets.ts) is **hand-rolled regex, not real YAML** (`^(\w+):\s*(.*)$`). Plain `model: anthropic/claude-opus-4-6` parses correctly; surrounding quotes are naively stripped; booleans/numbers arrive as strings, so no type crash.
- **Round-trip hole in `buildFrontmatter`**: `model: ${preset.model}` is written **unquoted** (same pre-existing pattern as `thinkingLevel`). A model containing `: ` (e.g. a tag-style id) would fail to re-parse (`\w+` key match stops at the first `:`), silently dropping the field on the next reload. Acceptable for today's `provider/id` ids, but one more reason to quote or use a real YAML lib.
- `validatePreset` does **not** validate `model` format — invalid values only warn at resolution time. Consistent with test 4's intent ("validated at resolution time"), though note nothing actually *validates* — it just falls back with a `log.warn`, and only when a run happens (a typo'd model in a preset file is invisible until first use; there is no load-time warning).

## 7. Tests — the 6 new tests in `src/__tests__/preset-model.test.ts`

All 6 pass; suite is 555/555.

**What they cover (all in `presets.ts`):**
1. `parseFrontmatter` extracts `model` — meaningful
2. `model` absent → `undefined` — meaningful
3. `loadBuiltinPresets` picks up `model` from a file — meaningful
4. invalid string (`no-slash-here`) preserved literally at load — meaningful, but the name ("validated at resolution time") is misleading: nothing validates at resolution time in this test, it only asserts load-time passthrough
5. `buildPresetMarkdown` includes `model` — meaningful
6. `writePresetFile` → reload round-trip — meaningful

**What they miss (the important parts):**
- **Zero coverage of the PR's core logic** — `resolveSubagentModel` precedence (preset > config > conductor), `parseModelString`, `modelIsAvailable`, and the fallback paths are all private and untested. The single most valuable test would assert: preset model valid → used; preset model not in registry → config model used; preset model invalid format → config model used; no model anywhere → error result.
- No test that the resolved preset model actually reaches `runSubagent` in any mode (the wiring in §1).
- No `loadCustomPresets` coverage (only builtin).
- Fixture typo: `thinking: high` instead of `thinkingLevel: high` in the `loadBuiltinPresets` fixture (harmless — assertion checks only `model` — but sloppy).

**Critical hygiene issue:** `src/__tests__/` is listed in `.gitignore` (line 5), so **every test in the repo — including these 6 — is untracked**. The PR commit `0497a3d` contains only `src/index.ts`, `src/presets.ts`, `src/types.ts`. The "6 new tests" are not part of PR #1 as committed: a fresh clone won't have them, CI can't run them, and reviewers can't see them in the diff. Either commit the tests (removing the ignore or adding a `!` exception) or this review's test findings apply to unreviewable, unshippable code.

---

## Additional observations

- **No UI to set a preset model.** The TUI preset wizard (`showCreatePreset`, tui.ts:755–830) has no model step, and `formatPresetSummary` doesn't show `model`. Users can only set it by hand-editing `.md` files. Consider a model picker step (reusing `showModelSelector`'s `getAvailable()` list) and including the model in the preset summary.
- **Observability is good**: `log.info`/`log.warn` carry `{preset, model}` for both the success and fallback paths; the run record stores the resolved `provider/id` so history/metrics reflect the preset model.
- **Code style nit:** `resolveSubagentParams` returns `resolvedPreset` (an object) while the local `resolvedPreset` is a string — rename one for clarity.
- The plan doc (`PER_PRESET_MODEL.md`) itself notes "ctx.modelRegistry API shape must be verified" — it has now been verified; the shape matches, but the *semantics* (catalog vs. auth) are the issue in §2.

## Priority-ordered fixes

1. Honor (or explicitly document) `background: true` — resolve the model before the background branch and pass it to `spawnBackgroundSession`.
2. Decide per-step presets in chain/parallel/graph: either resolve per-step preset models (move resolution into the step loop + fix `mergeSubTaskParams`) or remove `preset` from the step schemas.
3. Make the fallback auth-aware (`getAvailable()` / `hasConfiguredAuth`) or document that "unavailable" = "not in catalog" and that unauthenticated providers will hard-fail at spawn.
4. Commit the tests (un-ignore `src/__tests__/` or add an exception) and add unit tests for `resolveSubagentModel` precedence/fallback.
5. Decide the auto-route × preset-model interaction in single mode.
