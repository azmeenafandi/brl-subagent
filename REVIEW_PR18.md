# Adversarial Review — PR #18: SDK contract tests

**Branch:** `test/sdk-contract` · **HEAD:** `9614f4d` ("test: contract tests for pi SDK ModelRegistry auth APIs")
**Scope reviewed:** `src/__tests__/sdk-contract.test.ts` (new file, +131 lines) against `origin/main`.
**Verification performed:** source reading, pi SDK source/d.ts inspection (0.79.8 → 0.83.0), live test runs, and fault-injection experiments (prototype mutation) on the real SDK.

---

## Verdict

**Approve with comments.** The tests import and exercise the real SDK (no mocks), and empirically fail on SDK drift. The suite is fast (~1.5 s) and deterministic in CI. One real problem: **3 of the 11 tests are environment-sensitive** — they fail on any machine with `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_OAUTH_TOKEN`) set, even though the SDK contract is intact. A second, minor problem: the header comment overstates version stability (the test file only works on pi ≥ 0.80.10, and the constructor contract changed at 0.80.10).

---

## 1. Do the tests import the REAL ModelRegistry (not a mock)?

**Yes — fully real, verified end-to-end.**

- `import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"` resolves to the real package (root export exists in 0.83.0: `export { ModelRegistry } from "./core/model-registry.ts"`).
- No `vi.mock`, no stubs, no test setup files in `vitest.config.ts`.
- `createRealRegistry()` builds `new ModelRegistry(runtime)` over a real `ModelRuntime.create(...)`, and the prototype assertions run against the actual class from `node_modules`.
- I confirmed the "silent revert" gap the PR describes: `src/__tests__/model-availability.test.ts` has 15 tests, all with `ModelRegistryLike` mock shapes — so nothing previously pinned the real SDK surface. The gap was real.
- Isolation is sound: `modelsPath: null` → `ModelConfig.load(undefined)` returns an empty config (verified in `model-config.js`); the default `join(getAgentDir(), "models.json")` branch is never evaluated (ternary short-circuits on `null`); `authPath` points at a throwaway `mkdtemp` dir; `allowModelNetwork` defaults to `false` so the create-time refresh makes no network calls. The "never touches real `.pi` state" claim holds.

## 2. Do the 11 tests meaningfully guard against SDK drift?

**Yes — verified by fault injection.** I ran scratch copies of the suite with prototype mutations on the real class:

| Simulated drift | Result |
|---|---|
| Delete `hasConfiguredAuth` from `ModelRegistry.prototype` | **2 tests fail** (prototype-surface test; direct-call test) |
| Delete `hasConfiguredAuth` **and** `getProviderAuthStatus` (the full "silent revert to catalog-only" scenario) | **3 tests fail** — including the e2e negative test |

Key observations:

- The e2e *negative* test ("rejects a catalog model whose provider has no configured auth") is the one that catches the full silent-revert; the e2e *positive* test passes in that scenario (catalog-only fallback returns `true`, which is what it expects). That is expected fallback behavior, and the loss is covered by the other three guards — but it means the positive e2e test alone would be a weak guard. It *does* pin the auth path semantics when present (if `hasConfiguredAuth` returned `false` for a configured provider, `modelIsAvailable` → `false` → test fails).
- `modelIsAvailable`'s fallback chain (`hasConfiguredAuth` → `getProviderAuthStatus` → catalog-only) is fully exercised: the direct-call test pins `hasConfiguredAuth` independently of the fallback, so a rename is not masked.
- Signature drift (e.g., a method that silently starts keying on a different argument) would be caught by the positive e2e test: `hasConfiguredAuth(model)` on a configured provider would return `false`/throw → `modelIsAvailable` returns `false` → assertion fails.
- `find`/`getAll` shape assertions (`provider`/`id` strings, `undefined` for unknown model, non-empty array) pin the `ModelRegistryLike` subset `model-availability.ts` relies on.

## 3. Any test that could pass vacuously?

**No material vacuous passes found.** Specific checks:

- `expect(typeof status).toBe("object")` would also pass for `null`, but the immediately-following `status!.configured` dereference throws on `null` → test fails. Not vacuous.
- The `getAll()` loop asserts every element; `models.length > 0` guards the empty-array case.
- `find` assertions verify both presence and the unknown-model `undefined` contract.
- No shared/stale state across tests: each test builds its own registry and asserts on objects derived from it in the same test.
- One soft spot (not vacuous, but weaker than it looks): the positive e2e test passes in the full-revert scenario, as shown above. If it is ever the *only* remaining guard after refactoring, drift could slip through — but today the negative e2e + prototype + direct-call tests close that hole.

## 4. Is importing ModelRegistry from the package root stable across pi versions (0.79–0.83)?

**The `ModelRegistry` *export* is stable; the *construction contract* is not — the tests only work on pi ≥ 0.80.10.**

I inspected the pnpm store for every cached version (0.79.8, 0.79.9, 0.80.2, 0.80.3, 0.80.6, 0.80.10, 0.82.0, 0.82.1, 0.83.0):

- **Root export:** `export { ModelRegistry }` present in *all* versions, with an identical method surface (`find`, `getAll`, `hasConfiguredAuth`, `getProviderAuthStatus`).
- **But:** `ModelRuntime` is only exported from the root at **0.80.10+**. In 0.79.x–0.80.6 the import `import { ModelRuntime }` would be `undefined` → the whole file fails.
- **And:** the `ModelRegistry` constructor changed at 0.80.10 — from `constructor(authStorage, modelsJsonPath)` (0.79.x–0.80.6, a self-loading class) to `constructor(runtime: ModelRuntime)` (0.80.10+). `new ModelRegistry(runtime)` would construct a broken registry on older versions even if it compiled.

In practice this is a non-issue for CI: `devDependencies` are `^0.83.0` (npm caret on a 0.x version = `<0.84.0`) and `package-lock.json` pins exactly **0.83.0**, so `npm ci` in CI always tests 0.83.0. But the file's header comment ("pin the contract … across versions" implication) overstates coverage: the tests pin the contract of *whatever version is installed at test time*, not a range. Note also that a user's real pi installation may run a different pi version than the repo's devDeps; the tests only pin the dev-time SDK.

## 5. Do the tests add CI value without being flaky?

**CI value: yes. Flakiness: one real risk (environment credentials), plus two minor ones.**

- **Deterministic in CI:** clean `ubuntu-latest` runner, no provider env vars, no network needed (`allowModelNetwork` defaults to `false`; verified in `model-runtime.js`), lockfile-pinned SDK. Full file runs in **1.49 s** (409 ms of test time) locally.
- **⚠ Environment-sensitive (the main finding):** three tests hard-code the expectation that the anthropic provider is *unconfigured*:
  1. "`hasConfiguredAuth(model)` … returns a boolean" (expects `false`)
  2. "`getProviderAuthStatus(provider)` returns `{ configured: boolean }`" (expects `configured === false`)
  3. "rejects a catalog model whose provider has no configured auth" (expects `modelIsAvailable === false`)

  `ModelRuntime`'s auth snapshot is populated from `checkAuth`, which resolves environment credentials (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_OAUTH_TOKEN` in `pi-ai/dist/env-api-keys.js`). I ran the suite with `ANTHROPIC_API_KEY=sk-test-12345` and **3 tests failed** — red suite on a perfectly intact SDK contract. Anyone developing pi extensions is likely to have such a key exported; CI would stay green while local runs break. **Fix suggestion:** scrub the provider env vars for these tests (`delete process.env.ANTHROPIC_*` in `beforeAll`, or `vi.stubEnv`), or make the negative-auth assertions conditional on the env being clean.
- **Model-id pin:** `CATALOG_MODEL = { provider: "anthropic", id: "claude-sonnet-4-5" }` exists in 0.83.0's bundled `anthropic.json` (verified), but pi's catalog churns between releases — a future pi bump could drop/rename the model and fail `find`/e2e tests for reasons unrelated to the SDK contract. Suggest deriving the model from the live catalog (e.g., first entry of `getAll()` for a chosen provider) rather than hard-coding an id.
- **Temp-dir hygiene:** `mkdtemp` dirs (containing a fake `auth.json`) are never removed — I confirmed leftover `brl-sdk-contract-*`/`brl-scratch-*` dirs in `/tmp` after runs. Harmless but untidy; an `afterAll` rm would fix it.
- **Not flaky:** no timing sensitivity (30 s vitest timeout vs ~1.5 s runtime), no network, no cross-file state, no shared registries.

---

## Recommendations (non-blocking)

1. **Blocking-ish:** neutralize the environment-credentials dependency (scrub `ANTHROPIC_*` env vars in the test, or guard the three negative-auth assertions on a clean env) — otherwise the suite is green-in-CI / red-locally for a large class of developers.
2. Derive `CATALOG_MODEL` from the live registry catalog instead of hard-coding `claude-sonnet-4-5`.
3. Correct the header comment's version-stability claim (works on ≥ 0.80.10; constructor contract changed at 0.80.10; tests pin the installed version, currently exactly 0.83.0 via lockfile).
4. Clean up `mkdtemp` dirs in `afterAll`.
5. Consider a `afterEach`-free note: each `createRealRegistry()` runs a full per-provider auth sweep (6 registries per suite) — fine today (~400 ms), but worth knowing if pi ever makes `checkAuth` more expensive.

## Evidence trail

- `git diff origin/main..HEAD` → single new file, 131 lines, no source changes.
- 0.83.0 SDK sources: `model-registry.js` (facade over runtime), `model-runtime.js` (`create()`, `hasConfiguredAuth` via snapshot, `setRuntimeApiKey`, `getProviderAuthStatus`), `model-config.js` (`load(undefined)` → empty config), `models.js` (`checkAuth` resolves env credentials).
- pnpm store inspection of pi-coding-agent 0.79.8–0.83.0 (`dist/index.d.ts` exports, `model-registry.d.ts` surface, constructor signatures).
- `npx vitest run src/__tests__/sdk-contract.test.ts` → 11/11 pass, 1.49 s.
- Fault injection (scratch test, deleted afterwards): `hasConfiguredAuth` removed → 2 failures; both auth methods removed → 3 failures.
- `ANTHROPIC_API_KEY=sk-test-12345 npx vitest run …` → 3 failures (env sensitivity demonstrated).
- Working tree clean after review (scratch file removed; no source modified).
