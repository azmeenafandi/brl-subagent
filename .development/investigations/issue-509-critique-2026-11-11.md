# Issue #509 — plan critique record (two rounds)

Two plan critiques of the scratch-hygiene unit, both on the plan **before** any code existed. Both returned `rethink`; the second round judged a revised plan, and its findings are the ones that bind the implementation units.

- **Audited HEAD (both rounds):** `6b270d2000d15d26b724b9fbb69e91e29980bbb2`, clean tree, no repository files modified.
- **Critic:** `project-plan-critic` preset, `openrouter/openai/gpt-6.1-terra`, thinking level `medium` (the standing pin), read-only.
- **Jev lines:** round 1 `jev: high (0.47) · C1 · worktree n` (label `critique-509`); round 2 `jev: high (0.8) · C1 · worktree n` (label `critique-509-b`). Both settled `done` in `.pi/jev-outcomes.log`.
- **Cost:** round 1 $0.132 / 2m10s; round 2 $0.092 / 1m35s.
- **Why this file exists:** the full outputs live in `.pi/output/agent-*.jsonl`, which is **gitignored** — the same class of loss #509 exists to fix. This is the durable record; the transcripts are the working copy.

## What the rounds changed

| round | verdict | what it killed |
|---|---|---|
| 1 | rethink | the spawn-time environment override (background reviewers are in-process sessions, never reached); the check-then-write helper; tracked-template assumptions; per-run record identity |
| 2 | rethink | the "every parent owned by the current uid" rule; the assumption that tracked `templates/`+`presets/` are tooling (they ship: 9+9 in the npm tarball); leaf-only symlink defence; unscoped report provenance |

## Round 1 — `rethink`

### Blockers

| plan location | gap | evidence | fix |
|---|---|---|---|
| Decision A | the spawn override does not reach background reviewers — they run as an in-process SDK session, not the child spawned in `runner.ts`; widening the allowlist would not establish per-run values there either | both execution paths located; `src/session-manager.ts:1481–1492` creates the SDK session | resolve a validated absolute path and name it in the dispatch; defer injection to #511. Falsifier: a background reviewer cannot receive the promised per-run override |
| Decision C — tooling-only window | new instructions bank under the new root, but the installed extension's retry still names `/tmp/brl-<label>-bank.md`; a retry can miss the bank and redo work | `rg -n '/tmp/brl-' src/terminal-notifier.ts src/__tests__/transport-auto-retry.test.ts` | tooling-only is coherent only with an explicit interim recovery procedure; do not claim automatic retry is fixed at merge |
| Decision C — helper and writer | a helper that checks a path and then writes with `writeFileSync`/`>` is not a symlink defence — the target can change between check and open | probe: absent-path check → planted symlink → `writeFileSync` overwrote the target; `O_EXCL\|O_NOFOLLOW` rejected with `EEXIST`, target unchanged; `scripts/review-record.mjs:338` uses plain `writeFileSync` | define the boundary at the actual open: private owned directory, unsafe ancestry rejected, exclusive/no-follow creation; test planted leaf, ancestor replacement, concurrent writers; same treatment for explicit `--out` |

### Majors

| plan location | gap | evidence |
|---|---|---|
| Decision C — record default | a new per-run directory can silently bypass the existing same-PR prior-head refusal and supersede chain; blanket refusal breaks idempotent reruns | `review-record.mjs:306–338`; `scripts/__tests__/review-record.test.ts:150–244` pins reruns, head mismatch, `--new-head` |
| Decision B — root and retention | `~/.cache` is not a retention promise; a fixed-age sweep can erase a record whose verification line is still relied on | the existing 24h cleanup applies to a different, worktree-local directory (`src/runner.ts:403–430`); no reboot exercised |
| Decision B — portability | POSIX `0700` + uid checks do not establish Windows ACL safety; `HOME` unset is not "no home" | `env -u HOME node -e 'console.log(require("os").homedir())'` → `/home/azmeen` on the audited Linux host |
| Decision C — report scanners | per-run nested reports are not found by a direct-directory scanner; and a hollow report was selected as proof | probe: `findNewestReport(root)` → `null` for `root/run/suite.json`; a report with `numPassedTests:9999` and one empty result was accepted as 1 file / 9999 tests |
| Decision C — shippable instructions | several named agent-facing templates/presets are ignored local files, so edits there cannot enforce anything elsewhere | `git check-ignore -v` reports `.gitignore:11`; tracked surfaces are `.pi/skills/worktree/` and top-level `templates/`/`presets/` |
| Decision C — classification and split | the tooling half alone changes filesystem security and persistence → C1; the split does not waive adversarial review | `.pi/skills/worktree/SKILL.md:432–433`; the symlink probe above |
| Decision C — legacy artifacts | existing records/banks cannot be made durable by changing defaults; relocating a record changes the path printed in its verification line | a real record at `/tmp/.../REVIEW_509.md` verified; after deletion `--verify` returned exit 2 |

### Minor

| gap | evidence |
|---|---|
| the allowlist has **16** keys, not 17; the 34 tmpdir files are **31 tests + 3 fixtures**; the literal grep needs a defined corpus (tracked instructions, not generated transcripts) | key extraction printed 16; `rg -l` found 31 `*.test.ts` + 3 fixtures; `git grep -l '/tmp/' -- .pi scripts ':!scripts/__tests__'` found four tracked files |

### Verified sound

- Allowlist strips an inherited `BRL_SCRATCH` but accepts an override (`jiti` probe: `inherited: undefined override: /derived`); depth is both allowlisted and overridden.
- `review-record.mjs` defaults to the system temp dir; both evidence tools use `findNewestReport`; explicit old-path verification works while the artifact exists.
- A bash-only reviewer can write a record (stdin contract pinned in `scripts/__tests__/review-record.test.ts`).
- `npm pack --dry-run --json` reported zero `scripts/` and `.pi/` files — the helper and skills are not npm surfaces.

## Round 2 — `rethink` (revised plan)

### Blockers

| plan location | gap | evidence | fix |
|---|---|---|---|
| D2 | requiring **every** parent to be owned by the current uid rejects ordinary Linux paths | uid 1000; `/` and `/home` are owned by `0` | define trusted root-owned ancestors (not group/other-writable) separately from the user-owned private boundary. Falsifier: rejects a normal home path, or accepts a writable untrusted ancestor |
| Scope, D6 | planned tracked `templates/`/`presets/` edits contradict the "no shipped surface" non-goal | `npm pack --dry-run --json` lists **9 presets and 9 templates**; `package.json` includes both in `files` (conductor re-confirmed: 9/9) | resolve the scope conflict; shipped text belongs to #511. Falsifier: a claimed tooling-only change alters the packed files |

### Majors

| plan location | gap | evidence | fix |
|---|---|---|---|
| D5, sequencing | no producer for report provenance — Vitest JSON carries no commit/tree, so requiring it breaks the gates | a `vitest run --reporter=json` produced no `head`/`commit`/`tree` key; both gates are invoked without `--report` | specify how production binds the actual tested tree (incl. dirty tree), and update both gates and their callers |
| D5 | provenance/hollow rules stated for scanning but not for explicit `--report`; presence alone doesn't prove tree match | `pr-evidence`/`handoff-verify` call `readSuiteReport` directly; a provenance-free fixture was accepted via that path | same validation and tree-match rule for both paths; pin explicit hollow, missing-provenance, mismatched-provenance |
| D3–D4 | exclusive creation does not serialize concurrent `--new-head` replacement; same-head idempotence also needs a defined existing-file path | probe: two writers read prior `A`, both replaced → final `C supersedes A`, `B` lost | serialize the whole read–check–replace; define crash recovery and idempotent retry. Falsifier: concurrent different-head updates lose a head or bypass refusal |
| D4 | `O_NOFOLLOW` protects the leaf, not ancestors | probe: `open("link/record", O_CREAT\|O_EXCL\|O_NOFOLLOW)` with `link` a symlink created the file in the alternate directory | descriptor-relative traversal **or** a trusted-ancestor rule that makes the swap impossible; refuse before effects |
| D4, D6 | the exclusive-write rule does not cover the **appended** findings bank — a shell append follows a planted leaf, and exclusive creation cannot append | `review-dispatch.md` and the local `plan-critique.md` instruct reviewers to append as they go | a safe create-and-append procedure usable by a bash-only reviewer, including retry and concurrent access. Falsifier: a planted leaf changes its target, or a second legitimate append fails |
| D6–D7 | a clean tracked scan does not establish what an agent actually receives: ignored project-local templates override built-ins, and `focused-review`/`adversarial-review`/`project-reviewer` have **no tracked counterpart** | `git check-ignore` `.gitignore:11`; live `/tmp` bank instructions found in the ignored dirs; `src/templates.ts`/`src/presets.ts` give project-local precedence; `git ls-files templates presets` has none of the three | tracked source + executable migration/dispatch check, or fail when stale overrides are loaded |

### Minor
`.pi/skills/pr/SKILL.md` is a tracked caller of the report-dependent gate and was missing from the edit surfaces.

### Verified sound
In-process SDK session vs foreground spawn seam confirmed in source; `terminal-notifier` replays the recorded original task and `transport-auto-retry.test.ts` asserts byte-identical replay; `review-record.test.ts` covers reruns and sequential `--new-head` but not concurrency; measured scripts ratio ≈ `0.639`; the floor check applies to top-level `scripts/*.mjs` only.

### Open question, answered
*What instruction tells a replayed agent to read the named bank, given the conflicting shipped preamble?* The original task is replayed **byte-identically**, so the bank path must be in the **original dispatch**. That is implementable now and testable in the retry test — no dependency on #511.

## Decisions these rounds settle

1. **Path delivery:** conductor-resolved, named in the dispatch. No environment variable this cycle.
2. **Ownership:** two zones — root-owned ancestors that must not be group/other-writable, and a user-owned `0700` boundary below the root. An ancestor swap is impossible below that boundary, which is what makes leaf-only `O_NOFOLLOW` sufficient rather than incomplete.
3. **Write boundary:** the open, not the check — exclusive creation, no-follow append, serialized read–check–replace.
4. **Identity:** keyed to the pull request, so the prior-head refusal and supersede chain survive relocation.
5. **Reports:** explicit path preferred; structural validation and tree-match required on both paths.
6. **Instructions:** only non-shipped tracked surfaces, plus an audit of the ignored overrides; shipped text is #511.
7. **Retention:** manual, previewable, never automatic.
8. **Classification:** C1 — full adversarial review of the implementation, regardless of the tooling-only split.

## Deferred to other issues

- **#511** — the shipped half: `src/terminal-notifier.ts` bank path (and its four pinned assertions), the in-process-capable path mechanism, the `os.tmpdir()` preflight, macOS/Windows roots, and the **9+9 shipped templates/presets**.
- **#512** — governance: the review presets/templates are unversioned local overrides with no tracked counterpart, so review instructions live outside version control.
