# REVIEW — PR #410 (fix/408-store-permissions) @ `e7a1a86` + conductor fix `062f45c`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — **C1 adversarial security** (project-reviewer preset, high), Jev **high (0.92) · C1**. Issue #408.

Reviewed head: e7a1a86

**Verdict: approve-with-nits** — 4 minors + 1 SOLID/DRY, all resolved (3 fixed in `062f45c`, 1 was the test-scaffold dedupe fixed there too).

## Findings

| Severity | File:line | One-liner | Disposition |
|---|---|---|---|
| minor | README:17, CHANGELOG:7 | "Repaired on every use" overclaims — read paths never repair | fixed: "on every **write**"; read-only paths leave a dormant checkout as-is; file-mode claim narrowed (create-time 0o600; per-run session files best-effort) |
| minor | `src/store-permissions.ts:38-46` | `ensureOwnerOnlyDir` follows symlinks (statSync/chmodSync retarget the link's target) | fixed: `lstatSync` no-follow guard for dirs **and** flat files; two symlink tests; **mutation (drop guards) → 2 red** |
| minor | `session-manager.ts:398`, `transcript.ts:64,94` | Pre-existing agent-record/transcript FILE modes never repaired; the README implied more | fixed by the doc narrowing (dir 0o700 is the boundary; file repair is per-run-session best-effort) |
| minor (SOLID/DRY 1) | `store-permissions.test.ts:26-38,100-112` | The tempDir/created/afterEach scaffold was duplicated across both describes | fixed: one module-level scaffold |

conductor-verified: 062f45c — lstat no-follow guard + 2 symlink falsifiers (mutation 2 red → restored 13/13), the README/CHANGELOG narrowing, the scaffold dedupe; full suite **92 files / 1849**; `tsc` clean; docs:arch no-op; diff-check clean.

## Verified-OK (review)

- Helper semantics probed at runtime: 755→700, 750→700, 700 idempotent, **0o500 NOT loosened**; deep-create yields 700 leaves *and* parents (immune to a 022 umask); never throws on missing-parent, file-as-dir, NUL path, missing repair dir.
- File repair: flat 644→600; subdirs untouched; already-600 unchanged.
- Tests real: drop-repair mutation → 6 red across 5 files; mkdir-throws mutation → 2 red; restored green.
- Coverage complete: `persistAgent`→ensureStorageDir; spawn→ensureSessionsRoot pre-SDK + leaf/files post-SDK; retained settle→leaf/files; registry writeAtomic→ensureDir; startTranscript→ensureOutputDir; pruned settles delete (nothing to repair).
- Docs: README sentence, CHANGELOG, ARCHITECTURE map (44 modules), docs:arch no-op.
- No collateral: suite 92/1847 at review (1849 after the pins); `tsc`; diff-check; the log dir untouched deliberately; retention/sweep untouched.
- **Live repair done by the conductor**: the four store dirs on this machine were chmod'ed 700 immediately (same owner; no code path depends on group/other access) — the fix's lazy repair would have done it on the next write, but the exposure was live.

## Disposition

Merged after `merge-guard.sh`. #408 closed.
