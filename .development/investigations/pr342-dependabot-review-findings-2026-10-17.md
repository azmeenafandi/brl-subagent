# REVIEW — PR #342 (dependabot `other` group, corrected) @ `b157728`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2 review (2026-10-17).
Checkout: `review/342` at `b157728`. PR body carries the "Maintainer correction" section.

**Verdict: approve**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | task brief (not repo) | "16 @rolldown/binding-*" overcounts — 15 bindings + rolldown = 16× v1.2.13 lines; no code impact |

## Verified-OK

- **Diff scope:** only `package-lock.json` + `.github/dependabot.yml`; `package.json` byte-identical to `dev`.
- **Lockfile reconciliation:** every hunk in the expected set (vitest/mocker/spy 5.0.4, tinyexec 1.3.1, rolldown
  1.2.13 + 15 bindings, vite 8.3.4, postcss 8.5.30, chai 6.3.0, tinybench 6.2.2, std-env 4.3.0, obug 3.0.0,
  oxc/types 0.153.0); spec-only lines all parent-manifest-driven; **zero extras/missing** (230 ± lines accounted).
- **typebox net-zero:** 0 diff lines; 1.3.27 on both sides; direct devDep pin + deduped under all four pi packages.
- **Dev-only:** all 12 entries `dev:true`; reverse-deps terminate at vitest (devDependency); `obug` 3.x sole
  consumer is vitest — debug utility, benign; production tree unchanged (`npm ls --omit=dev` empty).
- `npm ci --dry-run` clean; `npm ls` → vitest 5.0.4 / typebox 1.3.27.
- **dependabot.yml:** typebox removed from `other`; no `ignore`; `pi-sdk` untouched; config check PASS.
- Full suite **74 files / 1509 tests**; `tsc --noEmit` clean; CI: config + test **PASS**.

SOLID/DRY violations flagged: 0

**Coverage:** `git diff --stat` (2 files, 115+/116−) · version-line counts (16×1.2.13, 3×5.0.4, singles) ·
`grep -ci typebox` = 0 · lockfile python audits (dev flags, reverse-deps, binding counts 15/15) ·
`npm ci --dry-run` exit 0 · `npm ls` exit 0 · `npm ls --omit=dev` exit 0 · vitest 74/1509 · tsc exit 0 ·
`gh pr checks` 2× pass. Findings banked to `/tmp/review-342-findings.md`.

## Disposition

- **Minor finding (brief overcount): ACCEPTED — no action.** It describes the dispatch brief's wording, not the
  repository; the lockfile reconciliation itself is fully verified (15 bindings + rolldown = the 16 v1.2.13 lines).
