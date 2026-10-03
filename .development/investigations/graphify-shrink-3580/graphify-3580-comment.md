**Additional occurrence data (Linux, small corpus) + a negative replay on 0.9.69**

@L4XB asked which of *scale*, the *aggregated path*, or a *second consecutive hook run* is load-bearing. This repo narrows the first two out — same class, but with **none of those traits** — so I'm posting the artifacts plus a negative result, since a negative result narrows it too.

**Environment**
- Linux, Python 3.14.7, git 2.55.0. Installed version at each incident was not logged (0.9.6x era; **0.9.69 was only installed after the last incident**). Currently on 0.9.69.
- Corpus: **86 `.ts` files under `src/` / 118 tracked files**; graph **990 nodes / 2572 edges / 61 communities**. No submodules, no untracked source directories, `graphify-out/` is gitignored, maintained by the stock `post-commit` hook (`graphify hook install`).

**Three incidents in this repo**

| date | change set | what was lost |
|---|---|---|
| 2026-09-12 | code commit (added `src/paths.ts`) | `src/paths.ts` nodes gone |
| 2026-09-22 | version-bump commit | 2 newly-added exported symbols gone |
| 2026-09-27 | version-bump commit (`package.json`, `package-lock.json`, `README.md`, `CHANGELOG.md` — **no source files**) | `src/prelude.ts` file node + its symbols + ~10 other exported symbols (990 → 943 nodes) |

Each time the hook logged a clean success, **no guard output of any kind** (`grep -E "WARNING|Refusing"` over the entire `~/.cache/graphify-rebuild.log` → 0 matches), and only a full rebuild (`graphify . --update` + `cluster-only` + `label`) restored every node.

The 2026-09-27 hook run, verbatim:
```
[graphify hook] 4 file(s) changed - rebuilding graph...
[graphify] backed up semantic+curated graph (7 files) -> 2026-09-27/
[graphify watch] Rebuilt: 943 nodes, 2412 edges, 58 communities
[graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in .../graphify-out
```
A full rebuild afterwards restored **990 nodes / 2572 edges / 61 communities** with `src/prelude.ts` present (9 prelude nodes) — that is the state we've been running since. The reduced graph itself was overwritten by the recovery, and the dated `2026-09-27/` backup dir was refreshed by the recovery's own backup afterwards (its files are stamped 99 s after the hook run's last log line), so I can't hand over the 943 file — the log line above and the recovery result are the primary evidence. Happy to attach the recovered graph or the dated backup dir if useful.

**Replay on 0.9.69 → clean**
Against the same tree and graph state, replaying exactly the hook's call:
```python
_rebuild_code(Path("."), changed_paths=[package.json, package-lock.json, README.md, CHANGELOG.md])  # force=False
```
→ `Rebuilt: 990 nodes, 2571 edges, 60 communities`, prelude intact, write proceeded (guard had nothing to refuse).

**Caveats on the negative result** (so it isn't over-read)
- The incremental state files were rewritten by the full-rebuild recovery after each incident, so the exact pre-failure state cannot be reconstructed here. This is "latest passes the replay we can construct", not proof of a fix — nothing in the 0.9.68→0.9.69 diff obviously targets this, so it may be state-dependent.
- On the bypass list, for this shape: `force=False` (GRAPHIFY_FORCE unset); `had_explicit_deletions and rebuilt_sources is None` shouldn't apply (the 0.9.69 hook path passes `rebuilt_sources` at `watch.py:1966`/`2180`); `new_n >= existing_n` can't be it (943 < 990). That leaves the `_accounted()` path — the lost nodes' `source_file`s were not in `rebuilt_sources`, so it *should* have refused — unless those nodes carried a falsey `source_file`, or `existing_data` was falsey at guard time (the route this issue already suspected).

The full rebuild log is attached; happy to run instrumented builds against this tree.
