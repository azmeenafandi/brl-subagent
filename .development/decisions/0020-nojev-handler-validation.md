# 0020. The `noJev` bypass is validated in the handler, not the schema

- **Status:** Accepted
- **Date:** 2026-11-02
- **Issues:** #419, #412
- **Supersedes:** the schema-layer claim in ADR 0018 §2 ("`noJev: "<reason>"` — a non-empty string, refused as
  `true`/`""` at the schema layer"). ADR 0018 stays Accepted for the Jev-line check itself, its transitions, the
  escapes, and the provenance rule; only the claim about *where* the bypass's reason is enforced is replaced.

## Context

ADR 0018 §2 declared the bypass as `Type.Optional(Type.String({ minLength: 1 }))` and asserted it was "refused as
`true`/`""` at the schema layer". Half of that held, and the half that mattered did not.

The harness validates tool arguments with `compile(schema, { coerce: true })`, and pi-schema's string rule
stringifies booleans and numbers **before the handler is called**. Measured on 2026-11-02 against the real
`delegateTaskParamsSchema` through `@earendil-works/pi-ai`'s `validateToolArguments` (pi 1.5.0):

| passed | reached the handler as | schema verdict |
|---|---|---|
| `true` | `"true"` | accepted |
| `false` | `"false"` | accepted |
| `42` | `"42"` | accepted |
| `""` | — | refused (`minLength: 1`) |
| `{}`, `["a"]` | — | refused (not stringifiable) |

A live probe on 2026-11-02 dispatched with `noJev: true` and spawned a subagent whose warning read
`noJev override: the Jev dispatch line was skipped — true`: the bypass accepted a coerced boolean as its "stated
reason". A direct caller passing `{}` did not even get that far — `config.noJev.trim()` threw
`TypeError: config.noJev.trim is not a function`, a crash instead of a clean rejection.

The suite was green throughout. The pin asserted the **declared JSON shape**, and its comment ("`noJev: true`
… never reach[es] the handler") was false — a pin can only cover the seam it is written at.

Scope: not a released-user regression. The read sits inside `if (isProcessChecksEnabled(config.cwd))` (ADR 0019),
which is fail-open, so a normal project never examines `noJev` at all. The exposure is projects that opt into
`processChecks` — but this is the one place where coercion has a **safety** consequence rather than a convenience
one: it defeated a bypass's stated-reason property and could crash the check.

## Decision

### 1. One reader, at the handler

`src/validate.ts` reads `noJev` through `readNoJevReason(value: unknown)`, which returns one of three outcomes:

- **absent** — `undefined`, or an optional `null` (dropped by coercion): no bypass, the plain missing-line error.
- **reason** — `typeof value === "string"`, trimmed non-empty, and not a coerced primitive: the warning that
  names it, unchanged in shape from ADR 0018.
- **invalid** — anything else: a `string` is required, `.trim()` is never called on a non-string, and the text
  matching `/^(true|false|-?\d+(\.\d+)?)$/i` is a **coerced primitive**, not a reason.

An invalid value is a clean **error**, never a warning-as-bypass: the dispatch is refused with the normal
missing-line error plus an `invalid noJev: …` diagnostic. A boolean can therefore neither bypass the check nor
crash it, and no accepted ADR is edited to say so.

`ValidateConfig.noJev` is typed `unknown` for the same reason: the declared type is not the runtime truth, and the
type now says the guard exists. The schema keeps `Type.String({ minLength: 1 })` — it still refuses `""` and
non-stringifiable values, and it is the description the model reads — but it is a **declaration**, not the
guarantee.

### 2. The guarantee is pinned where it holds

- `src/__tests__/dispatch-line.test.ts` pins the coercion itself, through the real `validateToolArguments`:
  `true`/`false`/`42` → text (accepted by the schema), `""`/`{}`/`[]` → refused — and then feeds the coerced text
  to `validatePreTask` and requires the missing-line error.
- The same file pins each refusal shape at the handler (coerced primitives, `""`, whitespace-only,
  `{}`/`[]`/`42`/`true` as `unknown`), the genuine reason as the surviving warning, and the opt-in: with no
  `processChecks` the same value is inert.
- `src/__tests__/dispatch-line-enforcement.test.ts` drives the real `delegate_task` handler: a coerced boolean and
  a non-string reason are both `isError` with nothing spawned.

### 3. Semantics unchanged

The bypass still downgrades ONLY the line check (capability conflicts still reject), still surfaces the reason as
a warning, still applies only under the project's `processChecks` opt-in, and still bypasses nothing else. The
schema's declared shape, `KNOWN_DELEGATE_KEYS`, the retry carry-over, and every pre-spawn path are untouched.

## Consequences

- `noJev: true` (and any bare number) is refused as a missing line: the reason must be stated in words, which is
  the whole point of the bypass.
- A non-string, non-coercible value produces a clean validation error — the `TypeError` class of crash is gone.
- A guard at the handler is a weaker-looking place than a schema, and that is the honest description: the schema
  runs on the model's arguments, the handler runs on whatever actually arrives. Documentation and pins now say
  which is which.
- The bypass's guarantee is maintainer-facing (the read is behind `processChecks`), so no user-visible behaviour
  changes; a user's `noJev` is never examined.
- A future bypass-shaped parameter inherits this lesson: a `minLength` on a coerced string is an intent, not a
  check. If the value is a *reason*, validate it where it is read.
