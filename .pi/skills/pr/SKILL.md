---
name: pr
description: "Use when writing a PR body (implementation, fix, or docs PRs targeting dev)."
metadata:
  credits:
    adapted-from: "mattpocock/skills — engineering/pr (MIT © 2026 Matt Pocock)"
    original: "humanlayer/skills — show-me (Dex Horthy)"
---

# Writing a PR body

This skill covers the **body only**. Process (branch per unit, target `dev`, merge
commit — never squash) lives in the worktree skill's lifecycle. Release PRs
(`dev` → `main`) follow `references/release-ritual.md` instead.

The body serves two readers: the **reviewer** (what to aim at) and the **release
notes** (what shipped). Keep prose brief; use the project's domain language
(`.development/GLOSSARY.md`).

## Size threshold — do not over-template

| PR | Shape |
|---|---|
| Behavioral / cross-module / C1–C2 | All four sections below |
| Docs, comments, nits, single-line fixes | One-line summary + the `Fixes` block; keep Evidence only if anything ran; still state the door |

## 1. Summary — the smallest view that makes the point

One short paragraph. Then **at most one** visual, only if it clarifies: a diff-sketch
(file tree), a call tree, or a small pseudocode block.

```diff
 src/
 ├── runner.ts           # the death check that changed
+└── kill-escalation.ts  # the extracted escalation helper
```

## 2. Evidence — what proves it works

Paste the REAL command and its observed result (Rule 21 — claims cite evidence);
show **before → after** where a before exists. Test counts relative to the baseline
(e.g. "67 files / 1360 tests — was 66/1349"). Execution output is the S-tier here;
screenshots only for TUI-visible change. Never just "tests pass".

## 3. Merge Danger

- **Door:** one-way or two-way? If a merge cannot be walked back cheaply, name the
  rollback.
- **Blast radius:** what can it affect — one file, one path, all runs, the public
  surface, an unmerged sibling unit?
- **Ramifications:** the one thing a future reader must know (ordering/invariant, or
  why a tempting alternative was rejected).

## 4. Issue linkage — mandatory

One `Fixes #N` **per line**; a comma list does NOT fan out, and the keyword fires on
the default-branch merge only — a `dev` merge defers the close to the next release.

Fixes #NNN
