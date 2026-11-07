# Repro — issue #449: a settled background run with no assistant output is not a success

Minimal reproduction of the false success fixed by #449. It drives the **real** pi 1.5.0 SDK
(`AgentSession`, the anthropic-messages wire code, real HTTP + SSE parsing) and the **real**
`spawnBackgroundSession` against a **loopback** fake provider. No vendor endpoint is contacted, no
credentials are real, no paid inference happens.

Baseline triage (how the path was found): `../../issue-449-triage-2026-11-07.md`.

## What it demonstrates

A provider turn that stops with `stop_reason: "max_tokens"` while reporting fewer output tokens than the
catalog's `maxTokens` is classified by the SDK as a *recoverable length*: it omits the assistant message
from the model projection (`_omitRecoveryAttempt`) and then attempts a compact-and-retry. On a branch too
young for `prepareCompaction` to find anything, that retry never runs — so the omission stands and
`prompt()` still **resolves**.

Before the fix, the extension read that projection, found no assistant message, saw an `undefined`
stopReason and recorded a **success**. Measured pre-fix record (this script, before the change):

```
agentStatus: completed · exitCode: 0 · usageTurns: 0 · finalOutput: ""
run entry:   status "done" · stopReason "stop" · no errorCategory
run entries: ["running", "done"]
```

After the fix, the same run records a **failure**:

```
agentStatus: failed · exitCode: 1
run entry:   status "failed" · errorCategory "incomplete"
error:       Run settled with no assistant output — the provider's response may have been truncated
             and omitted by the SDK (see #449)
run entries: ["running", "failed"]
```

The guard is **structural, not diagnostic**: the omitted message is gone, so it cannot distinguish a
truncation omission from any other resolve-with-no-assistant-message, and it does not prove truncation.

## Isolation — the invocation is the evidence

`env -i` and `PI_OFFLINE=1` are **not** sufficient on their own:

- `env -i … node -p 'os.homedir()'` still prints the **real** home, and the SDK derives its config/auth
  paths from it;
- `PI_OFFLINE` only disables *startup* network operations, not provider calls.

So the invocation must set a scratch `HOME` **and** a scratch `PI_CODING_AGENT_DIR`, use fake
credentials (`models.json` carries `sk-probe-not-real`), and point the provider at a **loopback-only**
base URL (`http://127.0.0.1:<port>`, chosen by the script). The script fails closed when `HOME` or
`PI_CODING_AGENT_DIR` is not the scratch path — verified: with `BRL449_SCRATCH` set but `HOME` left
real, it exits with `HOME is not the scratch home (/home/azmeen) — refusing to run`.

```bash
SCRATCH=/tmp/brl449-repro
mkdir -p "$SCRATCH"/{home,agent,cwd,store}

cd <repo root>
env -i \
  PATH=/usr/sbin:/usr/local/bin:/usr/bin:/bin \
  HOME="$SCRATCH/home" \
  PI_CODING_AGENT_DIR="$SCRATCH/agent" \
  BRL449_SCRATCH="$SCRATCH" \
  PI_OFFLINE=1 \
  TMPDIR=/tmp \
  VITE_CONFIG_NATIVE_IGNORE_WARNING=true \
  npx vitest run --config .development/investigations/repro/issue-449/vitest.config.mts
```

Run from a tree with `node_modules` installed; the SDK version is the one in that `node_modules`
(`@earendil-works/pi-coding-agent@1.5.0` here). The repro sits outside `src/__tests__`, so the shipped
suite never picks it up and the test-budget walker never counts it.

## Observed criterion — what a passing run must print

1. **SDK half** — `message_end` for that turn with `stopReason: "length"`, the prompt **resolved**, and
   **zero** assistant messages in the projected session:

   ```
   OBSERVED {"settled":"resolved","messageEnds":[{"role":"assistant","stopReason":"length"}],
             "providerHits":1,"assistantCount":0,"roles":["system","user"]}
   ```

2. **Production half** — the persisted record says failure, with no `done` entry:

   ```
   RECORD { "agentStatus": "failed", "exitCode": 1, "usageTurns": 0, "runStatus": "failed",
            "runStatuses": ["running","failed"], "runErrorCategory": "incomplete",
            "runErrorMessage": "Run settled with no assistant output — … (see #449)",
            "persistedStatus": "failed" }
   ```

A script that merely exits 0 is not evidence; both printed blocks are asserted, and each number in them
is one half of the criterion.

## Upstream note

pi resolves successfully after its own recovery attempt did not run (`_checkCompaction` →
`_runAutoCompaction(... willRetry=true)` → `false`). This reproducer is the report's evidence;
`node_modules` is not patched here, and the scope of any upstream report is a follow-up decision.
