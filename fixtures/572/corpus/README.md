# #572 corpus — transport deaths, one record per branch

Eleven run-store snapshots, each pinning ONE branch of the death predicate
(`.pi/skills/worktree/sprint-metrics.py`, `is_transport_death`). They are **synthetic on
purpose**: the measured store (1,565 records, 2026-11-22) exercises only four of the
branches — 0 records carry `originalParams`, 0 carry a top-level `errorMessage`, and 0
change class when `result.stderr` is read — so the branches that decide the dangerous
directions cannot be reached from real data. A field the store writes as epoch
milliseconds is written here as epoch milliseconds; a field the store omits is omitted,
not nulled.

Window for every assertion: `--since 2026-11-22T00:00:00Z --until 2026-11-22T12:00:00Z`.

| file | `description` | status | category (result / originalParams) | message | attempt / resumeOf | `startedAt` | branch it pins |
|---|---|---|---|---|---|---|---|
| `a.json` | L1 | failed | `exit_error` / — | `Connection error.` | 1 | 01:00Z | a death (the SDK's own wording) |
| `b.json` | L1 | failed | `exit_error` / — | `fetch failed` | 1 | 02:00Z | a death (signature #5) |
| `r.json` | L1 | failed | `exit_error` / — | `socket hang up` | **2 / `a`** | 03:00Z | a retry that died again (retried + died again) |
| `c.json` | L2 | failed | `exit_error` / — | `ECONNRESET` | 1 | 04:00Z | case-insensitivity (`econnreset`) |
| `out.json` | L2 | failed | `exit_error` / — | `ETIMEDOUT` | 1 | **21 Nov 23:00Z** | a death OUTSIDE the window: never counted |
| `plain.json` | L3 | failed | `exit_error` / — | `boom` | 1 | 05:00Z | right class, no signature: not a death |
| `wrongcat.json` | L4 | failed | **`tool_error`** / — | `Connection error.` | 1 | 06:00Z | right signature, wrong class: not a death |
| `stderr.json` | L5 | failed | `exit_error` / — | *(empty)* `stderr: Connection error.` | 1 | 07:00Z | the signature lives ONLY in `stderr`: not a death |
| `params.json` | L6 | failed | **absent / `exit_error`** | `fetch failed` | 1 | 08:00Z | the legacy `originalParams.errorCategory` fallback: a death |
| `nostart.json` | L7 | failed | `exit_error` / — | `network error` | 1 | **absent** (no `completedAt` either) | no timestamp at all: `window unknown` |
| `bad.json` | — | — | — | — | — | — | a truncated write: `unreadable` |

`nostart.json` carries **neither** timestamp. It is the D1 rule read strictly — `startedAt`,
else `completedAt`, else `window unknown` — and §3's expected output is only reachable that
way: a `completedAt` alone would put it inside the window and make it a sixth death.

## The arithmetic (all of it)

```
transport: 5 death(s) in 8 record(s) in window · retried: 1 · died again: 1 · window unknown: 1 · unreadable: 1 · resume unknown: 0
transport by label (>= 2 deaths): L1 3
labels with exactly 1 death: 2 (not listed)
```

* denominator **8** = the in-window readable records (`a b r c plain wrongcat stderr params`);
  `out` is outside the window, `nostart` is window-unknown, `bad` is unreadable;
* deaths **5** = `a b r c params`; L1 3 · L2 1 · L6 1, so one label is listed and two are singletons;
* `retried` 1 = `r` (attempt 2, `resumeOf: "a"`), and it is itself a death → `died again` 1.

## Replay

```
python3 .pi/skills/worktree/sprint-metrics.py --transport \
  --since 2026-11-22T00:00:00Z --until 2026-11-22T12:00:00Z \
  --records fixtures/572/corpus
```

`--selftest` asserts the same three lines from this directory (7 of its cases), so a
mutation of the predicate fails a named case instead of a reading nobody re-derives.
