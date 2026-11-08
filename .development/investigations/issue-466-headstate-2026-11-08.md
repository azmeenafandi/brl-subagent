# #466 investigation — a durable `headState` per repository, and what the boot does about it

**Kind:** decision dossier. No implementation, no repository change except this file (`src/` untouched; every
mutation below happens in `/tmp/brl466/**` and in a copy of `src/` under `/tmp/brl466/src`).
**Base:** `dev` @ `65a926a` (`git rev-parse --short HEAD`), clean tree, `git branch --show-current` → `dev`.
**#453 is merged on this base** (`armDeadline` writes a terminal run-record snapshot at the deadline,
`session-manager.ts:2111`), **#465 is not** (`grep -n "gitLockOwners\|isStuckTerminalOwner" src/session-manager.ts`
→ no output), and its worktree `/…/brl-subagent-465` is at the same base with an empty diff — so everything below
is "today, without #465".
**Method.** Probes are real: the real `src/run-registry.ts`, `src/recovery.ts`, `src/git.ts`, and the real
`spawnBackgroundSession` driven with a stubbed `createAgentSession` over a **real git repo** (the two-process
harness of `src/__tests__/background-session-persistence.test.ts`, reused). Measured = produced by one of the
runs in Appendix A; read = code-inspected with `file:line`; inferred = a conclusion from measured facts that was
not itself observed; unverified = named in §11 with the command that would settle it.

Scratch trees (all kept):

```
/tmp/brl466/src            copy of the checkout's src/ (diff -r → COPY-IDENTICAL)
/tmp/brl466/probes/        p1, p2a, p2b, p4, p11  (vitest, repo's own runner via a symlinked node_modules)
/tmp/brl466/repro/         the two-process restart reproduction (repo, subagents, registry, output, project)
/tmp/brl466/p3-*, p5-*, p6-*, p7-*, p8-*, p10-*   the git/process probes (plain git CLI)
```

---

**Bottom line.** Persist one atomic JSON per repository — `{version, repoRoot, runId, kind,
base: {branch, sha, detached}, workBranch, owner, createdAt}` — at `.pi/head-state/<sha256(repoRoot)[0:16]>.json`,
written *before* the work branch exists and cleared only when the tree is verified off it. At boot, restore the
recorded base **only** when the owner is provably dead, HEAD is exactly the recorded work branch and the tree is
clean — keeping the work branch, never forcing — and leave every other state alone and name it. Refuse a branch
dispatch while an unresolved record's owner is not alive. That is **O2** (§8); its one admitted hazard is a
detached child that outlives its parent (§8.1 row 1, measured §0 F3).

---

## 0. The four facts that decide this issue

**F1 — the boot scan is structurally blind to the case this issue is about.** A branch run that misses its
deadline is written **terminal** by the deadline (ADR 0023 decision 3), and a terminal record *retires the
registry claim* (`persistRunRecord`: `if (run.status !== "running") clearInflightRun(run.id)`,
`run-registry.ts:346-353`). The production scan sources candidates only from that registry
(`listInflightRuns`, `recovery.ts:330`). Measured (P1S2, P2B): after the deadline the registry is **empty**
and the scan reports `{scanned: 0, marked: 0}`; the agent record still sits on disk (`status: "stopped"`) and is
never read. So the stuck run is not merely un-repaired — it is **invisible**.

**F2 — the silent orphan is produced by our own teardown, not only by a wild child.** `cleanupWorkBranch`
commits the agent's work *before* it restores (`commitAll` → `captureDiff` → `restoreHead`,
`session-manager.ts:1680-1720`). A crash inside that window leaves exactly the bad state: **clean tree, HEAD on
the work branch, the work committed there, the diff lost in memory**. Measured (P4) on a 400-file tree: window =
**27 ms** (`commitAll` 24 ms + `captureDiff` 3 ms) and the resulting state is `status: ""`,
`head: brl-subagent-<8>`, `main` still at the base commit.

**F3 — a child of the conductor outlives a SIGKILL of the conductor.** The SDK's bash tool spawns
`detached: true` on POSIX and kills the tree only on abort/timeout/completion
(`pi-coding-agent/dist/core/tools/bash.js:63-71`, `:96-99`). Measured (P3): after the parent SIGKILLs itself the
detached child is **alive** and keeps appending (38 B/s); a subsequent `git checkout main` **succeeds** and the
child's writes then land in the base tree. This is the late-writer hazard, and it is structural, not incidental.

**F4 — "the work branch was deleted out from under us" cannot happen while the tree is on it.** `git branch -D`
on the checked-out branch is refused (`error: cannot delete branch … used by worktree`, measured P5). Only
`git update-ref -d refs/heads/<work>` (or a second worktree) produces it, and then HEAD is **unborn**: every file
reads as added (`status` is non-empty for a reason that is not a dirty tree), yet `git checkout main` **works**
and cleans the tree (measured P11 F4a). So the "deleted branch" row of the policy is a *repair*, not a refusal —
but a naive dirty-tree check must not run before it.

**What the four facts kill.** F1 removes "the boot scan already sees the run; just teach it to restore" — the
candidate source has to change or a new one has to exist. F2 says the orphan that matters is the *clean* one,
and that its work survives only on the branch (so the repair must not delete the branch). F3 bounds what any
automatic repair can promise. F4 removes one refusal row and fixes the order of the checks.

---

## 1. The restart, reproduced end to end (two processes, real spawn, real repo)

**Phase A** — process 1 (`/tmp/brl466/probes/p2a-run.test.ts`): a real `spawnBackgroundSession` with
`gitMode: "branch"`, `cwd: /tmp/brl466/repro/repo`, `timeout: 400`; the stubbed child writes and **commits**
`a-work.txt` on the work branch, then never settles and ignores `abort()` — the deaf shape measured in #460
(M1). Phase A then just ends: no settle path runs. That is the crash.

```
W466P-P2A {"agentId":"f111d77e-7266-422a-ad34-9bfc3faaffb3",
           "head":"brl-subagent-70dad1ac",
           "branches":["brl-subagent-70dad1ac","main"],
           "statusPorcelain":"",
           "workHeadSubject":"e568eff A: committed work",
           "registryEntries":0,
           "agentRecord":{"status":"stopped","error":"Timed out after 400ms",
                          "hasSessionRefField":false,"gitFields":[]},
           "logCarriesBranchAndBase":[
             {"message":"Created work branch for background agent",
              "data":{"branch":"brl-subagent-70dad1ac","base":"main",
                      "agentId":"f111d77e-…"}}]}
```

**Phase B** — a *fresh process* (`p2b-restart.test.ts`) against the same repo and stores: the boot, wired like
`performBootRecovery` (`src/index.ts:4214-4256`, `readAgentRecord: (id) => getAgent(id)`,
`mark: markInterrupted`), then one more dispatch.

```
W466P-P2B {"registryAtBoot":0,
           "scan":{"scanned":0,"marked":0,"skipped":0},
           "agentAtBoot":{"status":"stopped","error":"Timed out after 400ms","hasGitFields":false},
           "agentStoreFiles":1,
           "headBeforeB":"brl-subagent-70dad1ac",
           "bRecordedBase":{"branch":"brl-subagent-32100c54","base":"brl-subagent-70dad1ac",…},
           "bDiffHasOwnWork":true,"bDiffHasOrphanWork":false,"bDiffLines":1,
           "headAfterB":"brl-subagent-70dad1ac",
           "branchesAfterB":["brl-subagent-70dad1ac","main"],
           "bStatus":"completed"}
```

Read it in four steps, each a fact:

1. **The boot says nothing**, and not because it is quiet — it has no candidate (`registryAtBoot: 0`,
   `scanned: 0`) even though the agent record is right there (`agentStoreFiles: 1`).
2. **The tree is still on the orphan** (`headBeforeB`) with a clean status.
3. **The next dispatch records the orphan as its base** (`bRecordedBase.base`) — the code's own log line, not an
   inference.
4. **Nothing is visible in the result**: B's diff has exactly one file, its own; A's committed work is outside
   the `headState.sha` window (`bDiffHasOrphanWork: false`). After B settles the tree is back on the orphan
   (`headAfterB`), because B's `restoreHead` restores *its* captured base — the orphan.

That is the silent rebase the issue describes, now with the boot's silence measured as well.

---

## 2. Where the record can live

The record has to answer one question at boot: *this repository is on `<branch>`; was that a work branch, and
from what?* Candidates, with what the boot already reads:

| Home | Durable across a crash? | Readable by the existing boot? | Verdict |
|---|---|---|---|
| **run record** (`SubagentRun`, session entry + registry mirror) | the session entry survives in the session file; the registry entry does **not** (terminal write clears it) | No: session entries need `restoreFromSession` of *that* session; the registry is empty after a deadline (P1S2) | fails F1 |
| **agent record** (`.pi/subagents/<id>.json`) | yes (`persistAgent` strips only `_sessionRef`/`_sessionFile`, `session-manager.ts:394`) | No as a *candidate source*: only read by id from a registry entry that is gone; and a terminal agent record is dropped even when an entry exists (P1S3: `scanned: 0`) | fails F1 as the index; fine as a payload |
| **a new per-repo sidecar** (`.pi/head-state/<key>.json`) | yes, if written atomically | **yes, by construction** — it is its own candidate source | the only home that satisfies F1 |
| **inside the repo** (`.git/brl-subagent/head-state.json`) | yes, and it travels with the repo (visible from any cwd) | no index of repos to inspect; writing into `.git` is intrusive and worktree-unfriendly | rejected — solves a problem we do not have (the boot enumerates *records*, not repos) |
| **the log file** (`.pi/subagent-logs/brl-subagent.log`) | yes — measured: the line carries `{branch, base, agentId}` verbatim (P2A) | parseable, but rotation (5 MB × 5), the log level, and a cwd-relative path make it a *human* trail, not a contract | rejected as the record, useful as a diagnostic |

**Why a per-repo sidecar is the right cardinality.** `gitBranchLocks` serializes the *whole* branch lifecycle per
repository root (`session-manager.ts:1855-1861`), so at most **one** unresolved branch run exists per repo per
process. One file per repo therefore cannot lose an entry by overwriting — the only writer that could overwrite
is a *second process* in the same repo, and that collision already exists at the git level (measured P8: a
concurrent process switched branches and the first run's writes landed on the second's branch). Several repos in
one session simply means several files, and the payload carries the absolute repo root, so a boot started in
repo A can repair repo B.

**Keying.** `key = sha256(repoRoot).slice(0, 16)`, where `repoRoot` is `getRepoRoot(cwd)`, i.e. git's canonical
`--show-toplevel` — measured to resolve symlinks (P10: `git -C link rev-parse --show-toplevel` →
`/tmp/brl466/p10-symlink/real`; hashing the *cwd* instead would have produced two different keys for one repo).
The payload repeats `repoRoot` verbatim, so a hash collision or a moved repo is detected by comparison, never
assumed.

---

## 3. The record: shape, write point, clear point, crash windows

```ts
// src/headstate.ts (new) — one file per repository, outside the repo
interface HeadStateRecord {
  version: 1;
  repoRoot: string;        // canonical absolute; the identity check at boot
  runId: string;           // the agent id, so the message names the owner
  kind: "background" | "foreground";
  base: HeadState;         // { branch, sha, detached } — verbatim from getHeadState (git.ts:70)
  workBranch: string;      // known BEFORE the branch exists (see below)
  owner: ProcessOwner;     // { pid, start } — the same shape the recovery scan verifies
  createdAt: string;       // ISO
}
```

Path `.pi/head-state/<key>.json`, directory `0o700` via `ensureOwnerOnlyDir` (`store-permissions.ts:42`), file
`0o600`, written with the existing temp-file + `rename` pattern (`run-registry.ts:197-207`). Measured P7: 2,000
renames under a concurrent reader, twice → **43,463 and 77,221 reads, 0 torn in either run**. In this repository `.pi/*` is gitignored by
default (`.gitignore` keeps only `.pi/skills/` and `.pi/extensions/`), so the store cannot leak into a commit
here; in a *user's* repo it inherits the same exposure `.pi/subagents/` and `.pi/run-registry/` already have —
flagged, not solved (pre-existing).

**Write point (WAL, before the mutation).** Today the work-branch name does not exist until
`createWorkBranch` returns it (`git.ts:113` generates it inside), so a record written *before* the checkout could
not name the branch it is about. Recommendation: move the name generation to the caller —

```diff
- const branch = "brl-subagent-" + crypto.randomUUID().slice(0, 8);
- execFileSync("git", ["checkout", "-b", branch, baseBranch], gitOpts(cwd));
+ export function newWorkBranchName(): string { return "brl-subagent-" + crypto.randomUUID().slice(0, 8); }
+ export function createWorkBranch(cwd, baseBranch, branch = newWorkBranchName()) { … }
```

— which lets the background site read, in order: `headState = getHeadState(gitCwd)` → `workBranch =
newWorkBranchName()` → `writeHeadState({…})` → `createWorkBranch(gitCwd, headState.sha, workBranch)`. If the
checkout throws, the record is cleared (nothing was created). Two call sites exist
(`session-manager.ts:1880`, `index.ts:3397`); the foreground one is a scope decision (§11, question 1).

**Clear point.** Only where the tree is *verified off* the work branch, inside `cleanupWorkBranch`:
`restoreHead` ok → clear; `stillOnOurBranch === false` (someone moved the tree by hand) → clear;
`getCurrentBranch` threw or `restoreHead` failed → **keep** (that is the crash-equivalent state, and it is what
makes the boot's retry meaningful). One helper, three call sites in a 60-line function — not a new code path.

**Crash windows, and what the boot sees in each.**

| Crash between | On disk after the crash | Boot verdict |
|---|---|---|
| record ⇢ `createWorkBranch` | record names a branch that does not exist; HEAD is still the base | `already-off` → clear (nothing to repair) — measured: `git rev-parse --verify --quiet refs/heads/<b>` → empty, exit 1 (P5) |
| `createWorkBranch` ⇢ the run's work | record + branch + HEAD on it, clean tree | `restore` (work branch kept) |
| `commitAll` ⇢ `restoreHead` (the 27 ms window, F2) | record + clean tree on the work branch, work committed there | `restore`, work survives on the branch (P4R measured: `workSurvivesOnItsBranch: true`) |
| the child writing, mid-run, before any commit | dirty tree on the work branch | `needs-manual` (P11 F2) |
| after `restoreHead` ⇢ clear | HEAD on the base, record stale | `already-off` → clear (idempotent) |

No window leaves the record claiming something the boot would act on wrongly, because every verdict reads the
**live** git state and the record only supplies the *base*.

---

## 4. Boot policy — the options, and the six hazards

The decision table the options share (executed against real git state, P11; verdict names are the probe's):

| # | condition (in this order) | verdict | git side effect |
|---|---|---|---|
| 1 | record unreadable / no `version` | `skip-record` | none (keep, warn once) |
| 2 | `repoRoot` gone or not a repo | `skip-missing` | none (keep) |
| 3 | owner not **provably dead** (`classifyOwner`) | `skip-owner` | none (keep) |
| 4 | HEAD's branch ≠ recorded `workBranch` | `already-off` | none (clear) |
| 5 | recorded work branch ref missing (unborn HEAD) | `no-branch` | `restoreHead(base)`; on failure `needs-manual` |
| 6 | tree dirty | `needs-manual` | none (keep, warn) |
| 7 | otherwise | `restore` | `restoreHead(base)` → clear; **branch kept** |

`W466P-P11` (verbatim, all seven rows): `F1 restore, head main, branchKept true, workStillThere true` ·
`F2 needs-manual, head brl-subagent-f2dirty, workStillExists true` · `F3 already-off` · `F4a no-branch, restored
to base, statusReadsDirtyBefore true, cleanAfter true` · `F4b no-branch, restored` · `F5 skip-owner,
ownerClass alive` · `F6 skip-missing` · `F7 skip-record` · `F8 skip-owner, classify unknown`.

### O0 — do nothing (baseline)

Mechanism: today. Measured end to end in §1/`W466P-P2B`: the boot reports nothing, the tree stays on the orphan,
the next dispatch records the orphan as its base, and the previous run's work is outside the diff window.
Cost 0. **Failure:** the silent wrong base, permanently, for every crash; plus the tree being on a branch the
user did not choose is not only a base problem — any *human* work in that shell lands on the orphan (P8 measures
the mechanism: writes go to whatever branch is checked out).
It stays in the table because it is the only option with no new failure mode.

### O1 — minimal: record the `headState`, and only *say* so at boot

Mechanism: §3's record; at boot every row of the table above is evaluated but **no git command runs** — the
verdict is logged, and the user gets one line naming repo, work branch and base branch, plus the manual commands.
Blast radius: one new store + one new boot step + two call-site insertions; nothing in `git.ts`'s behaviour
changes. Cost: S (~70 source lines, ~120 test lines).
**Failure:** the issue's complaint is only half-addressed. Nothing stops the *next* dispatch from building on the
orphan; the evidence (P2B) says the next dispatch is exactly what silently bakes it in. This is "today, but
visible", which is the option the issue body already calls insufficient ("nothing tells the user" is the symptom,
the silent rebase is the disease).

### O2 — record + guarded boot restore + leave/warn otherwise + a pre-flight refusal (recommended)

Mechanism: §3's record everywhere a work branch is created; at boot the decision table runs (§4) with the three
safety preconditions that make a restore stricter than a blind checkout: **owner provably dead** (row 3),
**HEAD is exactly the recorded work branch** (row 4), and **tree clean** (row 6). Then `restoreHead` — the *same*
function the settled path uses — followed by verification and a clear. Never `checkout -f`, never `restore` onto a
guessed branch, **never delete the work branch**. Every other row leaves the tree alone and keeps the record.

Then the second half: at dispatch, inside the per-repo lock and *before* the dirty check, if a record for this
repo is still unresolved **and its owner is not alive**, refuse the branch dispatch with a message naming the work
branch, the base branch, and the exact commands (§6) — the same message shape #465 uses, one predicate each.
Blast radius: boot gains a git-mutating step (new for this codebase — `performBootRecovery` today only marks
records); the spawn gains a refusal path; a failed refusal must ride the existing terminal cleanup
(`updateAgentStatus` → `finalizeRunEntry` → `completeTranscript` → throw), which is the shape #465 already
specifies. Cost: M (~150 source, ~260 test lines).
**Failure admitted:** the late writer (§4.1 below) — the one thing no record can rule out.

### O3 — record + never touch git: warn at boot, refuse every branch dispatch until a human repairs

Mechanism: identical record, identical table, but rows 5 and 7 do not execute: every non-benign verdict becomes
`needs-manual`, and the pre-flight refuses while the record exists. Clearing happens only when the *human* has
moved the tree (row 4), which the boot observes on the next start.
Blast radius: the smallest of the real options — no git mutation from the boot at all, so the boot cannot be the
cause of any tree change. Cost: S/M (~110 source, ~220 test lines).
**Failure:** the repository is unusable for branch runs until a human runs two commands, and — more importantly —
the tree stays on the orphan while nothing is running, so the user's own edits keep landing there. It also makes
the boot a *pure observer* of a state it could have fixed, which is a strange contract to keep forever; the
manual path is measured to be exactly what the restore does (§6): `git stash` + `git checkout` ≈ `restoreHead`
when clean.

### O4 — the same repair, but performed at the next dispatch instead of at boot

Mechanism: no boot-side git; the pre-flight evaluates the same table, repairs (rows 5/7) under the per-repo lock,
then proceeds.
Blast radius: the spawn's critical section gains git work; the boot stays read-only. Cost: M, roughly O2's.
**Failure:** the tree is wrong for as long as the user does not dispatch, which is precisely when a human is
most likely to edit files by hand (they see a repo that "looks fine"), and the boot cannot report anything about
it. Its one real advantage — the repair happens under the lock, so no in-process run can be mid-flight — is
already true at boot, where nothing is in flight by construction.

### Rejected outright

* **`git checkout -f` / `git reset --hard` at boot.** Measured (P3 case C) a plain `git checkout` already refuses
  when the dirt would be clobbered; `-f` would delete the interrupted run's uncommitted work, which no record
  saves anywhere else.
* **Deleting the work branch after restoring.** The settled path deletes it *because it captured the diff first*
  (`cleanupWorkBranch`). After a crash the diff was never captured (P4: `diffHasWork: true` in memory, lost), so
  the branch is the **only** copy of the work. Measured P4R: restore + keep → `workSurvivesOnItsBranch: true`;
  the settled path's `deleteBranch` after a restore succeeds and would destroy it.
* **Reconstructing the base from the log line or the reflog instead of a record.** Both work for a *human* (§6)
  and both are measured (§5); neither is a contract: the log rotates at 5 MB × 5 and is level-filtered, the
  reflog expires (90 days by default) and records a sha for a detached start. Use both as *fallbacks in the
  message*, not as the record.
* **Teaching the boot scan to see terminal runs** (i.e. keeping the registry entry after the deadline). That
  re-opens #447's `persistRunRecord` invariant (terminal ⇒ cleared) and changes what "inflight" means for every
  existing consumer of `listInflightRuns` (`recovery.ts:330`, the notice collector, abandon). Measured cost
  of the alternative: one 90-line store.

### 4.1 The six hazards, option by option

| Hazard | O0 | O1 | **O2** | O3 | O4 |
|---|---|---|---|---|---|
| **Late writer** (child outlives a SIGKILLed conductor, F3) | irrelevant (nothing moves) | irrelevant (nothing moves) | restore can run under a live writer: stray files land in the base tree — visible in `git status`, recovered with `git checkout -- .`; **commits are never touched** | none (nothing moves) | same as O2, later |
| **Dirty tree** | next dispatch refused loudly already ("working tree has uncommitted changes", #460 P7D) — the *loud* case, and the tree stays dirty | same + named branch | `needs-manual`: leave, keep the record, name the branch and the base; the dispatch refuses with the *better* message | same | same |
| **Deleted branch** (F4) | silent | named | `no-branch` → restore works **and the git-level state is not dirty in the usual sense** (measured `statusReadsDirtyBefore: true`, `cleanAfter: true`) → must be checked *before* the dirty row | `needs-manual` (unnecessary refusal) | same as O2 |
| **Several orphans** from several crashed runs (P5: 4 branches after 3 boots that never ran) | they accumulate silently | named one of them | restores the *recorded* one; older orphans are leaked refs, never checked out → the message lists the count when > 1 (`git branch --list 'brl-subagent-*'` is the query) | named | same as O2 |
| **Several repos** in one session | silent per repo | one line per record | one record per repo root, one verdict each, a vanished repo → `skip-missing`; a boot started in repo A repairs repo B (the payload carries the absolute root) | same | same |
| **Protected branches** (`main`/`dev`) | — | — | restore lands on the *recorded* base only, and only when HEAD is exactly the work branch, so a hand-moved tree is never touched (P11 F3). No deletion, no force. Default-branch discovery is unavailable offline (`git rev-parse --abbrev-ref origin/HEAD` → fatal, measured P5), so protection must stay name-based: the policy never *chooses* a branch, it replays one. | same | same |

Two of these deserve a sentence more than a cell:

**The late writer is the price of O2, and it is bounded.** O2's restore is what the *user* would do by hand from
the refusal message (§6), just earlier and automatically; the exposure is the same command under the same
clean-tree check. What automatic adds is that it can fire while a detached child still writes (P3). The damage is
a stray file or a carried-over modification in the base tree — visible in `git status`, undoable with
`git checkout -- .`, and never a commit (`restoreHead` only runs `git checkout`). Compare with O0's damage:
a *silent* wrong base whose effect is an incomplete diff in a report the user reads as complete. Between a
visible stray file and an invisible missing hunk, the stray file is the better failure.

**"Several orphans" is a leak we choose not to fix.** Each crashed run leaves its branch; the record names only
the latest per repo. Deleting older `brl-subagent-*` branches at boot would delete work whose diff was never
captured anywhere — the one thing §3's record exists to prevent. The boot therefore reports the count and lets a
human decide; a repo that never boots (pi started in another cwd) accumulates them, which is exactly today's
behaviour (P5).

---

## 5. Legacy records — three different "no record" states

| State | How it is recognised | What the boot does | Why |
|---|---|---|---|
| **L1** record present, `version` missing or non-numeric | JSON parses, shape check fails | `skip-record`: keep, **one** warn line naming the path and the work branch if readable; never a git command | The record was not written by this code; its `base` cannot be trusted, and a wrong `base` is the one input that could move a tree somewhere unexpected. Fail-closed by *not acting*, not by refusing the repo. |
| **L2** no record, and the repo's HEAD is on `brl-subagent-<8 hex>` | prefix + shape check at boot for `ctx.cwd`'s repo only; measured P10: `git.ts:113` is the **only** producer of that prefix (`grep -rn "brl-subagent-" --include=*.ts src/ \| grep -v __tests__` → 3 hits: `git.ts:113` plus two unrelated custom-entry type strings in `types.ts`), and boot runs before anything is in flight, so the check has no concurrent-run false positive | warn: name the branch, quote the pre-run branch **when the reflog has it** (`checkout: moving from main to brl-subagent-…`, measured P5), and name the manual commands; **no git command runs** | This is the state every pre-upgrade crash leaves. The base is recoverable in practice (reflog) but it is a *heuristic* — a detached start records a sha, and the reflog expires — so the boot must not act on it. |
| **L3** record present for a repo whose `repoRoot` no longer exists | `getRepoRoot(record.repoRoot)` → `undefined` (the path is gone, so git cannot resolve a top level) | `skip-missing`: keep, count, log at debug; a staleness sweep deletes records older than 30 days | The repo may be temporarily unmounted (a laptop with an external volume); deleting on the first miss is the wrong direction. |

**What L2 must NOT do, and why.** The tempting move is "no record + on a `brl-*` branch ⇒ refuse branch
dispatches". At *boot* that is safe (nothing is in flight), but it is also where a false positive is most
expensive: a user who deliberately keeps an old work branch checked out (e.g. to inspect it) loses the ability to
dispatch branch runs in that repo. Recommendation: **warn at boot, refuse at the pre-flight only when the record
exists** (O2's guard), i.e. the fail-closed path is reserved for a state we can *prove* is unfinished. A repo in
L2 keeps today's behaviour plus a warning that names the exact repair (§6) — a deliberate, stated limit.

**`skip-record` must never crash the boot.** The scan is already best-effort
(`performBootRecovery`'s catch-all, `index.ts:4252-4254`); the head-state step mirrors it: one parse-tolerant
reader (`readFileSync` + `JSON.parse` in a `try`), one `try` around each record's verdict so a single bad repo
cannot abort the rest, and a summary line at the end.

---

## 6. The manual repair path (measured, so the message can name it verbatim)

Dirty orphan (`status: M src.txt, ?? agent-output.txt`, HEAD on `brl-subagent-dead0001`) — measured P6:

```
git stash push -u -m "brl-subagent <id>: interrupted work"   # exit 0; stash lands as "On brl-subagent-dead0001: …"
git checkout <base-branch>                                    # exit 0, tree clean
git stash show --name-only stash@{0}                          # the work is still there
git branch -D brl-subagent-dead0001                           # only after switching off it (git refuses while checked out)
```

Clean orphan with committed work — measured P6/P4R: `git checkout <base-branch>` (exit 0), **keep the branch**
(`git log --oneline brl-subagent-clean001` still shows `run work`), delete it only after inspecting.

For a repo with no record (L2) the base comes from the reflog, measured P5:

```
git reflog --format='%gs' -n 5 | grep 'to brl-subagent-'      # "checkout: moving from main to brl-subagent-aaaa…"
```

The message text for the refusal needs one constraint from #460 §4.2: `sanitizeErrorMessage`
(`src/sanitize.ts:325-343`) neutralises the cwd and its parent and truncates — so the message must name the
**branch**, the **base branch** and the **commands**, not an absolute path.

---

## 7. Interaction with #465 — which message wins, in what order

#465 refuses a *second* branch dispatch **in the same process** while the first run's owner is terminal but
unsettled (its `gitLockOwners` map + `isStuckTerminalOwner`). #466 handles the state that survives the process.
They meet at exactly one place: the per-repo branch lock, before the dirty check. The order there is forced by
which fact is more specific:

1. **owner stuck (live process, may still write)** — #465's refusal. Correct even when a record exists: the
   record's `owner` is alive, so the head-state table's row 3 (`skip-owner`) would decline to act anyway; the
   refusal must fire, because "restart to clear the lock" is the prerequisite for any repair.
2. **record unresolved + owner not alive** — #466's refusal (the boot could not repair: dirty, L1/L2, or a boot
   that never ran).
3. **tree dirty** — today's message (`working tree has uncommitted changes…`, `session-manager.ts:1873-1876`),
   which the record makes more useful by naming the branch and base.

At **boot** there is no interleaving at all: `performBootRecovery` (marks, no git) runs first, then the
head-state reconciliation (git), then `maybeSendRecoveryNotice`. A record whose owner is alive is skipped
(row 3) — that is exactly the case where another *process* still owns the repo, and the boot must not race it.

**Consequence for #465's text.** Its message currently ends "restart pi to clear the lock, then restore the base
branch by hand" (#465 body / #460 §4.2). Once #466 lands, the second half is wrong for the common case: the boot
restores it, and the message should say so, with the manual commands kept for the `needs-manual` case. That is a
one-paragraph edit in #465's message and its test, not a change of design — and it is the only coupling between
the two issues.

---

## 8. Recommendation

**O2 — persist one `HeadStateRecord` per repository, restore the recorded base branch at boot when the owner is
provably dead, HEAD is exactly the recorded work branch and the tree is clean; keep the work branch; leave every
other state alone and name it; and refuse a branch dispatch while an unresolved record's owner is not alive.**

Why this one, in the four reasons the measurements support:

1. **It is the only option that removes the silent base in the case we can actually repair.** The common orphan
   is the clean one (F2 — our own 27 ms teardown window produces it), and in that state the work is safely on the
   branch and the tree is provably clean. O1 leaves it, O3 leaves it, O4 leaves it until someone dispatches.
2. **Its git action is a strict subset of the manual remedy.** `restoreHead` is the same function the settled
   path uses, guarded by three preconditions a human does not have — the recorded owner is dead (row 3), HEAD is
   exactly the recorded work branch (row 4), and the tree is clean (row 6) — so O2 cannot move a tree the human
   path would not move, and it is *stricter* than today's remedy (P6: a plain `git checkout` on a dirty tree
   carried the modification into the base tree; O2 refuses that state instead).
3. **It keeps the work.** The branch is the only copy after a crash (P4: the diff was captured in memory and
   lost). Every option that deletes it is data loss; O2 forbids it explicitly and the mutant table pins it.
4. **It does not depend on the boot scan's candidate source.** F1 measured the scan blind; the record's own
   enumeration is what makes the boot able to see the case at all.

**Cost:** S/M — ~150 source lines (one new module ≈110, two call-site insertions ≈15, boot hook + notice ≈25),
~260 test lines. No change to the spawn's steady-state path beyond one read, one write and one refusal.

**Relationship to #465:** sequential, not exclusive. #466 owns durability + boot; #465 owns the in-process
refusal. Neither depends on the other ships first; §7 fixes the message order and the one text edit.

### 8.1 Stated limits (what O2 does not do)

| # | Limit | Evidence | Consequence |
|---|---|---|---|
| **1** | A detached child of the dead conductor can still write while the boot restores | P3: child alive after the parent's SIGKILL, 38 B/s, and its writes land in the base tree after `git checkout main` | stray files / carried modifications in the base tree; visible in `git status`; `git checkout -- .` recovers; **never a commit**. Not detectable from the record: `childMarker` is foreground-only (`types.ts:847-851`), so the SDK's `findByMarker` has nothing to search for. |
| **2** | On a host without `/proc`, no automatic restore ever fires | P11 F8 (`classify: unknown`), `isProcAvailable` gates the whole production scan (`recovery.ts:465-470`) | The policy degrades to O3 on macOS: warn + refuse, no git action. State it in the CHANGELOG; do not fake a pid-only fallback (pid reuse would make it unsound). |
| **3** | Repairs only when pi is restarted **in the same project directory** | the store is cwd-relative (`.pi/head-state/`), like `.pi/run-registry/` and `.pi/subagents/` | A restart elsewhere sees nothing; the record stays until a boot in that project. The alternative (inside `.git/`) fixes this and breaks enumeration — rejected, not hidden. |
| **4** | Two concurrent pi processes in one repo are not serialized | `gitBranchLocks` is module state (`session-manager.ts:37`); measured P8: the first run's writes landed on the second run's branch | The record is last-writer-wins per repo; the earlier orphan becomes an unrecorded `brl-subagent-*` branch (L2). Pre-existing, not introduced here. |
| **5** | Older orphans are leaked refs | P5: 4 `brl-subagent-*` branches after 3 boots that never ran | Named in the message when the count > 1; never deleted (their diffs were never captured). |
| **6** | Foreground branch runs are only covered if the scope call says so | `index.ts:3397` has the same `createWorkBranch`, and it *warns and proceeds* on a dirty tree | If dropped, "no record" is not a proof of "no orphan" for foreground runs, and L2's warning is the only cover (open question 1). |
| **7** | A repo with a *live* stuck owner stays unusable | §7 row 1 = #465 | O2 does not release, kill, or quarantine anything; that boundary is ADR 0023 decision 2 and stays. |

### 8.2 Falsifiers — what would change this recommendation

1. **A detached child outliving the conductor is common, not rare.** P3 proves it *can* happen; if field runs
   show it routinely (long `bash` commands are common), the restore's pollution risk outweighs the silent-base
   cost → **O3**. *Settling measurement:* in a background branch run, start a 10-minute `bash` command, SIGKILL
   the conductor, then `ps` for the surviving child and check the base tree for files it wrote after a boot.
2. **A product requirement that the boot must never modify the working tree.** That is a policy statement, not
   evidence, and it is sufficient on its own → **O3** (then the manual path in §6 is the only exit). The
   conductor should adopt or reject it explicitly rather than let it emerge from review.
3. **The repair must live inside the existing `/proc`-gated boot scan** (`recovery.ts:465-470`). Then macOS never
   repairs and the record's `owner.start` is dead weight → either the guard moves (§8.1 limit 2 becomes the
   decision) or the design is O3 on non-Linux by construction. This one I would escalate rather than decide.
4. **A durable base is already derivable without a record** — e.g. if every crash path left a `brl-subagent-*`
   branch with exactly one parent that is the base and the reflog always named it. Measured false: the reflog
   records a sha for detached starts and expires; and P5 shows several orphans, which makes "the parent" a guess.
5. **The record's write is too expensive in the spawn's critical section.** Measured cost of the analogous write:
   the registry's atomic write is one `writeFileSync` + one `renameSync`, and 2,000 of them completed with 0 torn
   reads under a concurrent reader, twice (P7: 43,463 and 77,221 reads). If a bench showed a measurable spawn regression, it would be a reason to
   move the write after the checkout (losing the WAL property) — not a reason to drop the record.

---

## 9. ADR sketch — `0026` (ready to write; the decision file itself is the follow-up's job)

```markdown
# 0026. A durable headState per repository: the boot restores the base branch and keeps the interrupted run's work

- **Status:** Proposed
- **Date:** 2026-11-08
- **Issues:** #466, #460, #465
- **Supersedes:** nothing. Qualifies ADR 0023 decision 2: the deadline still owns no git
  resource and releases no lock — a *new* owner (the boot) may restore a branch, and only
  for a record whose owner it has proved dead.

## Context

A branch-mode run creates `brl-subagent-<8hex>` and records the starting HEAD only in a local
variable (`session-manager.ts:1644`, `git.ts:70`). If the run never settles — a deaf prompt
(#460 M1) or a crash — the tree stays on that branch and nothing durable names the base. The
next dispatch then reads the orphan as its base and its diff window starts at the orphan's tip,
so the earlier run's work is outside the report (#460 P7, re-measured two-process here:
`W466P-P2B`).

Two measurements shape the decision. **The boot cannot see the case**: the deadline writes the
run record terminal (`session-manager.ts:2111`), and a terminal record retires the registry
claim (`run-registry.ts:346-353`), so `recoverInflightRuns` gets nothing to classify
(`W466P-P1S2`: `scanned 0` after `entries 1 → 0`). **The clean orphan is ours**: a crash inside
`cleanupWorkBranch`'s 27 ms `commitAll`→`captureDiff` window leaves a clean tree on the work
branch with the work committed there and the diff lost in memory (`W466P-P4`).

## Decision

**D1 — one record per repository, outside the repo, written before the branch exists.** A
`HeadStateRecord` (`{version, repoRoot, runId, kind, base: {branch, sha, detached}, workBranch,
owner, createdAt}`) at `.pi/head-state/<sha256(repoRoot)[0:16]>.json`, `0o700`/`0o600`, atomic
temp+rename. It is written inside the per-repo lock, after the dirty check and **before**
`createWorkBranch`, which is why the branch name moves to the caller (`newWorkBranchName()`).
One record per repo is sufficient because `gitBranchLocks` already serializes the whole branch
lifecycle per repo root.

**D2 — the boot restores, and only under three preconditions.** Row order is fixed: record
parses → `repoRoot` resolves → **owner provably dead** (`classifyOwner`) → HEAD is *exactly*
the recorded work branch → the branch still exists → the tree is clean. Then `restoreHead(base)`,
verify, clear. A deleted-but-checked-out branch (unborn HEAD) is a *repair* row, not a refusal:
`git checkout <base>` works there and `status` reads dirty for the wrong reason.

**D3 — the work branch is never deleted by the boot, and nothing is forced.** After a crash the
branch is the only copy of the work (the diff was never captured). No `checkout -f`, no
`reset --hard`, no `branch -D`, no branch *choice* — the repair replays the recorded base.

**D4 — everything the boot cannot repair is named, and the next branch dispatch refuses.** A
dirty tree, an unreadable record, a vanished repo, a legacy state: leave the tree alone, keep
the record, one warn line. A branch dispatch in a repo whose record is still unresolved and
whose owner is not alive refuses before the dirty check, naming the work branch, the base and
the exact commands. #465's in-process refusal keeps priority: a live owner is a different fact.

**D5 — silence is not a verdict.** Every record ends in exactly one outcome, logged; the repair
and the needs-manual verdict reach the user once, on the existing `nextTurn` channel
(`resolveRecoveryNoticeDelivery`), gated by `config.recovery !== "off"`. The *repair* is never
gated by that config.

## Alternatives rejected

- **Teaching the boot scan to see terminal runs** (keep the registry entry). Re-opens #447's
  terminal⇒cleared invariant for every consumer of `listInflightRuns`; measured alternative: a
  90-line store.
- **Reading the base from the log line or the reflog.** Both exist and both were measured
  (`Created work branch {branch, base}` in `.pi/subagent-logs/brl-subagent.log`;
  `checkout: moving from main to brl-subagent-…` in the reflog). Neither is a contract: rotation
  at 5 MB × 5, level filtering, a sha instead of a branch for detached starts, and a 90-day
  reflog expiry. They become hints in the message, not the record.
- **The agent record as the home.** It is durable and already read at boot, but only *by id from
  a registry entry that no longer exists*, and a terminal agent record is dropped even when the
  entry survives (`W466P-P1S3`). It cannot be the index; it may stay a payload.
- **Inside the repo** (`.git/brl-subagent/…`). Travels with the repo, but nothing enumerates
  repos at boot, and it is worktree-hostile.
- **Deleting the orphan branch after restoring.** The settled path deletes it *because it
  captured the diff first*; after a crash there is no diff, so deletion is data loss.
- **Repairing at the next dispatch only.** Same commands, later, and the tree stays wrong — with
  the user's own edits landing on the orphan — until someone dispatches.
- **Waiting a grace period for the late writer.** A detached child does not die on its own; the
  wait buys nothing and delays the boot.

## Consequences and limits

- **The late-writer hazard is admitted, not solved.** A `bash` child is spawned detached
  (`bash.js:63-71`) and survives a conductor SIGKILL (measured: alive, 38 B/s, writes into the
  restored tree). Background runs carry no `childMarker`, so the existing marker scan cannot
  find it. Damage is bounded to the working tree and is visible in `git status`.
- **Non-`/proc` hosts do not repair.** `classifyOwner` returns `unknown` without a start token,
  so the policy degrades to warn+refuse. No pid-only fallback: pid reuse would make it unsound.
- **Same-project restarts only.** The store is cwd-relative like the other two stores.
- **Two concurrent pi processes in one repo** are not serialized (pre-existing); the record is
  last-writer-wins and the earlier orphan becomes an unrecorded `brl-subagent-*` branch.
- **Older orphans are leaked refs**, reported by count, never deleted.
- **The foreground branch path** is covered only if the follow-up includes it
  (`index.ts:3397`), which it should: the crash exposure is identical.
```

---

## 10. Implementation scope (what the follow-up brief must cover)

**New module — `src/headstate.ts` (~110 lines).** `HeadStateRecord`; `headStatePath(repoRoot)` /
`__setHeadStateDir` (test seam, mirroring `__setRegistryDir`); `writeHeadState(record)` (atomic,
owner-only); `readHeadState(repoRoot)` (parse-tolerant, `null` on absent/corrupt — and a distinct
"corrupt" signal so L1 can warn); `clearHeadState(repoRoot)`; `listHeadStates()` (directory scan,
`.json` only, tolerant); `reconcileHeadStates(deps)` — the §4 table, pure over injected
`{ classifyOwner, getHeadState, restoreHead, hasUncommittedChanges, getRepoRoot }` so the seven
verdicts are unit-testable without git; `buildHeadStateNotice(outcomes)` — one `nextTurn` message
(the same delivery policy as `resolveRecoveryNoticeDelivery`).

**`src/git.ts`.** `newWorkBranchName()`; `createWorkBranch(cwd, baseBranch, branch = newWorkBranchName())`.
No behaviour change; two call sites updated (`session-manager.ts:1880`, `index.ts:3397`).

**`src/session-manager.ts` (the persistence point).** In the `gitMode === 'branch'` block, after
the dirty check (`:1873`) and before the checkout: `headState` → `workBranch` → `writeHeadState`
→ `createWorkBranch`; on a create failure, `clearHeadState`. In `cleanupWorkBranch` (`:1660-1725`):
`clearHeadState` on restore-ok and on `stillOnOurBranch === false`; keep it on a failed restore or
a throwing `getCurrentBranch`. In the same block, before the dirty check and after the lock is
acquired: the unresolved-record refusal, riding `updateAgentStatus` → `finalizeRunEntry` →
`completeTranscript` → `throw` (the #465 shape).

**`src/index.ts` (the boot hook and the foreground site).** Between `await performBootRecovery()`
(`index.ts:4387`) and `await maybeSendRecoveryNotice(ctx)` (`:4391`): `reconcileHeadStates(...)` with
`log`, then the notice. The foreground branch setup (`:3384-3410`) writes and clears the same
record with `kind: "foreground"`; its two teardown sites (`:3426`, `:3665`) clear it.

**Docs.** `CHANGELOG.md` under explicit limits (the four limits of §8.1 rows 1-4, verbatim);
`.development/decisions/0026-*.md` + `npm run docs:decisions`.

**Tests — `src/__tests__/headstate.test.ts` (unit, no git)**: the seven verdicts over injected
deps; parse tolerance (absent / truncated / wrong shape / unknown version); keying (two repos,
one cwd); atomic write (a partial temp file is never the record); staleness sweep.
**`headstate-git.test.ts` (integration, real git)**: the record written by the real spawn names
the branch it created; reconcile restores a clean orphan and **keeps the branch with its commit**;
a dirty orphan is untouched and keeps its record; a hand-moved tree is untouched and cleared; an
unborn HEAD is restored; a record with a live owner is untouched.
**`branch-headstate-refusal.test.ts`**: the refusal message names branch + base + commands, the
refused dispatch ends `failed` exactly once with its session dir pruned, a live owner's record does
not refuse, and a cleared record never refuses.

### 10.1 Mutant table (mutant → the test that must fail)

| # | Mutant | Expected killer |
|---|---|---|
| M1 | no record written at setup | `headstate-git` "the spawn's record names the branch it created" |
| M2 | record written *after* `createWorkBranch` | "the record exists before the checkout" (call-order spy on a throwing `createWorkBranch`) |
| M3 | `clearHeadState` at the top of `cleanupWorkBranch` | "a failed restore keeps the record" |
| M4 | clear after a *failed* `restoreHead` | same test |
| M5 | boot restores without the owner-dead check | "a record whose owner is alive is not touched" (P11 F5) |
| M6 | boot restores a dirty tree | "a dirty orphan is left alone and keeps its record" (P11 F2) |
| M7 | boot acts when HEAD ≠ recorded work branch | "a hand-moved tree is never switched" (P11 F3) |
| M8 | boot deletes the work branch after restoring | "the work branch survives with its commit" (P4R) |
| M9 | a malformed record is treated as actionable | "a record without `version` runs no git command" (P11 F7) |
| M10 | key on `process.cwd()` instead of the repo root | "a dispatch with `cwd` = another repo records that repo" (P11/P10 symlink) |
| M11 | the pre-flight guard is skipped | "a clean orphan with a dead owner refuses the next branch dispatch" |
| M12 | the guard fires for a live owner | "the second dispatch in the same process is not refused by the head-state guard" |
| M13 | the unborn/no-branch row is dropped (dirty check first) | "a deleted branch is restored, not refused" (P11 F4a) |
| M14 | `restoreHead` result ignored | "a failed restore keeps the record and reports `restore-failed`" |

### 10.2 Gates, and what not to do

Gates: `npm run typecheck`; `node scripts/docs-arch.mjs`; `node scripts/docs-decisions.mjs` (the ADR);
`vitest run src/__tests__/{session-manager,background-session-persistence,background-fan-out,git-real,run-registry,recovery-boot-notice,headstate,headstate-git,branch-headstate-refusal}.test.ts`;
`git diff --check`; the test-budget JSON report.

Do **not**: release the branch lock at boot (contradicts ADR 0023 D2 and measured broken, #460 §2a);
touch `spawnQueue`, `stopAgent`, or the deadline; delete a work branch; `checkout -f`; amend ADR 0023
(append via 0026); add a second timer.

---

## 11. Open questions I could not settle

1. **Is the foreground branch path in scope?** Measured: it creates the same work branch
   (`index.ts:3397`) with the same crash exposure, but it *warns and proceeds* on a dirty tree
   (`index.ts:3391-3393`) where background refuses. Including it costs ~10 source lines and makes
   "no record" mean "no orphan"; excluding it leaves L2's warning as the only cover for foreground
   crashes. I recommend including it; it is a scope call, not an evidence call.
2. **Is a cwd-relative store acceptable** given §8.1 limit 3 (a restart in another directory does
   not repair)? The alternative (inside `.git/`) breaks enumeration, so it is a two-store design.
   I recommend accepting the limit and stating it.
3. **Staleness sweep: 30 days, or never?** `cleanupTempDirs` (`runner.ts:412`) is the precedent for a
   boot-time age-based sweep; a record for a deleted repo is otherwise immortal. 30 days is a
   placeholder, not a measurement.
4. **Should the boot notice be gated on `config.recovery === "off"`?** I say yes for the notice and no
   for the repair — but "recovery" is about runs, and a tree repair is not a recovery offer. One knob
   for boot chatter vs two is a product call.
5. **Should L2 (no record, on a `brl-subagent-*` branch) refuse the *dispatch* instead of only warning?**
   I chose warn, to keep the fail-closed path reserved for provable states. The cost of the other
   choice is a false refusal for a user who deliberately checked an old work branch out; the cost of
   mine is that a pre-upgrade orphan is still silently used as a base until someone reads the warning.
6. **Grace before restore?** No mechanism can detect a surviving detached child, so a wait would be
   theatre. If the conductor wants one anyway, name what it is waiting for.
7. **Does the record need the run's task/label** so the notice can say *which* run was interrupted?
   The agent record already has it, and the notice could read it by id (one file) — cheap, but it
   couples the boot step to the agent store; not measured, so left out.
8. **`headState` naming.** `HeadState` is already the captured-HEAD type (`git.ts:54`); the persisted
   thing is a `HeadStateRecord`. The ADR should say so once, or someone will "unify" them.

### 11.1 Not measured (with the command that would settle it)

| # | Claim I did **not** establish | Why it matters | Settling measurement |
|---|---|---|---|
| 1 | **how often** a detached child outlives the conductor | It is the one admitted hazard of O2 (§8.1 row 1). P3 proves it *can*; the frequency decides whether O2 or O3 is right. | In a real branch-mode run, start a long `bash` command, `kill -9` the pi process, then `ps -eo pid,ppid,pgid,cmd` for a survivor and check the base tree after the boot |
| 2 | the policy on a **non-`/proc` host** (macOS/Darwin) | `classifyOwner` returns `unknown` without a start token, so no automatic restore fires; I reasoned this from `proc.ts:49-60` + `recovery.ts:465-470` + P11 F8, but ran on Linux only | `node -e 'console.log(require("fs").existsSync("/proc/self/stat"))'` on the target host → `false`; then a boot with a planted record |
| 3 | a **real pi restart** (not two vitest processes) | The two-process harness is faithful for module state and disk, but it does not exercise `session_start`, `restoreFromSession`, or the TUI | Dispatch a deaf branch run in a real pi session, `kill -9` the pi process, restart in the same cwd, read `.pi/subagent-logs/brl-subagent.log` and `git status` |
| 4 | how the boot line and the refusal **render** in the TUI | The message shapes are drawn from existing surfaces (`pi.sendMessage` at `nextTurn`, tool-result errors), not observed | the same run as #3, plus a second dispatch in the unrepaired repo |
| 5 | whether `.pi/head-state/` collides with anything a user project already has | The name is new in this repo; user projects are not sampled | `ls -d ~/…/.pi/head-state` across the maintainer's projects before shipping |
| 6 | the 30-day staleness number | It is a placeholder borrowed from `cleanupTempDirs`' shape, not from any measurement | none available offline; treat as a product default |

---

## Appendix A — probe inventory (exact commands, paths, outputs)

Vitest probes run from the copy of `src/` with the checkout's `node_modules` symlinked:

```
cd /tmp/brl466 && ./node_modules/.bin/vitest run --config vitest.probe.config.ts --silent=false probes/<file>
```

| Probe | File / tree | What it drives | Load-bearing output (verbatim) |
|---|---|---|---|
| **P1** | `probes/p1-boot-blindness.test.ts` (real `run-registry.ts` + `recovery.ts`) | registry → deadline-terminal write → scan; terminal agent record | `P1S1 {"entries":1,"scanned":1,"marked":1}` · `P1S2 {"before":1,"after":0,"scanned":0,"marked":0}` · `P1S3 {"entries":1,"scanned":0}` |
| **P2A** | `probes/p2a-run.test.ts` (real spawn, real repo, deaf child) | a branch run whose deadline fires, then the process ends | `"head":"brl-subagent-70dad1ac"`, `"statusPorcelain":""`, `"workHeadSubject":"e568eff A: committed work"`, `"registryEntries":0`, `"agentRecord":{"status":"stopped","error":"Timed out after 400ms","gitFields":[]}` |
| **P2B** | `probes/p2b-restart.test.ts` (fresh process, same stores) | the boot, then a second dispatch | `"registryAtBoot":0`, `"scan":{"scanned":0,"marked":0}`, `"headBeforeB":"brl-subagent-70dad1ac"`, `"bRecordedBase":{"base":"brl-subagent-70dad1ac"}`, `"bDiffHasOrphanWork":false`, `"headAfterB":"brl-subagent-70dad1ac"` |
| **P3a** | `sh/probes.sh` + `late-writer.js` (SDK's spawn options: `detached`, `stdio[ignore,pipe,pipe]`) | parent SIGKILLs itself; child keeps writing; then `git checkout` | `aliveAfterParentSIGKILL=yes`, `growthBytesPerSecond=38`, `checkoutExit=0`, `baseTreeGrowthBytesPerSecond=38`, `status=[?? notes.log]` |
| **P3b** | `sh/probes.sh` | tracked file, same blob both branches | `checkoutExit=0`, `statusAfter=[ M src.txt]` (dirt carried into the base tree) |
| **P3c** | `sh/probes.sh` | tracked file, differing blobs | `error: Your local changes … would be overwritten`, HEAD unchanged |
| **P4** | `probes/p4-teardown-window.test.ts` (real `git.ts`, 400-file repo) | `commitAll` + `captureDiff`, then simulated death; then restore+keep vs restore+delete | `"commitMs":24,"diffMs":3,"windowMs":27,"cleanTree":true,"head":"brl-subagent-7409d72b"`, `"mainLog":"d8d5947 base"`, `"diffHasWork":true` · `P4R {"restoreOk":true,"head":"main","workBranchStillExists":true,"workSurvivesOnItsBranch":true}` |
| **P5** | `sh/probes.sh` (plain git) | reflog, `branch -D` on the checked-out branch, several orphans, `origin/HEAD` | `HEAD@{0}` → `checkout: moving from main to brl-subagent-aaaaaaaa` · `cannot delete branch … used by worktree` · `orphanBranches=[brl-subagent-aaaaaaaa brl-subagent-bbbbbbbb brl-subagent-c0000001 … c0000003]` · `fatal: ambiguous argument 'origin/HEAD'` |
| **P6** | `sh/probes.sh` | the manual repair path on a dirty orphan | `afterStash=[head=brl-subagent-dead0001 status=[] stash=[stash@{0}: On brl-subagent-dead0001: …]]`, `checkoutExit=0 head=main`, `stashFiles=[src.txt]` |
| **P7** | `sh/probes.sh` (node, `/tmp/brl466/p7-atomic`) | 2,000 temp+rename writes under a concurrent reader | `{"reads":43463,"bad":0}` and `{"reads":77221,"bad":0}` on a second run |
| **P8** | `sh/probes.sh` | a second process switches branches mid-write | `head=brl-subagent-bbbb0002 aWritesOnThisBranch=yes` |
| **P10** | `sh/probes.sh` | symlinked path canonicalization | `viaSymlink=[/tmp/brl466/p10-symlink/real] viaReal=[…/real]` |
| **P11** | `probes/p11-reconcile.test.ts` (reference implementation in the probe; `src/` untouched) | the §4 decision table against real git states | `F1 restore … branchKept true, workStillThere true` · `F2 needs-manual` · `F3 already-off` · `F4a no-branch … statusReadsDirtyBefore true, cleanAfter true` · `F4b no-branch` · `F5 skip-owner, ownerClass alive` · `F6 skip-missing` · `F7 skip-record` · `F8 skip-owner, classify unknown` |
| **P12** | `sh/probes.sh` | `git update-ref -d` on the checked-out branch | `symbolicRef=[brl-subagent-forced01] status=[A  base.txt]`, `revParseHEAD=fatal: …`, `checkout main → exit 0, clean`, `checkout <deleted branch> → pathspec did not match` |

`sh/probes.sh` is the shell half, re-runnable end to end (`bash /tmp/brl466/sh/probes.sh`); the vitest probes
are re-runnable in that order — **P2A wipes and recreates `/tmp/brl466/repro`, so P2A must run before P2B**.

## Appendix B — coverage lines (every search this dossier rests on)

```
$ git rev-parse --short HEAD && git branch --show-current && git status --porcelain
65a926a / dev / (empty)

$ grep -n "gitLockOwners\|isStuckTerminalOwner" src/session-manager.ts
(no output)                                  → #465 is NOT merged on this base

$ grep -rn "createWorkBranch" --include=*.ts src/ | grep -v __tests__
7 lines: git.ts:61 (doc comment), git.ts:108 (the definition) · session-manager.ts:16 (import), :1880, :1889
  · index.ts:69 (import), :3397   → exactly TWO production call sites (session-manager.ts:1880,
  index.ts:3397), one per execution path

$ grep -rn "brl-subagent-" --include=*.ts src/ | grep -v __tests__ | wc -l
3    → git.ts:113 (the only branch-name producer), types.ts:775, :776 (custom-entry type strings)

$ grep -n "gitBranchLocks\|releaseGitLock" src/session-manager.ts
11 lines: 37, 45, 1646, 1724, 1725, 1856, 1860, 1862, 1865, 1895, 1896
  → module state (per process), reset only by __testResetGitBranchLocks

$ grep -n "cleanupWorkBranch()" src/session-manager.ts
1754, 1980, 2230, 2270, 2307, 2347          → six settle-side call sites

$ grep -rn "restoreHead\|deleteBranch" src/recovery.ts src/recovery-engine.ts src/recovery-surface.ts
(no output)                                  → the boot path never touches HEAD; index.ts has all 10 hits

$ grep -n "appendEntry" src/run-registry.ts
352          → persistRunRecord appends the session entry (and clears the registry first)

$ grep -n "childMarker" src/types.ts
404, 411, 848, 857   → 848-851: "no background path sets it, because the session is in-process"

$ ls .development/decisions/ | tail -3
0024-…, 0025-jev-level-as-observation.md, README.md    → 0026 is free

$ grep -n "REGISTRY_DIR = \|STORAGE_DIR = " src/run-registry.ts src/session-manager.ts
run-registry.ts:107 ".pi/run-registry" ; session-manager.ts:67 ".pi/subagents"  → both cwd-relative

$ sed -n '1,20p' .gitignore
".pi/*" ignored with .pi/skills/ and .pi/extensions/ re-included
  → a new .pi/head-state/ cannot be committed in this repo
```

## Appendix C — design assumptions checklist (for the follow-up PR)

The bar asks these in writing for stateful work; the answers are the design's, not a suggestion.

1. **What state does this create, and where does it live?** One JSON per repository at
   `.pi/head-state/<sha256(repoRoot)[0:16]>.json` — directory `0o700` (`ensureOwnerOnlyDir`),
   file `0o600`, cwd-relative like `.pi/run-registry/` and `.pi/subagents/`. Owner: the conductor
   process that created the work branch. No other state is created (the branch already was).
2. **Who tears it down, and what if the process dies between create and teardown?** `cleanupWorkBranch`
   clears it when the tree is verified off the work branch. A death between create and teardown leaves the
   record — which is the point: the *next* boot owns the teardown, and the verdict table is what it does.
   There is no sweep-before-use: the record is read at boot and at dispatch, never trusted blindly.
3. **What is the concurrency model?** In-process: the per-repo branch lock (`gitBranchLocks`) serializes
   the writers, so one record per repo cannot be created twice concurrently. Cross-process: **nothing**
   serializes (measured P8) — the record is last-writer-wins and atomic (temp+rename, 43k-77k torn-read-free
   reads measured); a lost record degrades to the L2 warning, never to a wrong restore, because every
   verdict reads the live git state.
4. **What if the state is missing, partial or unreadable?** Fail-closed on action, fail-open on startup:
   a missing record is not an error (nothing to repair, L2 warns), a malformed one is never acted on
   (`skip-record`), a record whose owner cannot be proved dead is never acted on (`skip-owner`). The boot
   never throws: one `try` per record, a summary line, and the existing catch-all above it
   (`index.ts:4252-4254`).
5. **What evidence proves each claim on a real run?** Appendix A. The two that matter most: the
   two-process restart (P2A/P2B — the real spawn, a real repo, a fresh process) and the decision table
   executed against real git state (P11). Not proven, and stated as such: the frequency of the late writer
   (§8.2 falsifier 1) and any run on a host without `/proc` (§8.1 limit 2).

## Appendix D — how this answers the issue body's six questions

| The brief asks | Where |
|---|---|
| 1. Reproduce the restart behaviour today, and show what the boot reports and what the next dispatch builds on | §1 (`W466P-P2A`/`P2B`), plus §0 F1 for *why* the boot reports nothing |
| 2. `headState` shape and home — run record, agent record, or sidecar | §2 (the four homes, with the measurement that disqualifies three) and §3 (shape, keying, write/clear points) |
| 3. Boot policy options and their failure modes, including late writer, dirty tree, deleted branch, several orphans, several repos, protected branches | §4 (baseline + minimal + recommended + refuse-only + dispatch-time, the executed table, and a hazard × option matrix) |
| 4. Legacy records must not crash the boot and must not be repaired blindly | §5 (L1/L2/L3, with the fail-closed reason for each) |
| 5. The manual repair path the refusal/warning names | §6 (measured verbatim, including the reflog hint for L2) |
| 6. Interaction with #465, and which message wins | §7 (owner-stuck > unresolved-record > dirty, and the one text edit #465 owes) |
