# pi 1.6.0 render compatibility — PR plan (HELD)

**Status:** saved 2026-11-20; **do not start until the `timeout-guidance` cycle closes**.
**Scope:** a small TUI compatibility PR for pi-tui 1.6.0; no behaviour change, no timeout-guidance content.
**Proposed branch:** `fix/pi-1.6.0-render-compat`
**Proposed risk class:** C1 (TUI-only; no registered surface, no pre-flight/prompt change; the reviewer may raise it if the devDeps bump changes public types).

## Why

pi 1.6.0's only Breaking Change is the render contract (#9549):

- pi-tui 1.5.2: `Component.render(width): string[]`; `Container.render(width): string[]`; `Text.render(width): string[]`.
- pi-tui 1.6.0: `Component.render(width): readonly string[]`; `Container.render(width): readonly string[]`; `Text.render(width): readonly string[]`.
- `Container` now returns the **same cached array** while its children are unchanged; callers must not modify it. The `ChildLines` docs now say the returned lines are read-only.

The project's `devDependencies` are pinned to 1.5.2 (`package-lock.json`), but the running install is the local dev checkout loaded by **pi 1.6.0**. The extension's tests/typecheck therefore do not see the 1.6.0 types until the devDeps move.

## The three sites (as of 2026-11-20; line numbers may drift — locate by function/string)

| # | Site | Current code | Fix |
|---|---|---|---|
| 1 | `src/tui.ts` `showAgentDetail` overlay (`:1951-1956`) | `const lines = buildView().render(w); ... for (let i = lines.length; i < rows; i++) lines.push(" ".repeat(w));` | `const lines = [...buildView().render(w)];` |
| 2 | `src/tui.ts` `showRunDetail` → `wrapOutput` (`:1375`) | `wrappedLines = new Text(theme.fg("toolOutput", outputText), 1, 0).render(width);` | `wrappedLines = [...new Text(theme.fg("toolOutput", outputText), 1, 0).render(width)];` |
| 3 | `src/tui.ts` `withDiffKeybinding` (`:2960`; returns `:2976`/`:2978`) | return type `{ render(w: number): string[]; ... }`; `return dc.render(width);` / `return container.render(width);` | `return [...dc.render(width)];` / `return [...container.render(width)];` |

Site 1 is the only **in-place mutation** of a `Container`'s render output — the exact pattern the changelog prohibits. In the current code the container is freshly built per render, so the visible output happens to be correct on 1.6.0; the copy removes the contract violation and the `readonly` type error. Sites 2 and 3 are type-level only (the arrays are not mutated), but they fail the 1.6.0 typecheck.

## Why copies, not `readonly` annotations

A `readonly string[]` return annotation on the wrapper would be **not assignable** to the 1.5.2 `Component.render(): string[]`; the extension would then need the devDeps bump to compile. A spread (`[...render]`) produces a mutable `string[]`, which is valid on **both** 1.5.2 and 1.6.0 — the copies are the cross-version fix, and they are what the 1.6.0 contract requires. Do not "fix" this by changing the return types to `readonly` alone.

The other render call sites return directly or `.slice()`; a scan of `src/tui.ts` found no other array mutation after a `render()` call (`showLinesModal`, `showRunDetail`'s viewport, the dashboard components, the approval views, `renderDelegate*`).

## Scope

1. The three copies above (the required part).
2. **Optional but recommended in the same PR:** bump the four `@earendil-works/pi-*` devDependencies to `^1.6.0` and update `package-lock.json`, so `npm run typecheck` is a standing 1.6.0 guard. Run the typecheck and suite; fix only what the 1.6.0 typecheck reports (possible additional sites: `ToolDefinition`/`renderCall`/`renderResult` typing in `agent-tools.ts` / `delegate-handler.ts`, or test-side `readonly` assignments). The render copies themselves are the minimum deliverable if the bump surfaces unrelated type churn; split the bump into a follow-up if needed.
3. Do **not** touch `typebox`: pi 1.6.0 still pins `typebox@1.3.27` (verified in its `package.json`), the same as our dev pin. **PR #536 (1.4.6) stays held**; the "re-evaluate when pi's pin moves" trigger has not fired.
4. No `find`, `pi.exec`, MCP/`toolActivation`, `session_start`/reload, or model-default changes: those 1.6.0 items do not affect this code (recon 2026-11-20). The OpenAI non-strict tool-schema fix is in our favour (`delegate_task` has `Type.Union` roots); no action.

## Verification

**On the current 1.5.2 lock:**
- `npm run typecheck` green (the copies keep it green).
- `npx vitest run` green; the `tui-render-goldens` and `tui-lines-modal-goldens` snapshots unchanged.

**With the 1.6.0 devDeps (if included):**
- `npm ci` / `npm install`; `npm run typecheck` green; `npx vitest run` green; the golden snapshots unchanged.
- The 1.6.0 typecheck must not produce the three original errors; any additional errors are fixed only if they are mechanical and in scope (list them in the PR if deferred).

**Runtime probe on the running pi 1.6.0 install** (the local dev checkout):
- Open the agent-detail drill-in (`showAgentDetail`) and verify the full-height padding is unchanged; resize and re-render.
- Open the approval dialog's full-diff view and the run-detail output view (`withDiffKeybinding`, `showRunDetail`) — no visual change.
- Confirm no `readonly`/cache-related errors in the pi log/console.

**No new test is strictly required:** the bug is 1.6.0-cache-specific and cannot be reproduced against 1.5.2; the 1.6.0 typecheck is the regression guard. A small unit test that a freshly built view's returned lines are not mutated would only assert the 1.5.2 behaviour; optional.

## PR shape

- Worktree via the standard `worktree-prep.sh` flow (do not `npm install` in the cockpit; use `--force-isolated` if the dependency bump is included).
- One commit for the three copies; a second for the devDeps + lockfile if included (or one commit if the review prefers).
- PR body: the changelog/#9549 evidence, the 1.6.0 vs 1.5.2 `.d.ts` evidence, the three sites, the copy rationale, the verification above, the C1 proposal, and "typebox #536 not touched."
- Jev line from `jev-check`; the record's `recheck-<pr>` and `Risk class:` as usual; merge commit, no squash.

## Not in this PR

- The `timeout-guidance` unit (#426 E) and its spec — unaffected; it does not touch `src/tui.ts`.
- The GPT-6.2 `off`/`minimal` note (new `openai`/`azure`/`openai-codex` defaults) — a separate docs/guard decision; the project's presets do not use GPT-6.2.
- The typebox 1.4.6 bump (#536).
- Any release/version decision; the next release includes this fix when the maintainer cuts it (#539 is also still outside the published tarball).

## Schedule

After the current `timeout-guidance` cycle closes. This plan is the first follow-up; the timeout spec is the active unit.
