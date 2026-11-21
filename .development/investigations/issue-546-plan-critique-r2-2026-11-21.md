# #546 — plan critique **r2** (`needs-work`)

**Critic:** `critique-546-r2` (project-plan-critic, `openrouter/openai/gpt-6.1-terra`, medium) · Jev
`high (0.46) · C1 · worktree y` · reviewed the r2 spec at `e02359b` · **provenance:** read-only preset (no
file writes); findings transcribed by the conductor from the run transcript. Verdict file:
`REVIEW_PR546_PLAN_R2.md`.

## Verdict

**needs-work** — 4 majors + 1 minor. Five of the seven r1 fixes verified sound; the remaining gaps are
**proof-internal** (the measurements do not establish what the text claims) with two real behavioural
consequences (import-failure stranding; `existsSync` false negatives).

## Findings

| Severity | Location | Gap | Evidence | Fix |
|---|---|---|---|---|
| **major** | §The code: tri-state reader and `clearInflightRun` | `existsSync(false)` does **not** prove absence — it also returns false when a parent directory cannot be traversed; the same mistake makes a failed unlink look successful. | chmod agent dir `000` → `retired=1`, `failures=0`; after restoring access the record was still `running` and the registry empty. With an entry present and the registry dir `000`, `clearInflightRun` returned `true`; after restore the entry was still present. | Distinguish `ENOENT` from access and other errors with an error-reporting operation (`statSync`/`unlinkSync` error codes); add directory-traversal tests. **Falsifier:** either case reports settlement while the restored file remains. |
| **major** | §Boot applier wiring; D6/D7 | The no-applier branch falls through to ordinary recovery: for `acceptedAt:null` the never-started finalizer retires the marker, stranding a running record; for accepted entries it marks the marker `interruptedAt`. The blanket "marker kept" claim is false. | `phase1 p1 null` then `boot-importfail.cjs` → `registryFiles:[]`, record `running`; `p1 accepted` → `marked:1`, the marker acquired `interruptedAt`. | **Hold** marker-bearing entries when either dependency is unavailable (no finalize, no mark); test both acceptance states through production wiring. **Falsifier:** an import failure removes or marks a marker. |
| **major** | §The narrowed guarantee | `claimTerminalNotice` is module-local, not shared across processes — so duplicate **notices** are possible, not merely duplicate events. | Seam race: two repairs, two events, 5 ms drift. Two separate `node` processes each called `claimTerminalNotice("same-run")` → both `true`; `src/notify-completion.ts` owns a module-level `Set`. | State the cross-process notice limit honestly (or add a shared claim, out of scope). **Falsifier:** two processes independently win the same claim. |
| **major** | §Evidence E2; verification step 6 | The W-0 probe does not kill between unlink and append in the r2 tree — it duplicates W-1 and does not measure the uncommitted-entry residue. | `rg -n BRL_CRASH_W0` on the r2 base/optA → no matches; `run.sh base w0` → `COMMITTED_RUNS:["running","failed"]`, while the spec claims the terminal entry was never attempted. | Instrument or intercept the real unlink/append seam, assert the committed run-entry stream, re-run E2. **Falsifier:** a terminal entry appears in the W-0 stream. |
| minor | §Evidence; `boot.cjs` triple gate | The parser searches the whole existing log, so a previous settlement line can satisfy a later boot's assertion. | Re-ran `boot.cjs` on the settled P2 state with `EXPECT_TRIPLE=0,1,0` → `ok:true`, exit 0, registry empty at PRE. | Scope assertions to lines produced by this boot, or require a fresh log. **Falsifier:** a no-op second boot passes on the first boot's counter. |

## Verified sound

- **1** marker-write failure: H1 passes (registry `0500` → `false` consumed, `deferRetire:false`); P5 admits
  the historical residue; atomic rename protects a partial entry. (`false` still conflates missing/
  unreadable/write-failure — see the major above.)
- **2** absent vs unreadable: H2a/H2b/H2c pass for unreadable files, absent files, corrupt JSON;
  `flipFailures` is a **settlement-failure** counter by design (stated).
- **3** pre-flip disk read: sequential race = one repair then `0/0/0`; seam race = two repairs, two events;
  the scan counts the applier's outcome and holds unreadable/live-owner entries when fully wired.
- **4** retire verification: H4a and production-wired H4d pass for dir `0500`; `rg` found no caller using
  the old `void` return as a condition.
- **5** M2 correction: the probe file passes **22/22** on the mutant (S2 included); S1 + H1 kill it — the
  table's correction is sound.
- **6** dynamic import: architecture suite **11/11**, `check-imports` 60 files / 0 violations, the static
  mutant fails the architecture rule; the import-failure **behaviour** is the major above.
- **7** harness: E1/E5 absence assertions and E4c pass; the explicit wrong triple, missing triple, present
  settlement under `EXPECT_NO_SETTLEMENT`, and a changed `completedAt` each exit **3**.
- M1–M15 + M13b each produced its listed killer; the static mutant fails the architecture rule.
- `SOLID/DRY violations flagged: 0`.

## Conductor decisions (r3 mandate)

1. **M1 — accept.** Use error-reporting I/O: `statSync` with `err.code === "ENOENT"` = confirmed absent,
   any other error = uncertain (keep the marker, `false`); `unlinkSync` with `ENOENT` = success, any other
   error = failure after a `statSync` confirmation. Add directory-traversal (`000`) tests for both the
   record reader and `clearInflightRun`.
2. **M2 — accept.** The marker branch **holds** (skip ordinary recovery entirely) whenever
   `applyRecordFlip` or `readFreshAgentRecord` is unavailable; the entry and the marker stay untouched. Pin
   both `acceptedAt` states through production wiring (the `boot-importfail` shape).
3. **M3 — accept as a stated limit.** Remove "deduped by `claimTerminalNotice`" from the narrowed-guarantee
   paragraph; state that the claim set is per-process, so two boots may each deliver a notice. Name a
   shared claim as the out-of-scope remedy.
4. **M4 — accept.** Instrument the **real** `persistRunRecord` seam (a scratch-only crash hook between
   `clearInflightRun` and `pi.appendEntry`), assert the committed run-entry stream is `["running"]`, and
   re-run E2 under that instrument.
5. **Minor — accept.** `boot.cjs` scopes its assertions to lines appended after the boot started (offset or
   truncated log), and the probe re-run proves a no-op second boot **fails** an `EXPECT_TRIPLE`.
