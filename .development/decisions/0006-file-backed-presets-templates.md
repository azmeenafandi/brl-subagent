# 0006. File-backed presets and templates with three-tier precedence

- **Status:** Accepted
- **Date:** 2026-08-09
- **Issues:** #66, #79, #84

## Context

TUI single-line input was unusable for multiline bodies, and presets persisted in session state were lost on reset and never reached other checkouts. The first-tier implementation silently let user-global beat project-local — a precedence inversion found in review.

## Decision

- Presets and templates are Markdown files with YAML frontmatter in three tiers: builtin (`presets/`, `templates/` in the package), user-global (`~/.pi/agent/brl-subagent/…`), and project-local (`.pi/brl-subagent/…`).
- Tiers are scanned project-first and deduped by name so project wins.
- Templates reference presets one-way.

## Consequences

- TUI managers browse and write files instead of mutating session state.
- Dangling preset references warn at load (#81).
- Custom files survive `pi update --extensions`.
