# PR #323 review findings (#318 crash-notice dedupe — behavior-preservation refactor)
# reviewer: openrouter/~openai/gpt-luna-latest — run 036a2d60, 2026-10-10, 1m48s, $0.0114 (medium thinking)
# worktree: brl-subagent-wt-318-review @ a9bc251 (detached)

CHANGES-REQUESTED

| Focus | Severity | Command | Observed result |
|---|---|---|---|
| 1. Behavior preservation | OK | `git diff origin/dev...HEAD`; literal comparison script | Both content expressions match `origin/dev` character-for-character. Claim remains before send; `customType`, `display`, `details`, and `deliverAs` are unchanged. Only `src/index.ts` changed; `deliverCompletionAlert` and the already-deleted #315 poller notice are untouched. |
| 2. Test strength | Minor | `npx vitest run src/__tests__/terminal-notice-dedupe.test.ts`; review of assertions | Both crash paths and exactly-one behavior are covered. Content is only partially pinned: the exception path checks `contains("crashed:")` and `contains("extract blew up")`, not exact sanitized content. |
| 3. Mutations | Minor | Isolated `/tmp` mutation runs | Removing the sanitizer passed all 8 tests; the sanitizer regression is missed. Moving the claim after an unconditional send failed both event/crash race tests at `captured.toHaveLength(1)` (lines 387 and 416). |
| 4. Closure correctness | OK | Source scope inspection | `sendCrashNotice` is local to `startBackgroundAgent`, captures that invocation’s `agent` and `pi`, and both call sites are in scope. No shared mutable capture. |
| 5. Gate A | OK | `npx tsc --noEmit`; full `npx vitest run`; `node scripts/docs-arch.mjs`; README guard | Typecheck clean; 67 files / 1365 tests passed; docs architecture current (39 modules); README guard passed. |

**Findings**

| Severity | File:line | One-liner |
|---|---|---|
| Minor | `src/__tests__/terminal-notice-dedupe.test.ts:356-357` | The exception-content assertions pass when `sanitizeErrorMessage` is removed; pin the sanitized result so this required mutation is caught. |

**Verified OK**
- `git diff --check` is clean; no test file or assertions were changed by the PR.
- Worktree remains clean; mutations ran in isolated `/tmp` copies and those copies were removed.
- Environment check: installed and locked `@earendil-works/pi-coding-agent` are both 1.1.0.

**Gate A note:** Typecheck, full suite, docs-arch, README guard, and diff checks all passed.

**SOLID/DRY violations flagged: 0**
