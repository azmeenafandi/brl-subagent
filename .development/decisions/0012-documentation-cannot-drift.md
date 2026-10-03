# 0012. Documentation that cannot drift: generated module map + executable architecture rules

- **Status:** Accepted
- **Date:** 2026-09-30
- **Issues:** #249, #251

## Context

The architecture document had grown to 923 lines organized by delivery phase, still described the subprocess path as "the" architecture, duplicated the release changelog, and was linked from CONTRIBUTING — manual upkeep had failed repeatedly. A naive regex survey reported a `types ↔ schema` cycle that does not exist at runtime.

## Decision

- The architecture doc is lean, version-free, and current-state.
- Its module map is generated from each module's `// Purpose:` first line and CI-checked.
- Structural invariants are executable fitness functions over the import graph: no runtime cycles, entry-point confinement, the `types`→`schema` type-only direction, the pure-helper boundary, process-execution confinement, the runtime-dependency allowlist, and the session-manager reader API.
- History stays in ROADMAP/TASKS/git.

## Consequences

- Adding or renaming a module, or violating a structural rule, fails CI with the remedy in the message.
- The doc carries no release stamps, so the release ritual never touches it.
- The fitness functions are advisory about intent only — they prove imports, not usage.
