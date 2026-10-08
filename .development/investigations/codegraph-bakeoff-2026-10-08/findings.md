# CodeGraph bake-off — Phase 0 findings (2026-10-08)

**Verdict: PASS on every bar item.** Phase 0 ran tool-side only: no repo changes, no
cockpit state, no MCP/agent wiring. CodeGraph `@colbymchenry/codegraph@1.6.2` (pinned;
`DO_NOT_TRACK=1`; telemetry explicitly disabled) indexed a **scratch clone of the cockpit
@ `506033a`** (297 tracked files, no `node_modules`).

Rule 19 coverage: every number below comes from the command named beside it. The
"Boundaries" section states what this bake-off did **not** test.

## 1. The bake-off bar — all items PASS

| # | Bar item | Result |
|---|----------|--------|
| 1 | Coverage oracle (`graph-check.py`'s bar) | **34/34 modules, 0 missing of 322 exported declarations, fresh** — reproduces graphify's bar exactly, in **5ms** (`coverage-codegraph.py`, prototype committed alongside) |
| 2 | Query parity | §2 — all three question sets correct, including the re-export seam |
| 3 | Determinism | §3 — re-index byte-identical; docs-only sync is a no-op; no manual reconciliation |
| 4 | Integration cost | §4 — small; the adapter is already written and tested |

## 2. Query parity (the real questions from the graphify pain)

Semantics first: `codegraph callers <symbol>` returns **semantic references** — the
enclosing named function, or the file node when the call sits in a callback — not raw
grep line hits. Checked against exact-call-site ground truth (`grep -rn "name("`):

- **`setLogCwd`** — definition `src/logging.ts:124`. Callers: `index.ts` (the
  `session_start` callback at line 3832 attributes to the file node), `session-manager.test.ts`
  (file), `createTempEnv` (`fixtures/temp-lifecycle.ts:55`). No phantoms; the two comment
  mentions of the name in `logging.ts` are **not** counted as callers (grep counts them).
- **`getTranscriptPath`** — definition `src/transcript.ts:37`. All four internal callers
  attributed to their exact enclosing functions (`startTranscript`, `appendEntry`,
  `getTranscript`, `completeTranscript`), plus `session-manager.test.ts`.
- **The re-export seam that confused graphify** — `session-manager.ts:329`
  (`export { transcriptPath as getTranscriptPath } from './transcript-path'`):
  `codegraph node --file src/transcript-path.ts --symbols-only` reports "3 symbols,
  used by 6 files", including `session-manager.ts` (the alias) **and** `transcript.ts`.
  Both directions resolve; the alias neither shadows nor hides the original.
- **`transcriptDisplayPath`** — definition `src/transcript-path.ts:39`; callers
  `buildOutputHonestyLines` (`history.ts:241`), `index.ts` (file), `transcript-path.test.ts`.
  `architecture-rules.test.ts` mentions the name only in a string — **correctly excluded**
  (grep counts it).

Bonus surfaces that came free (not bar items): `impact` (46 nodes / 87 edges at depth 2
for `src/logging.ts`), `affected` (34 candidate test files for `src/logging.ts` — a
conservative superset; includes `test.bench.ts` and the fixture unless `-f` filtered),
FTS `query` (~240ms), and stored `is_exported` / signature / docstring fields.

## 3. Determinism (the property graphify never had)

Content hash = SHA-256 over `(id,kind,name,file_path,start_line)` per node and
`(source,target,kind)` per edge, read from SQLite.

| Operation | Wall | Result |
|---|---|---|
| `codegraph init` | 4.3s | 120 files → 2,250 nodes / 7,772 edges |
| `codegraph index` (full rebuild) | 4.3s | **identical hashes** (`3458ca6bc0ec` / `0308ba9a43d4`) |
| `sync` after adding an exported function | 474ms | +1 node, findable by `query` |
| `sync` after reverting it | 468ms | **exact original hash restored** — no residue |
| `sync` after a docs-only change (README) | 371ms | rc=0, "Already up to date", hashes unchanged |

That last row is the entire refusal class gone: CodeGraph indexes **no `.md` files at all**
(0 of 120). Docs-only merges cannot thin a semantic layer, trip a dedup-shrink guard, or
leave a stale rewrite — refusals #1–#4 cannot occur. No daemon or watcher is left running
by CLI use; explicit `codegraph sync` at merges fits the #230 discipline directly.

## 4. Integration cost

- **Freshness is declared, not inferred:** `project_metadata` carries `indexed_at_commit`
  (the exact commit), `index_state: complete`, `indexed_with_version`, and
  `index_files_discovered/accounted` (120/120). A guard can assert `indexed_at_commit == HEAD`
  — strictly stronger than `graph-check.py`'s mtime comparison, and it kills the
  "absence read as truth" ambiguity (#173) at the root.
- **Prototype adapter:** `coverage-codegraph.py` reproduces §1 in 5ms (~70 lines, SQLite
  only). Phase 1's `graph-check` replacement is this file hardened + wired into the ritual.
- **Refresh:** `codegraph sync` (0.4s) + `status -j` (exposes `pendingChanges`,
  `worktreeMismatch`). Binary ~62MB; DB 10.7MB (vs graphify's 1.7MB `graph.json`).
  `~/.codegraph/telemetry.json` holds a machine-id file (telemetry disabled; `DO_NOT_TRACK`
  respected).
- **Ignore behavior:** `.gitignore` respected (`node_modules` excluded — verified with a
  planted file). Untracked *non-ignored* files **are** indexed (filesystem-driven) — fine
  for the clean cockpit; `indexed_dirty_paths` records dirty-context indexing. The tool
  writes its own `.codegraph/.gitignore` (self-ignoring DB).
  **Correction to the pinned handoff:** the earlier claim that an untracked `.codegraph/`
  would trip `check-repo.sh` was **wrong** — line 86 filters `^?? `. The scratch-clone
  choice stands for the other reason: the cockpit (ADR 0011's authoritative tree) must not
  carry exploration state.

## 5. The third option (in-repo `ts-ast` extractor) is the expensive one

`scripts/ts-ast.mjs` is a **194-line parser adapter** exporting `parseTexts` — TS 7 AST
access, no edges. `allEdges()` exists but only inside `architecture-rules.test.ts` (import
edges for the 9 rules). Module/symbol coverage is trivial to own; **call resolution**
(enclosing-function attribution, re-export alias following, cross-file symbol linking) is
the 80% CodeGraph already does — and the part we would own forever, ambiguities included.
It is the most expensive option, not the cheapest.

## Boundaries (what this bake-off did NOT test)

- **Resolution is partial**: 14,344 unresolved refs, 12,223 of them `calls`; 1,989
  unresolved calls in `src/` non-test. Sampled class: local-variable/external methods
  (`queue.push`, `resolve`, `signal.addEventListener`). The 3-symbol parity sample was all
  correct; broader sampling is Phase 2 work.
- **MCP-only surfaces** (`explore`, `context`, the agent installer) deliberately not
  exercised (CLI-only evaluation).
- **Environment**: scratch clone without `node_modules`; the cockpit's real `node_modules`
  was probed for ignore behavior only. Single machine (linux-x64), TS/JS primary; Python
  and YAML files were indexed but not verified. Windows assets exist, untested.
- **Supply chain**: 62MB native binary, per-platform release assets, single maintainer,
  MIT. Posture review is a Phase 1 item, not assessed here.

## Recommendation

**Proceed to Phase 1** (integration prototype in a worktree): root `.gitignore`, the
coverage adapter hardened into `.pi/skills/worktree/`, a `graph-refresh.sh` equivalent
(`codegraph sync` + commit assertion), skill + ARCHITECTURE updates, and an ADR recording
the decision. Then **Phase 2** (side-by-side dogfooding, explicit sync at merges, watcher
off, broader query-parity sampling) before any graphify retirement.

## Reproduction

```bash
BASE=/tmp/cg-eval; mkdir -p $BASE/tool
DO_NOT_TRACK=1 npm install --prefix $BASE/tool --no-fund --no-audit @colbymchenry/codegraph@1.6.2
git clone --no-hardlinks --branch dev --single-branch <cockpit> $BASE/repo   # /tmp is another fs: --no-hardlinks
$BASE/tool/node_modules/.bin/codegraph telemetry off
$BASE/tool/node_modules/.bin/codegraph init $BASE/repo                       # 4s
python3 coverage-codegraph.py $BASE/repo                                     # the oracle, 5ms
$BASE/tool/node_modules/.bin/codegraph callers setLogCwd -j -l 50 -p $BASE/repo
$BASE/tool/node_modules/.bin/codegraph index $BASE/repo                      # deterministic rebuild
```
