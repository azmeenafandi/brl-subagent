# 0019. Project-local process checks: one umbrella `processChecks` flag

- **Status:** Accepted
- **Date:** 2026-10-31
- **Issues:** #415, #412, #407
- **Supersedes:** the GLOBAL scope of ADR 0018's decision 1 (rule 2's shape auto-switch). ADR 0018 stays
  Accepted for the Jev-line check, its transitions, and the provenance rule.
- **Addendum:** 2026-11-03 — the engineering-bar injection (issue #421) extends this umbrella; see the
  addendum at the end.

## Context

ADR 0018 recorded two chokepoint checks. The Jev-line gate was scoped as a per-project opt-in
(`package.json` `brl-subagent.requireJevLine`); rule 2's durable-shape auto-switch was not — it was product
behavior for everyone.

That asymmetry was the defect. A user dispatching `thinkingLevel: high|xhigh`, `background: false` and an
explicit `timeout` had their explicit parameter overridden: the run became background and the timeout was
dropped for the 30-minute default. For a user an explicit foreground timeout is usually a **budget cap**, so
the switch could triple both time and cost against an instruction the caller had stated. Found in the
2026-10-31 unreleased-changelog audit, before either behavior shipped.

The root cause is the boundary this repository already knows: a *conductor* decision rule was implemented as
product behavior. The same leak the AGENT.md boundary rule prevents, in code.

## Decision

### 1. One umbrella project-local flag

Both process mechanisms are gated by a single field in the project's own manifest:

```json
{ "brl-subagent": { "processChecks": true } }
```

It replaces the merged-but-unreleased `requireJevLine` (no compatibility shim: nothing shipped carrying that
name). The field gates:

- the Jev dispatch-line check (`validatePreTask`, every pre-spawn path), and
- rule 2's durable-shape auto-switch (`resolveThinkingDispatchSwitch`).

`processChecks: false` means the switch never fires: the caller's `background` and `timeout` stand exactly as
passed, no notice is emitted, and no task text is rejected. This is the behavior every user gets.

### 2. One reader, fail-open

`src/project-flags.ts` is the only module that reads the manifest key. `readProcessChecks(cwd)` returns
`data?.["brl-subagent"]?.processChecks === true` and treats every failure mode as `false`: missing cwd,
missing manifest, unreadable file, malformed JSON, a non-object section, or a non-boolean value.

Fail-open is the product contract, in both directions: a broken `package.json` must never reject a user's
dispatch **and** must never reshape it. `PROCESS_CHECK_KEYS = ["processChecks"]` is the field whitelist.

### 3. The ratchet

`src/__tests__/project-flags.test.ts` makes the single-reader rule mechanical:

- no production module outside `project-flags.ts` may access the `brl-subagent` manifest key (bracket access or
  destructuring) — a second reader fails the suite;
- every field read from that section must appear in `PROCESS_CHECK_KEYS` — a third field fails the suite;
- this repository's tracked manifest must carry `processChecks: true`, so the opt-in cannot be silently
  dropped from the checkout that depends on it.

### 4. Dev-only, never marketed

The flag is maintainer process tooling. It is documented in `.pi/skills/**` and `.development/`, never in
`AGENT.md` or the README as a user feature. This checkout opts in via its tracked `package.json`, so every
worktree inherits it (the manifest is tracked; a gitignored `.pi/` marker would be absent exactly where the work
happens). The release ritual exercises the published tarball from a temp project **without** the field, so the
user path is verified at every release rather than assumed.

## Consequences

- A user's dispatch is never rejected or reshaped by our process checks. The explicit foreground
  `background: false` + `timeout` shape survives intact unless the project opted in.
- This repository keeps both checks active, including the line requirement on every pre-spawn path.
- The switch's ordering invariant is unchanged: when enabled, it still applies before
  `snapshotOriginalParams`, so an auto-switched run keeps its transport auto-retry.
- Adding a process mechanism now has a visible cost: a new `PROCESS_CHECK_KEYS` entry, an ADR, and the
  ratchet's approval. That is deliberate — the umbrella prevents a third per-rule field from appearing
  quietly.
- The Jev-line format, the provenance log, and the merge gate are untouched.

## Addendum (2026-11-03) — the umbrella also injects process content (issue #421)

This ADR's umbrella covered two *checks*. Issue #421 added a third mechanism that is not a check: the
project's engineering bar, read from `.pi/skills/worktree/references/engineering-bar.md` and appended to
every child's system prompt as a conductor-authored `<engineering-bar>` section when `processChecks` is
true. It reuses the field deliberately; no new `PROCESS_CHECK_KEYS` entry was added.

Facts the decision rests on (verified in PR #422):

- **One reader, unchanged.** `src/engineering-bar.ts` asks `isProcessChecksEnabled(cwd)`; no module reads
  the manifest key a second time, and the ratchet in §3 still holds.
- **Inert off, unread off.** In a project without the field, the section is not built and the reference is
  not read (pinned with a filesystem read log). The `processChecks: false` sentence in §1 extends to this
  mechanism: no section, no read, no warning.
- **Content is the project's own.** The reader loads the file from the dispatch cwd; the bar's text is
  outside `package.json.files`, so nothing of this repository's bar ships in the tarball (pinned against a
  real `npm pack`).
- **Failure is loud but non-fatal.** A missing or empty reference logs one warning and skips the section;
  it never throws into a spawn and never passes silently.

Why extend this flag instead of adding a per-mechanism field:

- The field's only realistic setter is this repository (§4: dev-only, never marketed). A second field
  would be a second per-rule switch of exactly the kind §1 exists to prevent, bought for a population
  that does not exist yet.
- An enabling project decides *what* the bar says by writing its own reference file — the opt-in grants a
  channel, not this repository's methodology. A project with no file gets a warning and no section.
- Splitting the field later is additive and non-breaking: `processChecks` is frozen by v2.7.0, but a new
  boolean can arrive if a consumer needs one mechanism without the other.

Accepted coupling, with falsifiers (when to reverse this):

- The path `.pi/skills/worktree/references/engineering-bar.md` names this repository's skill layout, so a
  third-party opt-in must recreate it (or eat one warning per spawn).
- **A real third-party project setting `processChecks` → split the field (`engineeringBar`) or neutralize
  the path.** That is the trigger, not a hypothetical preference.
- A consumer wanting the mechanical checks without injected content → the same split.
- The bar text becoming portable/generic (no `recon.sh` / `review-dispatch.md` references) → the split's
  value rises.

Clarification of the Consequences bullet "Adding a process mechanism now has a visible cost": that cost
is a new **field** (whitelist entry + ADR + ratchet). Extending an existing field with a new mechanism
needs this addendum and the ratchet's continued approval, not a new key — the distinction the bar forced
into the open.
