# Experiment — typebox 1.4.2 instead of the host pin 1.3.27 (2026-10-27)

**Question:** what happens if the devDependency moves to the latest typebox while pi's host pin stays at
1.3.27? Motivated by dependabot #364 (held).

**Method:** throwaway worktree at `dev` `4b582bd` → `npm ci` (typebox 1.3.27 from the lockfile) → dump the real
`delegate_task` parameter schema (343 lines) via jiti → swap **only** typebox to 1.4.2 in `node_modules`
(`npm install typebox@1.4.2 --no-save --no-package-lock`; package.json and lockfile verified byte-unchanged) →
re-dump, `npx tsc --noEmit`, `npx vitest run`, compare the API surfaces, and confirm no other dependency moved.

## Results

| Check | Result |
|---|---|
| Emitted tool schema (JSON) | **byte-identical** (343-line dump, zero diff) |
| `tsc --noEmit` | clean |
| Full suite | **90 files / 1798 tests green** |
| `Type` builder surface | identical (our 9 builders: Optional/String/Object/Literal/Boolean/Array/Union/Number/Record) |
| Root exports | identical + 2 additions (`EvaluatePropertyIntersect`, `EvaluatePropertyUnion`) — additive |
| Other packages | unchanged (pi 1.4.0, vitest 5.0.5, ts 7.0.2) — no confound |

The 1.4.2 changes are in compile/guard/format internals we never import (root `Type` + the `Static<>` type only).

## Interpretation

- **No observable effect today.** The swap is a drop-in for our surface.
- The pin is **runtime alignment, not API compatibility**: `typebox` is a **peerDependency** — an npm-installed
  extension resolves it from the **host's** tree (pi 1.4.0 pins `typebox 1.3.27`). The devDependency exists so
  `tsc`/tests see the same version the host runs.
- Bumping the devDependency while the host stays put would split dogfood (1.4.2) from users (1.3.27) and make the
  suite stop proving the host's version. The risk is future 1.4-only API use passing locally and failing for users.
- When pi moves its pin, the bump is a **no-op for our code** — this experiment is that evidence.

## Decision (2026-10-27, maintainer)

**Keep parity with pi upstream.** The pin stays at the host version; #364 remains held (no `ignore` — the proposal
stays visible); re-evaluate when pi's pin moves. Throwaway worktree removed; cockpit untouched (1.3.27, clean).
