# 0010. Distribution: npm-only installs, staged OIDC releases

- **Status:** Accepted
- **Date:** 2026-09-12
- **Issues:** #158, #160, #162, #164, #171

## Context

The extension used to be git-installable and was synced into pi's store by a script, but a pinned git ref never advanced on `pi update --extensions`. The shipped capability reference (AGENT.md) was omitted from the package, and the update notifier duplicated pi's own notice.

## Decision

- npm is the sole user-facing install/update path (`pi install npm:brl-subagent`).
- `publish.yml` publishes via OIDC trusted publishing with staged releases the maintainer approves.
- `peerDependencies` declare the pi-provided packages so `--omit=dev` consumers resolve.
- Shipped docs are pinned to `package.json` (README version line) by a test.

## Consequences

- `sync-extension.sh` was retired — daily use runs the published package; development uses a local-path install.
- No long-lived npm token exists.
- A forgotten version inventory fails CI instead of shipping quietly.
