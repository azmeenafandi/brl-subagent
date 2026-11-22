#!/usr/bin/env python3
"""
sprint-metrics.py — the Trust Protocol / Rule 11 extractor (sprint_process_improvements.md).

Derives metrics mechanically from the pi session log — figures are computed, never
vibed. Terminology: cycles were historically called "sprints" in this tool and its
artifacts (`--sprint`, the "Sprint" column) — read every "sprint" as cycle.

Windows are TRUE timestamps: a time-suffixed --since/--until filters to the instant
(so a window can end exactly at a cycle's declaration); a date-only bound is
inclusive of its whole day; naive bounds are read as UTC.

Usage:
  python3 sprint-metrics.py [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--log <path>]
                            [--spawn-log <path>] [--out .development/METRICS.md]
                            [--sprint "2026-08-16"]
  python3 sprint-metrics.py --candidates <path> [--sprint <cycle>] [--since ..] [--until ..]
  python3 sprint-metrics.py --transport [--records <dir>] [--signatures <path>] [--limit N]
  python3 sprint-metrics.py --selftest   # window-boundary + reconcile + candidates guard (CI-wired)

Defaults: --since = today-1 day (covers the current sprint's work), --log = every session
log for this project, --spawn-log = <cwd>/.pi/subagent-logs/brl-subagent.log
(plus its rotated `.1`..`.5`), --out = none (print only).

Data sources (all automatic, no human entries):
  - delegate_task toolCall events       → dispatch count, fg/bg ratio, retry rate
  - codemode toolCalls whose script     → dispatch count (issue #489: a dispatch issued
    text calls delegate_task(              from inside a codemode script is a codemode
                                           toolCall, so the direct scan could not see it)
  - the extension spawn log             → the authoritative run-start count, reconciled
    (<cwd>/.pi/subagent-logs/)             against the dispatch count as `Δ`
  - brl-subagent-run custom entries     → success/failed/stopped rates, retry success,
                                          zero-work rate (done + empty fullOutput)
  - get_subagent_result toolCall events → polling frequency (babysitting proxy)
  - <cwd>/.pi/subagents/<id>.json     → transport deaths per label (issue #572), only when
                                         the run store exists (see below)

Friction candidates (issue #574; `--candidates <path>`): the six kinds — `failed`,
`deadline`, `retry` (via transport or explicit), `stop`, `steer` — derived from the
two logs and written as the consumer-v1 payload `scripts/friction-disposition.mjs`
reads. Every candidate cites the PHYSICAL source line (`session-log:<file>:<line>`)
and that line's sha256 prefix, so the close can re-read its evidence. Candidates
mode REFUSES (exit 2, no file written) when a session or spawn source is missing or
unreadable: a derived figure with no evidence behind it is worse than none. The
legacy metrics path still fails open on a missing log.

Transport deaths (issue #572) — the figure the close must not have to ask for. A settled
run's death CLASS is not in the session log: `status`, `result.errorCategory`,
`result.errorMessage`, `attempt` and `resumeOf` are in the run store's per-run snapshots,
so this is the file's SECOND source, read only when that directory exists. The predicate
is the stored-record mirror of `isTransportFailure`, and its signature list is READ FROM
`src/transport-retry.ts` at runtime — a source that no longer parses REFUSES (exit 2)
rather than classifying nothing.

The asymmetry between the two paths is deliberate and is the whole design:

  DEFAULT   when `<cwd>/.pi/subagents` exists and is readable, the report gains ONE line
            (`transport: N death(s) in M record(s) in window · …`). Absent or unreadable →
            the line is OMITTED and every other byte of the report is unchanged: CI and a
            plain clone have no run store, and a missing directory there is normal.
  --transport  adds the per-label block (labels at >= 2 deaths, then the singleton count)
            and REFUSES a missing or empty directory: a metric over no records is not zero
            deaths. It also refuses `--out` — the 11-column METRICS.md schema is a
            migration this unit does not own, so the mode may never write a table row.

Every figure is scoped by `--since/--until` on the record's `startedAt` (then
`completedAt`); a record with neither is counted as `window unknown`, never dropped, and
one unparsable record is counted as `unreadable`, never skipped.

Exit codes: 0 ok · 1 no session logs (metrics) · 2 selftest failure, a missing
candidates source, or a refused transport reading · 3 reconcile failed.

Dispatch counting rules (issue #489):
  - A codemode toolCall counts one dispatch per CALL-SHAPED occurrence of
    `delegate_task(` in its script (a `Promise.all([...])` fan-out is two).
  - Comments are stripped first (whole-line `//` and `/* ... */`), so a commented-out
    call does not count, and prose that merely mentions `delegate_task` does not either
    (the paren is required). A `delegate_task(` inside a STRING still counts; the
    reconcile is what catches it — a false positive drives Δ negative, which fails loud.
  - The explicit `background: true|false` in the script decides the route's fg/bg. A
    codemode call with no explicit flag is counted background and reported as assumed,
    because its effective value comes from the approval mode, which the script cannot see.
  - template/preset/mode counters stay direct-only: they are not reliably parseable out
    of a JS script, so those columns remain floors.

Refused, unresolved and failed-after-spawn direct dispatches (issue #591 §2). A `delegate_task`
CALL is not proof that a child started, and `isError: true` is not proof that it did not: a
foreground dispatch whose child dies after spawning ("Subagent failed: Subagent timed out …")
carries `isError: true` too, and that IS a spawn. So a direct call is classified THREE ways, by
a second pass over the whole file set (`load_call_results`, keyed by call id, file order
irrelevant — a result usually lands AFTER the call it answers, and a result that precedes its
call is the same lookup):

  isError: true + the harness's pre-flight dialect → REFUSED — excluded from dispatches, the
                    fg/bg split and the retry rate, and counted so the exclusion is auditable
  isError: true + anything else                   → COUNTED as a dispatch and as a spawn, and
                    reported as `failed after spawn` (a run started and then failed)
  isError: false                                  → a dispatch
  no result                                       → a dispatch, counted `unresolved` (a log
                    truncated mid-run is not a refusal, and silently dropping the call would
                    under-count dispatches)

THE DIALECT IS THE ONLY HEURISTIC IN THIS FILE (`PREFLIGHT_REFUSAL_PHRASES`, next to the code,
maintained by hand). It exists because the log carries no "spawned" flag — only the result's
booleans and its text — and the two directions have different costs: a phrase that FAILS to
match leaves the call counted, so a miscount surfaces as a negative Δ, which fails loud; a
phrase that wrongly matches HIDES a real spawn, under-counting in the one direction the Δ
cannot see. The list is drawn from the measured corpus, and each entry cites the shape behind
it; the fixture that pins the other direction is the `failed after spawn` self-test case.

Over-counting refused calls produced the measured 15-against-14 window this issue was filed on
(#591 §0 row 2) — and over-excluding would have hidden 7 real runs: the default 18-file corpus
holds 44 `delegate_task` results with `isError: true`, 37 in the pre-flight dialect and 7
"Subagent failed: Subagent timed out" (measured 2026-11-22). Codemode-routed dispatches keep
their floor semantics: the script's text is all the log carries, and one script error does not
prove its calls did not run.

LIMIT, stated rather than implied: `isError: false` is NOT proof that a child spawned. The
runtime ignores returned error metadata on some refusal paths (`src/types.ts`), so a returned
pre-flight error can be recorded false and still count as a dispatch. The exclusion keys on the
only signals the log carries, and the reconcile's Δ against the extension spawn log remains the
check — this pass narrows the gap, it does not close it.

Reconcile (issue #489): `dispatches: N (direct A + codemode B) · spawns: M · Δ D`, where
M is the extension log's run-start count in the SAME window and D = M - N. Spawns may
legitimately exceed calls by the window's transport auto-retry starts plus its fan-out
units beyond the first; both are counted, so the allowance is derived, not guessed.
A negative Δ (a counted dispatch produced no spawn) or a Δ above that allowance is a
LOUD failure: a named `RECONCILE FAILED:` line, no row appended, exit 3. The line also names
`refused: N` / `failed after spawn: N` / `unresolved: N` / `duplicate: N` when (and only when)
they are non-zero, so a window with no such call prints exactly what it always printed.

The output table is designed to be appended to .development/METRICS.md (one row per
sprint — the only manual step, sharing the friction-log review cadence).
"""

import argparse
import glob
import hashlib
import json
import os
import re
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT = "public_projects-brl-subagent_workspace"  # session dir name uses '-' separators
SESSION_GLOB = os.path.expanduser(
    f"~/.pi/agent/sessions/*{PROJECT}*/*.jsonl"
)

# The extension's spawn log (issue #489). It is cwd-local: it lives where the
# extension runs (the cockpit), so a worktree does not have one and the reconcile
# reports itself unavailable rather than printing a clean Δ.
SPAWN_LOG_REL = os.path.join(".pi", "subagent-logs", "brl-subagent.log")
SPAWN_LOG_ROTATED = 5  # src/logging.ts keeps brl-subagent.log.1 .. .5
BG_SPAWN_MESSAGE = "Background agent spawned"
FG_SPAWN_MESSAGE = "Starting subagent process"
RETRY_SPAWN_MESSAGE = "Background run settled — transport auto-retry scheduled"

# The harness's PRE-SPAWN refusal dialect (issue #591 §2), matched case-insensitively against the
# tool result's own text. MAINTAINED BY HAND — the only heuristic in this file, and it is used
# only to LABEL: a result it does not match stays COUNTED as a dispatch (`failed after spawn`),
# because hiding a real spawn is the error the reconcile cannot see. Each entry cites the shape
# behind it with the count measured in the default 18-file corpus (44 `delegate_task` results with
# `isError: true`, 2026-11-22), so a stale entry is visible rather than silent:
#   "missing jev dispatch line"      10 — the dispatch-line gate, before any spawn
#   "tool delegate_task not found"    9 — the tool was absent, so nothing spawned
#   "validation failed for tool"      4 — argument validation, before the handler
#   "invalid outputfile"              3 — the outputFile containment check
#   "invalid cwd"                     3 — the cwd containment check
#   "cannot delegate"                 2 — the capability pre-flight ('bash' not available)
#   "is not iterable"                 2 — a malformed argument list
#   "circuit breaker is open"         1 — the breaker refuses before dispatch
#   "provide exactly one of"          1 — mode validation
#   "graph validation failed"         1 — graph validation
#   "resolution failed"               1 — template/param resolution
#   "does not exist"                  — the bare path refusal (the same dialect as invalid cwd)
#   "invalid task" / "is not json"    — argument decoding (`Invalid task: … is not JSON`)
# NOT here on purpose, and measured: "Subagent failed: Subagent timed out …" (7 results) is a run
# that STARTED and then died — it is a dispatch and a spawn, and the self-test pins that case.
PREFLIGHT_REFUSAL_PHRASES = (
    "missing jev dispatch line",
    "tool delegate_task not found",
    "validation failed for tool",
    "invalid outputfile",
    "invalid cwd",
    "cannot delegate",
    "is not iterable",
    "circuit breaker is open",
    "provide exactly one of",
    "graph validation failed",
    "resolution failed",
    "does not exist",
    "invalid task",
    "is not json",
)

# Friction candidates (issue #574). A stop call OWNS the abort it caused inside
# this interval (inclusive both ends); the causal margin is loaded on both sides
# of a requested window so a join just outside it cannot change an inside
# classification (§2.1 R2/R6).
DEDUPE_MS = 2000
CAUSAL_MARGIN_MS = 2 * DEDUPE_MS
SESSION_SOURCE = "session-log"
SPAWN_SOURCE = "spawn-log"
CANDIDATE_VERSION = 1

# A codemode script is the only record of a codemode-issued dispatch, so the scan
# is textual — deliberately narrow: an identifier boundary (so `mydelegate_task(`
# does not match), an optional `tools.` receiver, and a required argument list.
_CODEMODE_CALL = re.compile(r"\b(?:tools\s*\.\s*)?delegate_task\s*\(")
_CODEMODE_BACKGROUND = re.compile(r"\bbackground\s*:\s*(true|false)\b")
# Whole-line `//` comments only: a `//` mid-line is not reliably a comment (a URL
# in a string, for one), and stripping it could hide a real call that follows.
_LINE_COMMENT = re.compile(r"^\s*//.*$", re.MULTILINE)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


def iso_ts(ts) -> str:
    """Normalize a log timestamp to ISO (they arrive as ISO strings)."""
    return str(ts or "")


def _parse_ts(value):
    """Parse an ISO date/date-time defensively; None when unparseable.

    A 'Z' suffix is normalized; a naive value is treated as UTC.
    """
    t = str(value or "").strip()
    if not t:
        return None
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _window_start(bound):
    """The inclusive lower instant of a window bound (None when unparseable).

    A date-only bound starts at 00:00:00 of its day; a time-suffixed bound IS the
    instant.
    """
    moment = _parse_ts(bound)
    if moment is None:
        return None
    if len(str(bound).strip()) <= 10:
        return moment.replace(hour=0, minute=0, second=0, microsecond=0)
    return moment


def _window_end(bound):
    """The inclusive upper instant of a window bound (None when unparseable)."""
    moment = _parse_ts(bound)
    if moment is None:
        return None
    if len(str(bound).strip()) <= 10:
        return moment.replace(hour=23, minute=59, second=59, microsecond=999999)
    return moment


def in_range(ts: str, since: str, until: str) -> bool:
    """True if ts falls in [since, until] — TRUE timestamp comparison.

    Bounds accept an ISO date or date-time: a date-only bound is inclusive of its
    whole day (since → 00:00:00, until → 23:59:59.999999); a time-suffixed bound
    filters to the instant. Naive bounds are read as UTC.

    History: the original compared `ts[:10]` against the raw bound STRING, so a
    time-suffixed bound silently excluded its whole day (v2.5.1: 22 dispatches
    counted vs 68 spawns). Bounds were first normalized to dates, then upgraded
    to true timestamps (2026-10-14).
    """
    t = _parse_ts(ts)
    start = _window_start(since)
    end = _window_end(until)
    if t is None or start is None or end is None:
        return False
    return start <= t <= end


# Boundary self-test (issue #336, Rule 11 mechanical guard).
#
# Each case is (name, ts, since, until, expected). The corpus pins the window
# parser's boundary behavior so a future refactor cannot silently re-introduce
# the v2.5.1 regression — a time-suffixed bound compared as a raw string and so
# dropping its whole day (22 dispatches counted vs 68 logged spawns).
SELFTEST_CASES = [
    # Date-only bounds are inclusive of the WHOLE day.
    ("date-only since includes day start", "2026-10-10T00:00:00Z", "2026-10-10", "2026-10-10", True),
    ("date-only until includes end of day", "2026-10-10T23:59:59.999999Z", "2026-10-10", "2026-10-10", True),
    ("date-only until excludes next day", "2026-10-11T00:00:00Z", "2026-10-10", "2026-10-10", False),
    # PRE-FIX REGRESSION SHAPE: a time-suffixed --since must NOT drop its own day.
    # Old code compared the raw bound "2026-10-10T02:00:00" against the stamp's
    # date prefix "2026-10-10" (lexicographically GREATER), excluding the day.
    ("time-suffixed since keeps its day (pre-fix regression)", "2026-10-10T05:00:00.000Z", "2026-10-10T02:00:00", "2026-10-13T12:00:00", True),
    ("time-suffixed since filters to the instant", "2026-10-10T01:59:59Z", "2026-10-10T02:00:00", "2026-10-13T12:00:00", False),
    # Inclusive ends: an instant exactly on a bound is inside the window.
    ("time-suffixed since inclusive of exact instant", "2026-10-10T02:00:00Z", "2026-10-10T02:00:00", "2026-10-13T12:00:00", True),
    ("time-suffixed until inclusive of exact instant", "2026-10-13T12:00:00Z", "2026-10-10T02:00:00", "2026-10-13T12:00:00", True),
    ("time-suffixed until excludes later instant", "2026-10-13T12:00:01Z", "2026-10-10T02:00:00", "2026-10-13T12:00:00", False),
    # Naive timestamps/bounds are read as UTC (not local time).
    ("naive timestamp read as UTC", "2026-10-10T05:00:00", "2026-10-10T04:00:00Z", "2026-10-10T06:00:00Z", True),
    ("naive bounds read as UTC", "2026-10-10T05:00:00Z", "2026-10-10T04:00:00", "2026-10-10T06:00:00", True),
    # Invalid / missing values never match (no silent default-to-include).
    ("invalid timestamp excluded", "not-a-timestamp", "2026-10-10", "2026-10-13", False),
    ("missing timestamp excluded", "", "2026-10-10", "2026-10-13", False),
    ("None timestamp excluded", None, "2026-10-10", "2026-10-13", False),
    ("invalid since bound excluded", "2026-10-10T05:00:00Z", "not-a-date", "2026-10-13", False),
    ("missing until bound excluded", "2026-10-10T05:00:00Z", "2026-10-10", "", False),
]


# Reconcile self-test (issue #489). Hermetic: every fixture is written to a temp
# dir, so a check never reads — or depends on — the real session logs or the real
# `.pi/subagent-logs`. Each case pins the two things that regressed by hand: a
# codemode-routed dispatch being invisible, and a spawn with no dispatch going
# unnoticed.
SELFTEST_TS = "2026-11-08T06:00:00.000Z"
SELFTEST_WINDOW = ("2026-11-08T00:00:00", "2026-11-09T00:00:00")


def _write_jsonl(path, entries):
    with open(path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")


def _tool_call(name, args, call_id, ts=SELFTEST_TS):
    return {"timestamp": ts, "message": {"content": [
        {"type": "toolCall", "id": call_id, "name": name, "arguments": args},
    ]}}


def _result_row(ts, call_id, is_error, text="", tool="delegate_task"):
    """A toolResult in the production envelope: `role` + `toolCallId` + `isError` + text.

    The TEXT matters for an error result (#591): the classifiers read it to tell a pre-flight
    refusal from a run that started and then failed, so a fixture with an empty text would
    pin a shape production never produces.
    """
    return {"type": "message", "timestamp": ts, "message": {
        "role": "toolResult", "toolCallId": call_id, "toolName": tool,
        "content": [{"type": "text", "text": text}], "isError": is_error}}


# The two measured result dialects (#591 §2). REFUSAL_TEXT is a real pre-flight rejection
# (the dispatch-line gate, 10 occurrences in the corpus); DIED_TEXT is a real failure AFTER
# the spawn (7 occurrences) and must stay COUNTED.
REFUSAL_TEXT = ("missing Jev dispatch line: missing Jev dispatch line "
                "(jev: <level> (<0.xx>) · C<1|2|3> · worktree <y|n>)")
DIED_TEXT = "Subagent failed: Subagent timed out after 600000ms"
OTHER_REFUSAL_TEXT = ('Invalid outputFile: Output file path "/x/SPEC.md" escapes the project '
                      'root. Must be within the project directory.')


def _spawn(agent_id):
    return {"timestamp": SELFTEST_TS, "level": "info", "prefix": "brl-subagent",
            "message": BG_SPAWN_MESSAGE, "data": {"agentId": agent_id}}


def _retry():
    return {"timestamp": SELFTEST_TS, "level": "info", "prefix": "brl-subagent",
            "message": RETRY_SPAWN_MESSAGE, "data": {"agentId": "agent-1"}}


# (name, session entries, spawn entries, expected direct, expected codemode,
#  expected spawns, expected reconcile ok)
RECONCILE_SELFTEST_CASES = [
    ("codemode-routed dispatch reconciles",
     [_tool_call("delegate_task", {"task": "x", "background": True}, "direct-1"),
      _tool_call("codemode",
                 {"code": "const d = await tools.delegate_task({ task: 'x', background: true });"},
                 "cm-1")],
     [_spawn("agent-1"), _spawn("agent-2")],
     1, 1, 2, True),
    ("a spawn with no session-log dispatch fails loud",
     [_tool_call("delegate_task", {"task": "x", "background": True}, "direct-1")],
     [_spawn("agent-1"), _spawn("agent-2")],
     1, 0, 2, False),
    # The counting-rule pin: a commented-out call and prose that mentions the tool
    # are not dispatches. The paren is required and comments are stripped first.
    ("a commented-out delegate_task( is not a dispatch",
     [_tool_call("delegate_task", {"task": "x", "background": True}, "direct-1"),
      _tool_call("codemode",
                 {"code": "// tools.delegate_task({ task: 'x' });\n"
                          "const note = 'the delegate_task execute is 1,200 lines';"},
                 "cm-1")],
     [_spawn("agent-1")],
     1, 0, 1, True),
    # The span rule: a stray `background: false` before the call must not flip it.
    ("a stray background flag outside the call is not attributed to it",
     [_tool_call("delegate_task", {"task": "x", "background": True}, "direct-1"),
      _tool_call("codemode",
                 {"code": "const note = 'set background: false';\n"
                          "await tools.delegate_task({ task: 'x' });"},
                 "cm-1")],
     [_spawn("agent-1"), _spawn("agent-2")],
     1, 1, 2, True),
    # The allowance's two legitimate shapes: one call, N spawns (a `tasks` fan-out)
    # and a transport auto-retry start, which has no dispatch call at all.
    ("a tasks fan-out raises the allowance by its extra units",
     [_tool_call("delegate_task", {"task": "x", "background": True,
                                  "tasks": [{"task": "a"}, {"task": "b"}]}, "direct-1")],
     [_spawn("agent-1"), _spawn("agent-2")],
     1, 0, 2, True),
    ("a transport auto-retry raises the allowance by one start",
     [_tool_call("delegate_task", {"task": "x", "background": True}, "direct-1")],
     [_spawn("agent-1"), _spawn("agent-2"), _retry()],
     1, 0, 2, True),
]


def metrics_for(session_entries, spawn_entries, window=SELFTEST_WINDOW):
    """(metrics, reconcile ok, reason, dispatch line) for one fixture pair in a temp dir.

    One runner for both selftest families: the dispatch classification reads
    `load_call_results`, exactly as the CLI does, so a case cannot pass on a fixture the
    production two-pass read would classify differently.
    """
    with tempfile.TemporaryDirectory() as tmp:
        session_path = os.path.join(tmp, "session.jsonl")
        spawn_path = os.path.join(tmp, "spawn.log")
        _write_jsonl(session_path, session_entries)
        _write_jsonl(spawn_path, spawn_entries)
        m = compute(load_events([session_path], *window), load_call_results([session_path]))
        ok, reason = reconcile(m, [spawn_path], *window)
        return m, ok, reason, fmt_dispatches(m)


def run_reconcile_case(case):
    """Run one reconcile fixture in a temp dir; return (ok, line, reason, problems)."""
    _name, session_entries, spawn_entries, exp_direct, exp_codemode, exp_spawns, exp_ok = case
    m, ok, reason, line = metrics_for(session_entries, spawn_entries)
    problems = []
    if m["direct"] != exp_direct:
        problems.append(f"direct {m['direct']} != {exp_direct}")
    if m["codemode"] != exp_codemode:
        problems.append(f"codemode {m['codemode']} != {exp_codemode}")
    if m["spawns"] != exp_spawns:
        problems.append(f"spawns {m['spawns']} != {exp_spawns}")
    if ok != exp_ok:
        problems.append(f"reconcile ok {ok} != {exp_ok}")
    if not exp_ok and "under-count" not in reason and "over-count" not in reason:
        problems.append(f"the failure is not named: {reason!r}")
    return (not problems), line, reason, problems


# Dispatch-result self-test (issue #591 §2). The window fixture is the reconcile one, and the
# two instants are chosen for the boundary that matters: DISPATCH_TS is inside the window,
# LATE_TS is AFTER its end, so a map rebuilt from the window-filtered rows cannot see that
# result while the whole-file map does. Every case pins the counts AND the printed line — the
# line is the receipt a close gate reads, so a byte of it is part of the contract.
DISPATCH_TS = "2026-11-08T06:00:00.000Z"
RESULT_TS = "2026-11-08T06:00:01.000Z"
LATE_TS = "2026-11-09T06:00:00.000Z"
DIRECT_ARGS = {"task": "x", "background": True}

DISPATCH_SELFTEST_CASES = [
    # The defect: a refused call counted as a dispatch (15 against 14 spawns, #591 §0 row 2).
    {"name": "a refused dispatch is not a dispatch (isError: true, pre-flight dialect)",
     "session": [_tool_call("delegate_task", DIRECT_ARGS, "call-1", DISPATCH_TS),
                 _result_row(RESULT_TS, "call-1", True, REFUSAL_TEXT)],
     "spawn": [],
     "expect": {"direct": 0, "refused": 1, "failed_after_spawn": 0,
                "unresolved": 0, "duplicate_results": 0},
     "line": "dispatches:      0 (direct 0 + codemode 0) · refused: 1 (harness-rejected) · spawns: 0 · Δ 0"},
    # A second pre-flight shape, so the dialect is pinned by more than one phrase.
    {"name": "a refused dispatch in another pre-flight shape is refused too",
     "session": [_tool_call("delegate_task", DIRECT_ARGS, "call-1", DISPATCH_TS),
                 _result_row(RESULT_TS, "call-1", True, OTHER_REFUSAL_TEXT)],
     "spawn": [],
     "expect": {"direct": 0, "refused": 1, "failed_after_spawn": 0,
                "unresolved": 0, "duplicate_results": 0},
     "line": "dispatches:      0 (direct 0 + codemode 0) · refused: 1 (harness-rejected) · spawns: 0 · Δ 0"},
    # THE OTHER DIRECTION, and the correction that produced this case: `isError: true` is not
    # a refusal. A run that started and then died is a dispatch AND a spawn — excluding it
    # would hide a spawn, the one direction the Δ cannot see.
    {"name": "a failure AFTER the spawn stays counted as a dispatch",
     "session": [_tool_call("delegate_task", DIRECT_ARGS, "call-1", DISPATCH_TS),
                 _result_row(RESULT_TS, "call-1", True, DIED_TEXT)],
     "spawn": [_spawn("agent-1")],
     "expect": {"direct": 1, "refused": 0, "failed_after_spawn": 1,
                "unresolved": 0, "duplicate_results": 0},
     "line": "dispatches:      1 (direct 1 + codemode 0) · failed after spawn: 1 (counted as a dispatch) · spawns: 1 · Δ 0"},
    # A log truncated mid-run: the call happened, so dropping it would under-count.
    {"name": "a call with no result still dispatches, and says unresolved",
     "session": [_tool_call("delegate_task", DIRECT_ARGS, "call-1", DISPATCH_TS)],
     "spawn": [_spawn("agent-1")],
     "expect": {"direct": 1, "refused": 0, "failed_after_spawn": 0,
                "unresolved": 1, "duplicate_results": 0},
     "line": "dispatches:      1 (direct 1 + codemode 0) · unresolved: 1 (no result in the session log) · spawns: 1 · Δ 0"},
    # PARITY: an ordinary call/result pair prints the pre-#591 line, byte for byte.
    {"name": "an ordinary call/result pair prints the unchanged line",
     "session": [_tool_call("delegate_task", DIRECT_ARGS, "call-1", DISPATCH_TS),
                 _result_row(RESULT_TS, "call-1", False)],
     "spawn": [_spawn("agent-1")],
     "expect": {"direct": 1, "refused": 0, "failed_after_spawn": 0,
                "unresolved": 0, "duplicate_results": 0},
     "line": "dispatches:      1 (direct 1 + codemode 0) · spawns: 1 · Δ 0"},
    # A result lands AFTER `--until` (the normal case, not the exception): a window-filtered
    # map would call this one unresolved and count it as a dispatch.
    {"name": "a result after --until is still the call's result",
     "session": [_tool_call("delegate_task", DIRECT_ARGS, "call-1", DISPATCH_TS),
                 _result_row(LATE_TS, "call-1", True, REFUSAL_TEXT)],
     "spawn": [],
     "expect": {"direct": 0, "refused": 1, "failed_after_spawn": 0,
                "unresolved": 0, "duplicate_results": 0},
     "line": "dispatches:      0 (direct 0 + codemode 0) · refused: 1 (harness-rejected) · spawns: 0 · Δ 0"},
    # A reordered log (a compacted or replayed session): the result is written FIRST.
    {"name": "a result written before its call classifies the same",
     "session": [_result_row(RESULT_TS, "call-1", True, REFUSAL_TEXT),
                 _tool_call("delegate_task", DIRECT_ARGS, "call-1", DISPATCH_TS)],
     "spawn": [],
     "expect": {"direct": 0, "refused": 1, "failed_after_spawn": 0,
                "unresolved": 0, "duplicate_results": 0},
     "line": "dispatches:      0 (direct 0 + codemode 0) · refused: 1 (harness-rejected) · spawns: 0 · Δ 0"},
    # A producer bug worth seeing: two results for one call, last one wins, counted once.
    {"name": "a duplicate result is counted once and the last one wins",
     "session": [_tool_call("delegate_task", DIRECT_ARGS, "call-1", DISPATCH_TS),
                 _result_row(RESULT_TS, "call-1", False),
                 _result_row(LATE_TS, "call-1", True, REFUSAL_TEXT)],
     "spawn": [],
     "expect": {"direct": 0, "refused": 1, "failed_after_spawn": 0,
                "unresolved": 0, "duplicate_results": 1},
     "line": "dispatches:      0 (direct 0 + codemode 0) · refused: 1 (harness-rejected) · duplicate: 1 · spawns: 0 · Δ 0"},
]


def run_dispatch_case(case):
    """Run one dispatch-classification fixture; return (ok, line, problems)."""
    m, ok, reason, line = metrics_for(case["session"], case["spawn"])
    problems = [f"{key} {m[key]} != {want}" for key, want in case["expect"].items() if m[key] != want]
    if not ok:
        problems.append(f"reconcile failed: {reason}")
    if "line" in case and line != case["line"]:
        problems.append(f"line {line!r} != {case['line']!r}")
    return (not problems), line, problems


def run_selftest() -> int:
    """Exercise the window boundaries, the reconcile, the dispatch results, the candidates.

    The legacy 21 cases keep their names, order and pass line; the dispatch-result cases
    (#591) and the candidate checks (corpus + boundary fixtures) follow, so one command
    proves the extractor and the derivations it feeds (#574); the transport-death checks
    (#572) close the table on the corpus that pins the default report's line.
    """
    candidate_checks = run_candidate_selftest()
    transport_checks = run_transport_selftest()
    legacy_total = len(SELFTEST_CASES) + len(RECONCILE_SELFTEST_CASES)
    total = (legacy_total + len(DISPATCH_SELFTEST_CASES) + len(candidate_checks)
             + len(transport_checks))
    print(f"sprint-metrics --selftest: {len(SELFTEST_CASES)} boundary cases "
          f"+ {len(RECONCILE_SELFTEST_CASES)} reconcile cases "
          f"+ {len(DISPATCH_SELFTEST_CASES)} dispatch-result cases "
          f"+ {len(candidate_checks)} candidate cases "
          f"+ {len(transport_checks)} transport-death cases ({legacy_total} legacy)")
    failures = 0
    for name, ts, since, until, expected in SELFTEST_CASES:
        got = in_range(ts, since, until)
        ok = got == expected
        mark = "✓" if ok else "✗"
        print(f"  {mark} {name}: in_range({ts!r}, {since!r}, {until!r}) = {got} (expected {expected})")
        if not ok:
            failures += 1
    for case in RECONCILE_SELFTEST_CASES:
        ok, line, reason, problems = run_reconcile_case(case)
        mark = "✓" if ok else "✗"
        detail = f"{line} — {reason}" + (f" [{', '.join(problems)}]" if problems else "")
        print(f"  {mark} {case[0]}: {detail}")
        if not ok:
            failures += 1
    for case in DISPATCH_SELFTEST_CASES:
        ok, line, problems = run_dispatch_case(case)
        mark = "✓" if ok else "✗"
        detail = line + (f" [{'; '.join(problems)}]" if problems else "")
        print(f"  {mark} {case['name']}: {detail}")
        if not ok:
            failures += 1
    for name, ok, detail in candidate_checks:
        mark = "✓" if ok else "✗"
        print(f"  {mark} {name}: {detail}")
        if not ok:
            failures += 1
    for name, ok, detail in transport_checks:
        mark = "✓" if ok else "✗"
        print(f"  {mark} {name}: {detail}")
        if not ok:
            failures += 1
    status = "PASS" if failures == 0 else "FAIL"
    print(f"sprint-metrics --selftest: {total - failures}/{total} passed — {status}")
    return 1 if failures else 0


def strip_js_comments(code: str) -> str:
    """Drop whole-line `//` comments and `/* ... */` blocks from a codemode script.

    Mid-line `//` is deliberately left alone: it is not reliably a comment (a URL
    in a string literal), and stripping it could hide a real call after it. A
    block-comment false strip would hide a call instead of inventing one — the
    safe direction, because the reconcile then fails loud rather than quietly
    under-counting.
    """
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", code or ""))


def codemode_dispatches(code: str):
    """Classify a codemode script's dispatch calls: one entry per `delegate_task(`.

    Returns a list of `background` values — True/False when the script states the
    flag on that call, None when it does not. Counting OCCURRENCES (not calls) is
    what makes a `Promise.all([tools.delegate_task(...), tools.delegate_task(...)])`
    fan-out reconcile against the two spawns it produces. Each flag is read from its
    own call's span (from the call to the next occurrence), never positionally from
    the whole script: a stray `background: false` in a string or an unrelated object
    must not flip the first call's classification. Totals never depended on this (the
    reconcile compares spawn totals), but the FG/BG column did.
    """
    stripped = strip_js_comments(code)
    calls = list(_CODEMODE_CALL.finditer(stripped))
    if not calls:
        return []
    flags = []
    for index, call in enumerate(calls):
        start = call.start()
        end = calls[index + 1].start() if index + 1 < len(calls) else len(stripped)
        hit = _CODEMODE_BACKGROUND.search(stripped[start:end])
        flags.append(hit.group(1) == "true" if hit else None)
    return flags


def _line_digest(raw: bytes) -> str:
    """The first 16 hex of a log line's sha256 — the line's bytes, newline excluded.

    The contract is bytes, not text: the line as stored, UTF-8, WITHOUT its
    trailing newline. A citation (file, line, digest) then survives a re-read and
    a rewritten log cannot silently re-point it (#574 §2.2).
    """
    return hashlib.sha256(raw.rstrip(b"\r\n")).hexdigest()[:16]


def iter_rows(paths):
    """Yield `(row, file, line, digest)` for every parseable JSON line in `paths`.

    One reader for BOTH log families (issue #574 §2.2): both are one JSON object
    per line, so the provenance the candidates need — the physical file basename
    (a rotation suffix is part of the name), the 1-based line, and the line's
    digest — is retained here and nowhere else. A missing or unreadable file is
    SKIPPED: the legacy metrics path fails open. Candidates mode checks
    readability first and refuses with exit 2 (§2.6).
    """
    for path in paths:
        try:
            handle = open(path, "rb")
        except OSError:
            continue
        with handle:
            for line_no, raw in enumerate(handle, 1):
                body = raw.rstrip(b"\r\n")
                if not body.strip():
                    continue
                try:
                    row = json.loads(body.decode("utf-8", errors="replace"))
                except json.JSONDecodeError:
                    continue
                yield row, os.path.basename(path), line_no, _line_digest(raw)


def load_events(log_paths, since, until):
    """Yield (kind, payload, ts) for every relevant event in range.

    Each payload carries its provenance — `_file`, `_line`, `_digest` — so a
    derived candidate can cite the physical line it came from without a second
    read (#574 §2.2, §3 T1b).
    """
    for d, file_name, line_no, digest in iter_rows(log_paths):
        ts = iso_ts(d.get("timestamp"))
        if not in_range(ts, since, until):
            continue
        provenance = {"_file": file_name, "_line": line_no, "_digest": digest}

        # Run entries (custom type) — the settlement record
        if d.get("type") == "custom" and d.get("customType") == "brl-subagent-run":
            yield ("run", {**(d.get("data") or {}), **provenance}, ts)
            continue

        # Tool calls (delegate_task, codemode, get_subagent_result, steer, stop)
        msg = d.get("message") or {}
        for c in msg.get("content") or []:
            if not isinstance(c, dict) or c.get("type") != "toolCall":
                continue
            name = c.get("name")
            args = c.get("arguments") or {}
            if name == "delegate_task":
                yield ("dispatch", {**args, "_call_id": c.get("id"), "_route": "direct", **provenance}, ts)
            elif name == "codemode":
                # Issue #489: a dispatch issued from inside a codemode
                # script is a codemode toolCall, so the direct scan could
                # never see it.
                for background in codemode_dispatches(args.get("code") or ""):
                    yield ("dispatch", {"_call_id": c.get("id"),
                                        "_route": "codemode",
                                        "background": background, **provenance}, ts)
            elif name == "get_subagent_result":
                yield ("poll", {**args, **provenance}, ts)
            elif name == "steer_subagent":
                yield ("steer", {**args, **provenance}, ts)
            elif name == "stop_subagent":
                yield ("stop", {**args, **provenance}, ts)


def _result_text(message):
    """The text blocks of a toolResult message, joined — the only place a refusal names itself."""
    blocks = message.get("content")
    if not isinstance(blocks, list):
        return ""
    return " ".join(block.get("text") or "" for block in blocks if isinstance(block, dict))


def is_preflight_refusal(text) -> bool:
    """True when a refused result's own words are the harness's PRE-SPAWN dialect.

    A match LABELS an exclusion; what decides that no child existed is `isError: true` PLUS
    this dialect. The safe direction is a miss: the call then stays counted, and a wrong
    count surfaces as a negative Δ (loud) instead of a hidden spawn (silent).
    """
    body = str(text or "").lower()
    return any(phrase in body for phrase in PREFLIGHT_REFUSAL_PHRASES)


def load_call_results(log_paths):
    """`{flags: call id -> {is_error, text}, duplicates: N}` over the WHOLE file set (#591 §2).

    Deliberately NOT window-filtered: a toolResult usually lands AFTER the call it answers,
    so a window-filtered map classifies every call near `--until` as `unresolved`. One pass,
    one key: the classification reads this map, so the order of the two rows in the file
    decides nothing (a reordered log answers the same lookup).

    The TEXT is kept beside the flag because `isError: true` alone cannot tell a pre-flight
    refusal from a run that started and then failed (#591: 37 vs 7 in the measured corpus).

    Duplicates: a second result for one call IN ONE FILE is a producer bug, counted so it can
    be seen (`duplicate: N`), with the last occurrence winning. The same session file copied
    into two session directories is NOT a duplicate — its call ids are identical — so the
    seen-set is keyed by path as well: a copy must not inflate the count (measured on the
    default glob: 18 files, 1,871 delegate results, 632 ids present in more than one copy,
    0 with conflicting statuses).
    """
    flags = {}
    seen = set()
    duplicates = 0
    for path in log_paths:
        for row, _file, _line, _digest in iter_rows([path]):
            message = row.get("message") or {}
            if message.get("role") != "toolResult":
                continue
            call_id = message.get("toolCallId")
            if not call_id:
                continue
            key = (path, call_id)
            if key in seen:
                duplicates += 1
            seen.add(key)
            flags[call_id] = {"is_error": bool(message.get("isError")),
                              "text": _result_text(message)}
    return {"flags": flags, "duplicates": duplicates}


def load_spawn_rows(spawn_paths, since, until):
    """Yield the spawn log's rows in range, each carrying its `(file, line, digest)`.

    The spawn log's shape is not the session log's — `message` + `data`, no
    toolCall blocks — so it keeps a reader of its own; the provenance contract is
    the session reader's, and both come from `iter_rows`.
    """
    for row, file_name, line_no, digest in iter_rows(spawn_paths):
        if not in_range(iso_ts(row.get("timestamp")), since, until):
            continue
        yield {**row, "_file": file_name, "_line": line_no, "_digest": digest}


def compute(events, call_results=None):
    """Reduce events to the metrics dict.

    `call_results` is `load_call_results`'s whole-file map (issue #591 §2). A direct dispatch
    is classified by its RESULT, three ways: a pre-flight refusal leaves the dispatch count,
    the fg/bg split and the retry rate and is reported as `refused`; a failure AFTER a spawn
    stays counted and is reported as `failed after spawn`; no result at all still counts and
    is reported as `unresolved` (a truncated log is not a refusal).
    """
    flags = (call_results or {}).get("flags") or {}
    refused = 0             # pre-flight rejections: no child existed (#591)
    failed_after_spawn = 0  # a run started and then failed — a dispatch and a spawn (#591)
    unresolved = 0          # calls with no result in the session log at all (#591)
    runs = {}            # id -> latest status (finalized entry wins)
    run_meta = {}        # id -> first-seen metadata (label, model, thinkingLevel)
    dispatch_ids = []    # (call_id, label) in order — DIRECT dispatches only
    codemode_count = 0   # dispatches issued from inside a codemode script (#489)
    codemode_assumed_bg = 0  # of those, how many had no explicit `background` flag
    fanout_extra = 0     # spawns beyond one-per-call from a direct `tasks` fan-out
    retries = []         # dispatch events carrying retryRunId
    polls = 0
    steers = 0
    stops = 0
    bg_count = 0
    fg_count = 0
    template_usage = Counter()  # Rule 14: template-routed dispatches
    preset_usage = Counter()    # Rule 14: preset distribution
    mode_usage = Counter()      # Rule 14: single/chain/parallel/graph

    for kind, payload, ts in events:
        if kind == "run":
            rid = payload.get("id")
            if not rid:
                continue
            # Keep the FINALIZED entry (status != running) if seen; else the spawn.
            prev = runs.get(rid)
            if prev is None or prev.get("status") == "running":
                runs[rid] = payload
            if rid not in run_meta:
                run_meta[rid] = {
                    "label": payload.get("label"),
                    "model": payload.get("model"),
                    "thinkingLevel": payload.get("thinkingLevel"),
                }
        elif kind == "dispatch":
            # A codemode-issued dispatch (#489): the script text is its only record.
            # It feeds the dispatch count and the fg/bg split; template/preset/mode
            # stay direct-only floors because a JS script does not state them
            # reliably enough to publish.
            if payload.get("_route") == "codemode":
                codemode_count += 1
                if payload.get("background") is False:
                    fg_count += 1
                else:
                    bg_count += 1
                    if payload.get("background") is None:
                        codemode_assumed_bg += 1
                continue
            # A direct call is classified by its RESULT, not by its existence (#591): a
            # pre-flight refusal spawned nothing and leaves the count; a failure AFTER the
            # spawn stays counted (it IS a spawn); a call with no result is unresolved, not
            # absent — the caller did dispatch, the log just cannot say how it ended.
            call_id = payload.get("_call_id")
            result = flags.get(call_id)
            if result is None:
                unresolved += 1
            elif result["is_error"]:
                if is_preflight_refusal(result["text"]):
                    refused += 1
                    continue
                failed_after_spawn += 1
            dispatch_ids.append((call_id, payload.get("label")))
            if payload.get("background"):
                bg_count += 1
            else:
                fg_count += 1
            tasks = payload.get("tasks")
            if isinstance(tasks, list) and len(tasks) > 1:
                fanout_extra += len(tasks) - 1
            if payload.get("retryRunId"):
                retries.append(payload)
            # Rule 14 (capability utilization): track template/preset/mode usage
            # so the audit measures whether the dispatch router is being used.
            if payload.get("template"):
                template_usage[payload.get("template")] += 1
            preset = payload.get("preset") or "none"
            preset_usage[preset] += 1
            if payload.get("chain"):
                mode_usage["chain"] += 1
            elif payload.get("tasks"):
                mode_usage["parallel"] += 1
            elif payload.get("graph"):
                mode_usage["graph"] += 1
            else:
                mode_usage["single"] += 1
        elif kind == "poll":
            polls += 1
        elif kind == "steer":
            steers += 1
        elif kind == "stop":
            stops += 1

    # Status classification (finalized = not running)
    statuses = Counter(r.get("status") for r in runs.values())
    finalized = {rid: r for rid, r in runs.items() if r.get("status") != "running"}

    # Zero-work signature: done + empty fullOutput (+ short duration).
    # Probe runs (deliberate failures for verification) are tagged with
    # 'probe' in the label and are excluded from the zero-work rate — they
    # are intentional, not failures. Everything else counts.
    zero_work = [
        rid for rid, r in finalized.items()
        if r.get("status") == "done"
        and not (r.get("fullOutput") or "").strip()
        and (r.get("durationMs") or 0) < 60_000
        and "probe" not in (r.get("label") or "").lower()
    ]

    # Retry success: the RETRY's own resulting run entry, matched by label
    # (the retry dispatch's label appears on its spawned run entry). The
    # target's status is NOT the retry outcome — it is the original run.
    retry_labels = [r.get("label") for r in retries if r.get("label")]
    retry_ok = retry_fail = retry_missing = 0
    for r in retries:
        label = r.get("label")
        # Match the RETRY's own resulting run entry. Preferred key: `resumeOf`
        # (set on every retry's spawned record since U1 — including bridged
        # retries resolved from the registry, which carry NO label when the
        # caller passes only `retryRunId`); label is the legacy fallback.
        candidates = [
            rid for rid, run in finalized.items()
            if run.get("resumeOf") == r.get("retryRunId")
        ]
        if not candidates and label:
            candidates = [
                rid for rid, run in finalized.items()
                if run.get("label") == label and rid != r.get("retryRunId")
            ]
        settled_retry = [
            rid for rid in candidates if finalized[rid].get("status") != "running"
        ]
        if settled_retry:
            if finalized[settled_retry[0]].get("status") == "done":
                retry_ok += 1
            else:
                retry_fail += 1
        else:
            retry_missing += 1

    total_dispatches = len(dispatch_ids) + codemode_count
    settled = len(finalized)
    done = statuses.get("done", 0)
    failed = statuses.get("failed", 0)
    running = statuses.get("running", 0)

    return {
        "total_dispatches": total_dispatches,
        "direct": len(dispatch_ids),
        "codemode": codemode_count,
        "refused": refused,
        "failed_after_spawn": failed_after_spawn,
        "unresolved": unresolved,
        "duplicate_results": (call_results or {}).get("duplicates") or 0,
        "codemode_assumed_background": codemode_assumed_bg,
        "fanout_extra": fanout_extra,
        "foreground": fg_count,
        "background": bg_count,
        "polls": polls,
        "steers": steers,
        "stops": stops,
        "poll_per_dispatch": round(polls / total_dispatches, 2) if total_dispatches else 0,
        "runs_total": len(runs),
        "runs_settled": settled,
        "done": done,
        "failed": failed,
        "running": running,
        "success_rate": round(done / settled * 100, 1) if settled else 0,
        "failed_rate": round(failed / settled * 100, 1) if settled else 0,
        "zero_work": len(zero_work),
        "zero_work_rate": round(len(zero_work) / settled * 100, 1) if settled else 0,
        "retries": len(retries),
        "retry_success": retry_ok,
        "retry_fail": retry_fail,
        "retry_missing": retry_missing,
        "retry_success_rate": round(retry_ok / len(retries) * 100, 1) if retries else 0,
        "spawn_running": running,  # entries stuck running (potential zombies)
        "template_usage": dict(template_usage),
        "preset_usage": dict(preset_usage),
        "mode_usage": dict(mode_usage),
    }


def default_spawn_logs():
    """The cockpit's spawn log plus its rotated files (missing ones are skipped).

    src/logging.ts rotates `brl-subagent.log` to `.1`..`.5`, so a window that
    straddles a rotation must read the family, not just the live file.
    """
    base = os.path.join(os.getcwd(), SPAWN_LOG_REL)
    return [base] + [f"{base}.{i}" for i in range(1, SPAWN_LOG_ROTATED + 1)]


def read_spawn_starts(spawn_paths, since, until):
    """Count run STARTS in the extension spawn log, in the same window.

    The spawn log's shape is not the session log's: one JSON object per line with
    `message` + `data` (no `content` toolCall blocks and no run records). A start
    is `Background agent spawned` (deduped by `data.agentId`, so a duplicated
    line cannot inflate the count) or `Starting subagent process` (the foreground
    runner). Transport auto-retry starts ALSO arrive as `Background agent spawned`
    events, so they are counted separately as the surplus the reconcile allows.
    """
    present = [path for path in spawn_paths if os.path.exists(path)]
    bg_ids = set()
    fg = 0
    retry_starts = 0
    for row, file_name, line_no, _digest in iter_rows(present):
        if not in_range(iso_ts(row.get("timestamp")), since, until):
            continue
        message = row.get("message")
        data = row.get("data") or {}
        if message == BG_SPAWN_MESSAGE:
            bg_ids.add(data.get("agentId") or f"{file_name}:{line_no}")
        elif message == FG_SPAWN_MESSAGE:
            fg += 1
        elif message == RETRY_SPAWN_MESSAGE:
            retry_starts += 1
    return {"found": bool(present), "files": len(present), "background": len(bg_ids),
            "foreground": fg, "spawns": len(bg_ids) + fg, "retry_starts": retry_starts}


def reconcile(m, spawn_paths, since, until):
    """Attach the spawn-side figures and Δ to `m`; return (ok, reason).

    Allowance: spawns legitimately exceed dispatch calls by (a) every transport
    auto-retry start — a retry spawns a fresh run with no new dispatch call — and
    (b) every fan-out unit beyond the first (`tasks: [...]`). Both are counted from
    the window, so the allowance is derived rather than guessed. A fan-out issued
    INSIDE a codemode script is not statically parseable; it trips the loud failure,
    which is the safe direction.

    Coverage: a missing spawn log (a worktree, a fresh checkout) leaves `spawns`
    None and returns ok — an absent source is reported as unavailable, never as a
    clean Δ.
    """
    starts = read_spawn_starts(spawn_paths, since, until)
    m["spawn_log_found"] = starts["found"]
    m["spawn_files"] = starts["files"]
    m["retry_starts"] = starts["retry_starts"]
    m["allowance"] = starts["retry_starts"] + m.get("fanout_extra", 0)
    m["spawns"] = starts["spawns"] if starts["found"] else None
    m["spawn_foreground"] = starts["foreground"]
    m["spawn_background"] = starts["background"]
    if not starts["found"]:
        m["delta"] = None
        return True, "reconcile unavailable — the spawn log was not found"
    m["delta"] = starts["spawns"] - m["total_dispatches"]
    if m["delta"] < 0:
        return False, (
            f"over-count — {m['total_dispatches']} dispatches exceed {starts['spawns']} spawns "
            f"(Δ {m['delta']}); a counted delegate_task( produced no spawn"
        )
    if m["delta"] > m["allowance"]:
        return False, (
            f"under-count — {starts['spawns']} spawns exceed {m['total_dispatches']} dispatches "
            f"+ {m['allowance']} allowed (Δ {m['delta']}); dispatch calls are missing from the scan"
        )
    return True, f"Δ {m['delta']} within allowance {m['allowance']}"


# ---------------------------------------------------------------------------
# Friction candidates (issue #574) — the six kinds, derived from the two logs.
#
# The reader retains (file, line, digest) per row; this section turns rows into
# candidates under §2.1's rules and renders the consumer-v1 payload (§2.2).
# ---------------------------------------------------------------------------


class SourceError(Exception):
    """A candidates-mode source is missing or unreadable — exit 2, no file written."""


class OutputError(Exception):
    """A candidates-mode output path cannot be written — exit 2, nothing written."""


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _us(value):
    """Epoch MICROseconds for an ISO instant (None when unparseable).

    Sub-millisecond on purpose: the ownership interval is measured, not rounded, so
    a 2000.4 ms stop→abort delta is out of the inclusive 2000 ms bound instead of
    rounding down to it. Computed from the exact `timedelta`, never via float.
    """
    moment = _parse_ts(value)
    if moment is None:
        return None
    delta = moment - _EPOCH
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def _source(label, file_name, line_no):
    """`<prefix>:<file>:<line>` — the PHYSICAL file, so a rotation cannot alias a line."""
    return f"{label}:{file_name}:{line_no}"


def require_readable(paths, label):
    """Prove every path in `paths` can be opened; raise SourceError naming the one that cannot.

    Candidates mode refuses (exit 2) on a missing or unreadable source: a derived
    figure with no evidence behind it is worse than no figure (§2.6). The legacy
    metrics path does not call this — it keeps failing open.
    """
    if not paths:
        raise SourceError(f"{label}: no source to read")
    for path in paths:
        try:
            with open(path, "rb"):
                pass
        except OSError as exc:
            raise SourceError(f"{label}: {path} is missing or unreadable ({exc.strerror or exc})") from exc
    return list(paths)


def _causal_window(since, until):
    """The requested window widened by CAUSAL_MARGIN_MS on both sides (§2.1 R6).

    A stop owns an abort up to DEDUPE_MS before it, and a retry call precedes its
    spawn; both joins must see rows just outside the requested window or an event
    at the edge is misclassified. Widening is the LOAD bound only — emission is
    still decided per candidate, by its own timestamp.
    """
    start = _window_start(since)
    end = _window_end(until)
    if start is None or end is None:
        return since, until
    margin = timedelta(milliseconds=CAUSAL_MARGIN_MS)
    return (start - margin).isoformat(), (end + margin).isoformat()


def _collect_friction(events, spawn_rows):
    """Split loaded rows into the sources each friction kind derives from.

    Rows are NOT windowed here: the load already carries the causal margin, and
    `derive_candidates` decides emission per candidate. Joins are by id only —
    `agent_id`, a run id, `sourceId` — never by label (§2.1 R4).
    """
    runs, stops, steers, retry_calls, spawns, transport = [], [], [], [], [], []
    for order, (kind, payload, ts) in enumerate(events):
        base = {"ts": iso_ts(ts), "ts_us": _us(ts), "order": order,
                "file": payload["_file"], "line": payload["_line"],
                "digest": payload["_digest"], "label": SESSION_SOURCE}
        if kind == "run":
            run_id = payload.get("id")
            if not run_id:
                continue
            # Any status counts as a spawn for R3 — a `running` entry is the
            # earliest proof that a retry call was actually dispatched.
            if payload.get("resumeOf"):
                spawns.append({**base, "target": payload["resumeOf"]})
            if payload.get("status") != "failed":
                continue
            # The run store's status union has no `stopped`: every stop outcome is
            # `failed` + an errorCategory, so these two tests cover the run kinds.
            runs.append({**base, "runId": run_id,
                         "kind": "deadline" if payload.get("errorCategory") == "timeout" else "failed",
                         "synthetic": payload.get("synthetic") is True})
        elif kind in ("stop", "steer"):
            run_id = payload.get("agent_id")
            if not run_id:
                continue
            (stops if kind == "stop" else steers).append({**base, "runId": run_id, "kind": kind})
        elif kind == "dispatch" and payload.get("_route") == "direct" and payload.get("retryRunId"):
            retry_calls.append({**base, "runId": payload["retryRunId"],
                                "retryRunId": payload["retryRunId"],
                                "kind": "retry", "via": "explicit"})
    # Spawn rows sort after every session event: one shared (ts, source order) key.
    for order, row in enumerate(spawn_rows, start=len(events)):
        data = row.get("data") or {}
        ts = iso_ts(row.get("timestamp"))
        base = {"ts": ts, "ts_us": _us(ts), "order": order,
                "file": row["_file"], "line": row["_line"],
                "digest": row["_digest"], "label": SPAWN_SOURCE}
        if row.get("message") == RETRY_SPAWN_MESSAGE and data.get("sourceId"):
            # A transport retry names the DEAD run in `sourceId`; `agentId` on the
            # same row is the new run, so reading it would mis-attribute (T5).
            transport.append({**base, "runId": data["sourceId"],
                              "kind": "retry", "via": "transport"})
        if data.get("resumeOf"):
            spawns.append({**base, "target": data["resumeOf"]})
    return {"runs": runs, "stops": stops, "steers": steers,
            "retry_calls": retry_calls, "spawns": spawns, "transport": transport}


def _order_of(entry):
    """A row's position in the log: `(ts, source order)` — the one tiebreak every join uses.

    Rows are enumerated across both files (spawn rows after session events), so a
    duplicate timestamp still has a stable, evidence-based order.
    """
    return (entry["ts_us"] or 0, entry["order"])


def _emission_key(entry):
    """Where a candidate lands in the payload: `(ts, kind, runId, source order)` (§2.1 R5/R6).

    Distinct from `_order_of` on purpose — ordinal assignment is per `(runId, kind)` in
    source order, while emission is by kind first, so the two orders cannot be folded
    into one key without changing what the payload says.
    """
    return (entry["ts_us"] or 0, entry["kind"], entry["runId"], entry["order"])


def _owning_stop(run, stops):
    """The NEAREST PRECEDING stop that owns this abort (§2.1 R2), or None.

    The interval is inclusive at both ends: a stop 2000 ms before the abort owns
    it, 2001 ms does not, and a stop AFTER the abort owns nothing. Nearest — not
    first — preceding, so a second stop on the same run is the owner.
    """
    best = None
    for stop in stops:
        if stop["runId"] != run["runId"]:
            continue
        delta = (run["ts_us"] or 0) - (stop["ts_us"] or 0)
        if delta < 0 or delta > DEDUPE_MS * 1000:
            continue
        if best is None or _order_of(stop) > _order_of(best):
            best = stop
    return best


def _paired_retries(retry_calls, spawns):
    """The explicit retries that actually spawned a run — one per retried run (§2.1 R3).

    A retry needs a spawn of ANY status (a `running` entry is enough); the call
    that owns it is the LAST one strictly before the EARLIEST spawn, so a second
    call collapses onto the first, and a later spawn never re-attributes an
    earlier call. No spawn at all is a refused dispatch, not a candidate.
    """
    earliest = {}
    for spawn in spawns:
        prev = earliest.get(spawn["target"])
        if prev is None or _order_of(spawn) < _order_of(prev):
            earliest[spawn["target"]] = spawn
    paired = {}
    for call in retry_calls:
        spawn = earliest.get(call["retryRunId"])
        if spawn is None:
            continue
        if call["ts_us"] >= spawn["ts_us"]:
            continue
        prev = paired.get(call["retryRunId"])
        if prev is None or _order_of(call) > _order_of(prev):
            paired[call["retryRunId"]] = call
    return list(paired.values())


def _render_candidate(entry, ordinal):
    """One payload entry — keys in the producer's order, so the render is byte-stable."""
    candidate = {
        "eventId": f"{entry['runId']}:{entry['kind']}:{ordinal}",
        "kind": entry["kind"],
        "runId": entry["runId"],
        "ts": entry["ts"],
        "class": None,
        "count": 1,
        "source": _source(entry["label"], entry["file"], entry["line"]),
        "digest": entry["digest"],
        "dismissed": None,
    }
    if entry.get("via"):
        candidate["via"] = entry["via"]
    if entry.get("synthetic"):
        candidate["synthetic"] = True
    return candidate


def derive_candidates(sources, since, until):
    """The ordered candidate list — §2.1 R1 (dedupe), R2 (ownership), R5 (identity/order).

    Emission is per candidate: its own timestamp must lie in [since, until], so a
    margin row can inform a classification without appearing in the payload.
    """
    def in_window(ts):
        return in_range(ts, since, until)

    # Only in-window terminal rows compete for a run's candidate: a later row that
    # exists solely because of the causal margin is evidence for the join, never an
    # emission (§2.1 R6), so a snapshot+amendment straddling the bound emits ONE
    # candidate at the in-window row, and a margin-only run emits nothing.
    terminal = {}
    for run in sources["runs"]:
        if not in_window(run["ts"]):
            continue
        key = (run["runId"], run["kind"])
        prev = terminal.get(key)
        if prev is None or _order_of(run) >= _order_of(prev):
            terminal[key] = run

    owned = {(run["runId"], run["kind"]) for run in terminal.values()
             if run["kind"] == "failed" and _owning_stop(run, sources["stops"])}

    emitted = [run for key, run in terminal.items() if key not in owned]
    emitted += [call for call in sources["stops"] if in_window(call["ts"])]
    emitted += [call for call in sources["steers"] if in_window(call["ts"])]
    emitted += [row for row in sources["transport"] if in_window(row["ts"])]
    emitted += [call for call in _paired_retries(sources["retry_calls"], sources["spawns"])
                if in_window(call["ts"])]

    # R5: the ordinal is per (runId, kind) in (ts, source order); the payload is
    # ordered by (ts, kind, runId) — the last tiebreak is the source order, so two
    # runs over the same input are byte-identical.
    grouped = defaultdict(list)
    for entry in emitted:
        grouped[(entry["runId"], entry["kind"])].append(entry)
    rendered = []
    for group in grouped.values():
        group.sort(key=_order_of)
        for ordinal, entry in enumerate(group, 1):
            key = _emission_key(entry)
            rendered.append((key, _render_candidate(entry, ordinal)))
    rendered.sort(key=lambda pair: pair[0])
    return [candidate for _key, candidate in rendered]


def build_candidates_payload(session_paths, spawn_paths, since, until, cycle):
    """The consumer-v1 payload (§2.2) for one window: derived, never hand-written."""
    load_since, load_until = _causal_window(since, until)
    events = list(load_events(session_paths, load_since, load_until))
    spawn_rows = list(load_spawn_rows(spawn_paths, load_since, load_until))
    sources = _collect_friction(events, spawn_rows)
    return {
        "version": CANDIDATE_VERSION,
        "cycle": cycle,
        "claimedLive": False,
        "candidates": derive_candidates(sources, since, until),
    }


def render_candidates(payload):
    """The payload as the file it becomes — 2-space JSON plus one trailing newline."""
    return json.dumps(payload, indent=2) + "\n"


def write_candidates(path, payload):
    """Write the payload atomically: a sibling temp file, then one `os.replace`.

    A reader (the close gate) never sees a half-written file, and a failed run
    leaves the previous file — or no file — rather than a truncated one.
    """
    out = Path(path)
    parent = out.parent or Path(".")
    if not parent.is_dir():
        # Named, not a FileNotFoundError traceback: the same honesty as a source
        # refusal, and still nothing written.
        raise OutputError(f"cannot write {out}: the directory {parent} does not exist")
    handle, temp_path = tempfile.mkstemp(dir=str(parent), prefix=f".{out.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(render_candidates(payload))
        os.replace(temp_path, out)
    except BaseException:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise
    return out


def run_candidates(args) -> int:
    """`--candidates <path>` — exit 2 (and write nothing) when a source cannot be read."""
    cycle = args.sprint or args.since
    session_paths = args.log or sorted(glob.glob(SESSION_GLOB))
    spawn_paths = args.spawn_log or default_spawn_logs()
    try:
        # A default spawn family is six paths of which only the live file must
        # exist; an explicitly named source must be readable, every one of them.
        require_readable(session_paths, SESSION_SOURCE)
        require_readable(spawn_paths if args.spawn_log else spawn_paths[:1], SPAWN_SOURCE)
    except SourceError as exc:
        print(f"sprint-metrics --candidates: {exc}", file=sys.stderr)
        return 2
    payload = build_candidates_payload(session_paths, spawn_paths, args.since, args.until, cycle)
    try:
        written = write_candidates(args.candidates, payload)
    except OutputError as exc:
        print(f"sprint-metrics --candidates: {exc}", file=sys.stderr)
        return 2
    print(f"candidates: {len(payload['candidates'])} → {written}")
    return 0


# Candidates self-test (issue #574). The corpus is resolved from THIS FILE, so
# the CI-wired `--selftest` runs from any cwd; the unit fixtures are temp dirs,
# so a boundary case never depends on the real logs.
CORPUS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "__tests__", "fixtures", "friction-candidates")
CORPUS_WINDOW = ("2026-11-21", "2026-11-22")
CORPUS_CYCLE = "fixture-574"


def _line_body(path, line_no):
    """The on-disk bytes of one line, its newline excluded."""
    with open(path, "rb") as handle:
        for index, raw in enumerate(handle, 1):
            if index == line_no:
                return raw.rstrip(b"\r\n")
    return b""


def _ts_at(offset_ms):
    """An ISO instant `offset_ms` after the fixture base (millisecond precision)."""
    moment = _parse_ts(SELFTEST_TS) + timedelta(milliseconds=offset_ms)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _run_row(ts, run_id="run-1", status="failed", category=None, resume_of=None, synthetic=False):
    """A session-log run entry, rebuilt from an allowlist — no free text."""
    data = {"id": run_id, "model": "fixture", "startedAt": ts, "status": status}
    if category:
        data["errorCategory"] = category
    if resume_of:
        data["resumeOf"] = resume_of
    if synthetic:
        data["synthetic"] = True
    return {"type": "custom", "customType": "brl-subagent-run", "timestamp": ts, "data": data}


def _call_row(ts, name, arguments, call_id="call-1"):
    """A toolCall row in the production envelope, so the real decoder reads it."""
    return {"timestamp": ts, "message": {"role": "assistant", "content": [
        {"type": "toolCall", "id": call_id, "name": name, "arguments": arguments}]}}


def _spawn_row(ts, message, **data):
    """A spawn-log row (the extension's `message` + `data` shape)."""
    return {"timestamp": ts, "level": "info", "prefix": "brl-subagent",
            "message": message, "data": data}


def _candidate_fixture(session_entries, spawn_entries, window=SELFTEST_WINDOW):
    """Derive the payload for one in-memory fixture pair (a temp dir, cleaned up)."""
    with tempfile.TemporaryDirectory() as tmp:
        session_path = os.path.join(tmp, "session.jsonl")
        spawn_path = os.path.join(tmp, "spawn.log")
        _write_jsonl(session_path, session_entries)
        _write_jsonl(spawn_path, spawn_entries)
        return build_candidates_payload([session_path], [spawn_path], *window, cycle="unit")


def _kinds(payload):
    return [candidate["kind"] for candidate in payload["candidates"]]


def _first_mismatch(got, want):
    """Name the first differing candidate — a mismatch must print its eventId."""
    got_list = got.get("candidates") or []
    want_list = want.get("candidates") or []
    for index in range(max(len(got_list), len(want_list))):
        left = got_list[index] if index < len(got_list) else None
        right = want_list[index] if index < len(want_list) else None
        if left != right:
            return (f"candidates[{index}]: got {json.dumps(left, sort_keys=True)} "
                    f"want {json.dumps(right, sort_keys=True)}")
    header = {key: value for key, value in got.items() if key != "candidates"}
    return f"header differs: {json.dumps(header, sort_keys=True)}"


def _candidate_checks():
    """The corpus assertions and the R2/R3 boundary fixtures (§3 T1–T4d, T8)."""
    checks = []
    session_path = os.path.join(CORPUS_DIR, "session.jsonl")
    spawn_path = os.path.join(CORPUS_DIR, "spawn.log")
    expected_path = os.path.join(CORPUS_DIR, "expected-candidates.json")

    events = list(load_events([session_path], *CORPUS_WINDOW))
    counts = Counter(kind for kind, _payload, _ts in events)
    want_counts = Counter({"run": 17, "dispatch": 2, "steer": 1, "stop": 1})
    checks.append(("corpus: the production decoder reads every row",
                   counts == want_counts, str(dict(sorted(counts.items())))))

    bad = [f"{kind}@line {payload['_line']}" for kind, payload, _ts in events
           if payload.get("_file") != "session.jsonl"
           or hashlib.sha256(_line_body(session_path, payload["_line"])).hexdigest()[:16] != payload["_digest"]]
    checks.append(("corpus: every event carries (file, line) and a digest over the line's bytes",
                   not bad, ", ".join(bad) or f"{len(events)} events"))

    payload = build_candidates_payload([session_path], [spawn_path], *CORPUS_WINDOW, cycle=CORPUS_CYCLE)
    with open(expected_path, encoding="utf-8") as handle:
        expected_text = handle.read()
    expected = json.loads(expected_text)
    checks.append(("corpus: the payload matches expected-candidates.json (full schema, ordered)",
                   payload == expected,
                   f"{len(payload['candidates'])} candidates" if payload == expected
                   else _first_mismatch(payload, expected)))
    checks.append(("corpus: the rendering is byte-identical to the expectation file",
                   render_candidates(payload) == expected_text,
                   f"{len(render_candidates(payload))} bytes"))

    for delta in (-1, 0, 2000, 2001):
        unit = _candidate_fixture(
            [_call_row(_ts_at(0), "stop_subagent", {"agent_id": "run-1"}),
             _run_row(_ts_at(delta), category="aborted")], [])
        owned = delta in (0, 2000)
        # Ownership, not ordering: the corpus assertion above pins the order.
        want = ["stop"] if owned else ["failed", "stop"]
        checks.append((f"R2 boundary: a stop {delta} ms before the abort "
                       f"{'owns' if owned else 'does not own'} it",
                       sorted(_kinds(unit)) == want, str(_kinds(unit))))

    unit = _candidate_fixture(
        [_call_row(_ts_at(0), "stop_subagent", {"agent_id": "run-1"}, call_id="call-1"),
         _call_row(_ts_at(1000), "stop_subagent", {"agent_id": "run-1"}, call_id="call-2"),
         _run_row(_ts_at(2400), category="aborted")], [])
    checks.append(("R2 multi-stop: only the nearest preceding stop owns the abort",
                   _kinds(unit) == ["stop", "stop"], str(_kinds(unit))))

    unit = _candidate_fixture(
        [_call_row(_ts_at(0), "delegate_task", {"retryRunId": "run-1", "background": True}, call_id="call-a"),
         _call_row(_ts_at(1000), "delegate_task", {"retryRunId": "run-1", "background": True}, call_id="call-b"),
         _run_row(_ts_at(2000), run_id="run-2", status="running", resume_of="run-1"),
         _run_row(_ts_at(5000), run_id="run-3", status="running", resume_of="run-1")], [])
    got = unit["candidates"]
    checks.append(("R3: two calls collapse to the last one before the earliest spawn",
                   _kinds(unit) == ["retry"] and bool(got) and got[0]["via"] == "explicit"
                   and got[0]["source"] == "session-log:session.jsonl:2",
                   f"{_kinds(unit)} {got[0]['source'] if got else 'none'}"))

    unit = _candidate_fixture(
        [_call_row(_ts_at(0), "delegate_task", {"retryRunId": "run-1"}),
         _run_row(_ts_at(400), run_id="run-2", status="running", resume_of="run-1")], [])
    checks.append(("R3: a running-only spawn still pairs the retry call",
                   _kinds(unit) == ["retry"], str(_kinds(unit))))

    unit = _candidate_fixture([_call_row(_ts_at(0), "delegate_task", {"retryRunId": "run-1"})], [])
    checks.append(("R3: a refused retry call (no spawn at all) is not a candidate",
                   _kinds(unit) == [], str(_kinds(unit))))

    # R6 applies to runs too: the causal margin is a LOAD bound, so a terminal row
    # that exists only inside it informs a join but is never emitted.
    for label, offset in (("after", 12000), ("before", -3000)):
        unit = _candidate_fixture(
            [_run_row(_ts_at(offset), category="timeout")], [],
            window=(_ts_at(0), _ts_at(10000)))
        checks.append((f"R6: a terminal run only in the margin {label} the window emits nothing",
                       _kinds(unit) == [], str(_kinds(unit))))

    # A snapshot at the window's last in-window instant plus a later margin-only
    # amendment is ONE run: the in-window row is the candidate, at its own ts/source.
    unit = _candidate_fixture(
        [_run_row(_ts_at(15000), category="timeout"),
         _run_row(_ts_at(18000), category="timeout")], [],
        window=(_ts_at(0), _ts_at(15000)))
    got = unit["candidates"]
    checks.append(("R6: snapshot + margin-only amendment emits one candidate at the in-window row",
                   _kinds(unit) == ["deadline"] and len(got) == 1
                   and got[0]["ts"] == _ts_at(15000)
                   and got[0]["source"] == "session-log:session.jsonl:1",
                   json.dumps(got, sort_keys=True) if got else "none"))

    unit = _candidate_fixture(
        [_call_row(_ts_at(0), "steer_subagent", {"agent_id": "run-1"}, call_id="call-1"),
         _call_row(_ts_at(1000), "steer_subagent", {"agent_id": "run-1"}, call_id="call-2")], [])
    ids = [candidate["eventId"] for candidate in unit["candidates"]]
    checks.append(("R1: stop/steer are per call — two steers get ordinals 1 and 2",
                   ids == ["run-1:steer:1", "run-1:steer:2"], str(ids)))

    unit = _candidate_fixture([], [_spawn_row(_ts_at(0), RETRY_SPAWN_MESSAGE,
                                            agentId="decoy", sourceId="run-1", attempt=2)])
    got = unit["candidates"]
    checks.append(("R4: a transport retry joins by sourceId, not agentId",
                   len(got) == 1 and got[0]["runId"] == "run-1"
                   and got[0]["via"] == "transport"
                   and got[0]["source"] == "spawn-log:spawn.log:1",
                   json.dumps(got, sort_keys=True) if got else "none"))

    with tempfile.TemporaryDirectory() as tmp:
        missing = os.path.join(tmp, "nope.jsonl")
        empty_session = os.path.join(tmp, "session.jsonl")
        empty_spawn = os.path.join(tmp, "spawn.log")
        Path(empty_session).write_text("", encoding="utf-8")
        Path(empty_spawn).write_text("", encoding="utf-8")
        for label in (SESSION_SOURCE, SPAWN_SOURCE):
            try:
                require_readable([missing], label)
                detail = "no SourceError raised"
            except SourceError as exc:
                detail = str(exc)
            checks.append((f"refusal: a missing {label} source is named (exit 2, no file)",
                           missing in detail, detail))
        empty = build_candidates_payload([empty_session], [empty_spawn], *SELFTEST_WINDOW, cycle="unit")
        checks.append(("refusal: empty-but-present sources yield [] and no error",
                       empty["candidates"] == [] and empty["version"] == CANDIDATE_VERSION,
                       str(empty["candidates"])))
        unwritable = os.path.join(tmp, "no-such-dir", "candidates.json")
        try:
            write_candidates(unwritable, empty)
            detail = "no OutputError raised"
        except OutputError as exc:
            detail = str(exc)
        checks.append(("refusal: an output path in a missing directory is named (exit 2, no file)",
                       os.path.join(tmp, "no-such-dir") in detail and not os.path.exists(unwritable),
                       detail))
    return checks


def run_candidate_selftest():
    """The candidate checks; a broken fixture fails its case instead of crashing the run."""
    try:
        return _candidate_checks()
    except Exception as exc:  # noqa: BLE001 — a named failure, never a stack trace
        return [("candidate corpus", False, f"{type(exc).__name__}: {exc}")]


# ---------------------------------------------------------------------------
# Transport deaths (issue #572) — the per-label count the close reads.
#
# The run store is the only source for a settled run's death CLASS, and it is a
# different shape from both logs: one JSON snapshot per run id. The predicate
# below is the stored-record mirror of `isTransportFailure`; the signature list
# is not copied, it is READ FROM THE TS SOURCE at runtime.
# ---------------------------------------------------------------------------


class TransportError(Exception):
    """A transport reading cannot be computed — exit 2, no figure printed."""


RECORDS_REL = os.path.join(".pi", "subagents")
# Resolved from THIS FILE, never from the caller's cwd: the tool runs from the cockpit,
# from a worktree and from a temp dir, and only one of those has `src/` under it.
_HERE = os.path.dirname(os.path.abspath(__file__))            # <repo>/.pi/skills/worktree
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_HERE)))  # <repo>
SIGNATURES_REL = os.path.join("src", "transport-retry.ts")
SIGNATURE_MIN = 5        # the measured list holds nine; fewer is a parse that did not happen
TRANSPORT_LIMIT = 10     # `--limit` default for the per-label block
TRANSPORT_LABEL_MIN = 2  # a label is LISTED at >= 2 deaths; a singleton is only counted
UNLABELLED = "(unlabelled)"

# `TRANSPORT_SIGNATURES = [ … ]`: the block ends at the first `]`, which is the array's own
# close — no signature string contains a bracket, so the lazy match cannot over-run.
_SIGNATURE_BLOCK = re.compile(r"TRANSPORT_SIGNATURES\s*=\s*\[(.*?)\]", re.DOTALL)
# A `//` comment INSIDE the block is stripped before extraction, so a commented-out or
# obsolete pattern cannot become a signature. A quoted string containing `//` would be
# truncated by this — none does, and a truncated one still yields >= SIGNATURE_MIN.
_BLOCK_COMMENT_LINE = re.compile(r"//[^\n]*")
_QUOTED = re.compile(r'''["']([^"'\\\n]*)["']''')


def load_signatures(path=None):
    """The transport signature list, parsed from the TS source at runtime.

    Read from the SOURCE rather than pinned as literals here: a Python copy of the list
    cannot see a TypeScript-only change, so it would keep classifying against a predicate
    that no longer exists. `//` comments inside the block are stripped first, then every
    quoted string is taken. Fewer than `SIGNATURE_MIN` strings means the block did not
    parse — a drifted source must REFUSE (exit 2) rather than classify nothing, and a
    missing or unreadable file is the same refusal with the path named.
    """
    source = path or os.path.join(REPO_ROOT, SIGNATURES_REL)
    try:
        with open(source, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise TransportError(f"signatures {source} is missing or unreadable "
                             f"({exc.strerror or exc})") from exc
    match = _SIGNATURE_BLOCK.search(text)
    if match is None:
        raise TransportError(f"signatures: no TRANSPORT_SIGNATURES block in {source}")
    signatures = [found.lower() for found in _QUOTED.findall(_BLOCK_COMMENT_LINE.sub("", match.group(1)))]
    if len(signatures) < SIGNATURE_MIN:
        raise TransportError(f"signatures: {len(signatures)} string(s) in {source} "
                             f"(the block needs at least {SIGNATURE_MIN} — it did not parse)")
    return signatures


def _non_empty_str(value):
    """A non-empty, non-blank string, else None — the spec's `??`-with-blank-is-fallback rule."""
    return value if isinstance(value, str) and value.strip() else None


def _record_moment(record):
    """The record's inclusion instant, or None when it carries no usable timestamp.

    `startedAt` first, `completedAt` second: a run that STARTED before the window and
    settled inside it is still this window's evidence, and a record with neither is
    counted (`window unknown`) rather than dropped. Stored values are epoch MILLIseconds;
    an ISO string is accepted so a hand-built fixture may use either.
    """
    for key in ("startedAt", "completedAt"):
        value = record.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return _EPOCH + timedelta(milliseconds=value)
        if isinstance(value, str) and value.strip():
            moment = _parse_ts(value)
            if moment is not None:
                return moment
    return None


def is_transport_death(record, signatures):
    """The four §2 rules, in precedence order — the stored-record mirror of `isTransportFailure`.

    The TS predicate reads the RUN (`errorCategory ?? originalParams?.errorCategory`,
    `errorMessage ?? ""`); a stored record carries the current value under `result.*` and
    the legacy one under `originalParams.*` / top-level `errorMessage`, so each field falls
    back exactly where the `??` does, and BLANK counts as absent (the spec's rule, and the
    one a `""`-stamped record needs).

    `result.stderr` is deliberately NOT read. The predicate never sees stderr — it sees the
    settled run's `errorMessage` — so reading it here would classify runs the retry
    machinery does not consider transport deaths. Measured on the 1,565-record store
    (2026-11-22): 0 records change class when stderr is read, which is exactly why the
    corpus has to carry that shape synthetically (`stderr.json`).
    """
    if record.get("status") != "failed":
        return False
    result = record.get("result")
    result = result if isinstance(result, dict) else {}
    category = _non_empty_str(result.get("errorCategory"))
    if category is None:
        original = record.get("originalParams")
        category = _non_empty_str(original.get("errorCategory")) if isinstance(original, dict) else None
    if category != "exit_error":
        return False
    message = (_non_empty_str(result.get("errorMessage"))
               or _non_empty_str(record.get("errorMessage")) or "")
    lower = message.lower()
    return any(signature in lower for signature in signatures)


def load_records(records_dir):
    """Every `*.json` run record as `([(record, id)], unreadable)`.

    Sorted by filename so a count never depends on directory order. One unparsable or
    non-object file is COUNTED, never skipped: a reading that quietly drops the rows it
    cannot read understates in exactly the dangerous direction (§6). The id is the
    record's own `id`, else the file stem — a retry names its parent by id and the store
    spells both.
    """
    records, unreadable = [], 0
    for path in sorted(glob.glob(os.path.join(records_dir, "*.json"))):
        try:
            with open(path, encoding="utf-8") as handle:
                record = json.load(handle)
        except (OSError, ValueError):
            unreadable += 1
            continue
        if not isinstance(record, dict):
            unreadable += 1
            continue
        record_id = _non_empty_str(record.get("id")) or os.path.splitext(os.path.basename(path))[0]
        records.append((record, record_id))
    return records, unreadable


def records_readable(records_dir):
    """True when the DEFAULT report may try a transport reading for `records_dir`.

    The default path fails OPEN: a missing or unreadable directory is normal in CI and in
    a clone, so the line is omitted and the rest of the report is untouched. Whether the
    directory actually HOLDS a record is decided once, after the read, by
    `transport_metrics` — so the directory is listed exactly once.
    """
    return os.path.isdir(records_dir) and os.access(records_dir, os.R_OK | os.X_OK)


def transport_metrics(records_dir, signatures, since, until, required=False):
    """The counters of §2's table over one run-record directory, or None when there is nothing
    to read and the caller did not require a reading.

    `required` is the `--transport` half of the asymmetry: the mode REFUSES an absent or
    empty directory, naming it, because a metric over no records is not zero deaths. The
    default path gets None instead, so it prints no line at all — an absent directory, an
    unreadable one and an EMPTY one are one answer there (§D1, §4 A2).

    The parent lookup is done over EVERY readable record indexed by id BEFORE the window
    filter — a retry's parent may predate the window, and filtering first would report
    every such retry as `resume unknown`.
    """
    if required and not os.path.isdir(records_dir):
        raise TransportError(f"records: {records_dir} is not a directory")
    records, unreadable = load_records(records_dir)
    if not records and not unreadable:
        if required:
            raise TransportError(f"records: {records_dir} holds no *.json run record")
        return None
    by_id = {}
    for record, record_id in records:
        by_id.setdefault(record_id, record)
    dead_ids = {record_id for record_id, record in by_id.items()
                if is_transport_death(record, signatures)}
    start, end = _window_start(since), _window_end(until)
    in_window = window_unknown = deaths = retried = died_again = resume_unknown = 0
    labels = Counter()
    for record, _record_id in records:
        moment = _record_moment(record)
        if moment is None:
            window_unknown += 1
            continue
        # An unparseable bound excludes everything, exactly as `in_range` does — never a
        # silent default-to-include.
        if start is None or end is None or not start <= moment <= end:
            continue
        in_window += 1
        dead = is_transport_death(record, signatures)
        if dead:
            deaths += 1
            labels[_non_empty_str(record.get("description")) or UNLABELLED] += 1
        attempt = record.get("attempt")
        if isinstance(attempt, (int, float)) and not isinstance(attempt, bool) and attempt >= 2:
            parent = record.get("resumeOf")
            if isinstance(parent, str) and parent in dead_ids:
                retried += 1
                if dead:
                    died_again += 1
            else:
                # Absent lineage, or a parent that is not a death: the retry happened and we
                # cannot say it followed a transport death — counted, never silently zero.
                resume_unknown += 1
    return {"deaths": deaths, "in_window": in_window, "retried": retried,
            "died_again": died_again, "window_unknown": window_unknown,
            "unreadable": unreadable, "resume_unknown": resume_unknown, "labels": labels}


def fmt_transport(t):
    """The one line the close reads: fixed field order, every figure always printed.

    Zero deaths prints zeroes rather than nothing — a window with no deaths and a reader
    that never ran must not look alike, and a caller only sees this line when the records
    directory was actually read.
    """
    return (f"transport: {t['deaths']} death(s) in {t['in_window']} record(s) in window"
            f" · retried: {t['retried']} · died again: {t['died_again']}"
            f" · window unknown: {t['window_unknown']} · unreadable: {t['unreadable']}"
            f" · resume unknown: {t['resume_unknown']}")


def fmt_transport_labels(t, limit=TRANSPORT_LIMIT):
    """The `--transport` block: labels at >= 2 deaths (count, then name), then the singletons.

    A label with ONE death is never listed — a cycle's tail is mostly singletons, and a
    table of them buries the recurrence the block exists to show — so its count is printed
    instead, and the two lines together account for every death in the window.
    """
    listed = sorted(((-count, label) for label, count in t["labels"].items()
                     if count >= TRANSPORT_LABEL_MIN))[:limit]
    body = " · ".join(f"{label} {-count}" for count, label in listed) or "(none)"
    singles = sum(1 for count in t["labels"].values() if count == TRANSPORT_LABEL_MIN - 1)
    return [f"transport by label (>= {TRANSPORT_LABEL_MIN} deaths): {body}",
            f"labels with exactly 1 death: {singles} (not listed)"]


def render_transport(t, limit=TRANSPORT_LIMIT, labels=True):
    """The transport lines as printed: the reading, then the per-label block when asked."""
    lines = [fmt_transport(t)]
    if labels:
        lines.extend(fmt_transport_labels(t, limit))
    return lines


def transport_reading(args):
    """The transport reading for this invocation, or None when the default path has no store.

    ONE entry point for both modes, so the D1 asymmetry lives in one place: `--transport`
    requires a non-empty directory, the default path omits the line (None) when the
    directory is missing, unreadable or empty.
    """
    records_dir = args.records or os.path.join(os.getcwd(), RECORDS_REL)
    if not args.transport and not records_readable(records_dir):
        return None
    return transport_metrics(records_dir, load_signatures(args.signatures),
                             args.since, args.until, required=args.transport)


TRANSPORT_CORPUS = os.path.join(REPO_ROOT, "fixtures", "572", "corpus")
TRANSPORT_CORPUS_WINDOW = ("2026-11-22T00:00:00Z", "2026-11-22T12:00:00Z")
# The corpus's whole arithmetic (§3). Eleven committed records, and the three lines are
# the spec's own expected output — every number below is derived by the code above, so a
# mutant moves one of them and this tuple is what says so.
TRANSPORT_CORPUS_LINES = (
    "transport: 5 death(s) in 8 record(s) in window · retried: 1 · died again: 1"
    " · window unknown: 1 · unreadable: 1 · resume unknown: 0",
    "transport by label (>= 2 deaths): L1 3",
    "labels with exactly 1 death: 2 (not listed)",
)


def _records_variant(tmp, keep=None, without=()):
    """A temp records directory: the corpus, optionally filtered by name, minus some top-level fields.

    `without` strips one field from every copied record — the one-record mutation a self-test
    needs to prove a counter actually reads that field (§4 A6/A7). The scratch copy is what
    gets mutated; the committed corpus is only ever read.
    """
    target = os.path.join(tmp, "records")
    os.makedirs(target, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(TRANSPORT_CORPUS, "*.json"))):
        name = os.path.basename(path)
        if keep is not None and name not in keep:
            continue
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        if without:
            try:
                record = json.loads(text)
            except ValueError:
                # The unreadable fixture stays unreadable: the variant mutates the records it
                # CAN read, and copying a broken one verbatim is what keeps that case honest.
                record = None
            if isinstance(record, dict):
                for field in without:
                    record.pop(field, None)
                text = json.dumps(record, indent=2) + "\n"
        with open(os.path.join(target, name), "w", encoding="utf-8") as handle:
            handle.write(text)
    return target


def _transport_checks():
    """The corpus assertions and the per-counter fixtures (§4 A1, A6, A7, D2's refusals)."""
    checks = []
    signatures = load_signatures()
    checks.append(("signatures: read from src/transport-retry.ts, not pinned here",
                   len(signatures) >= SIGNATURE_MIN and "connection error" in signatures,
                   f"{len(signatures)} signatures"))

    lines = render_transport(transport_metrics(TRANSPORT_CORPUS, signatures,
                                               *TRANSPORT_CORPUS_WINDOW))
    checks.append(("corpus: the eleven committed records print the spec's three lines",
                   tuple(lines) == TRANSPORT_CORPUS_LINES,
                   " | ".join(lines)))

    with tempfile.TemporaryDirectory() as tmp:
        alone = transport_metrics(_records_variant(tmp, keep={"nostart.json"}),
                                  signatures, *TRANSPORT_CORPUS_WINDOW)
        checks.append(("corpus: an undated record is window unknown, never dropped",
                       alone["window_unknown"] == 1 and alone["in_window"] == 0
                       and alone["deaths"] == 0, fmt_transport(alone)))

    with tempfile.TemporaryDirectory() as tmp:
        broken = transport_metrics(_records_variant(tmp, keep={"bad.json"}),
                                   signatures, *TRANSPORT_CORPUS_WINDOW)
        checks.append(("corpus: an unparsable record is counted, never skipped",
                       broken["unreadable"] == 1 and broken["in_window"] == 0,
                       fmt_transport(broken)))

    with tempfile.TemporaryDirectory() as tmp:
        orphan = transport_metrics(_records_variant(tmp, without=("resumeOf",)),
                                   signatures, *TRANSPORT_CORPUS_WINDOW)
        checks.append(("A6: a retry with no resumeOf is resume unknown, not a retry",
                       (orphan["deaths"], orphan["retried"], orphan["died_again"],
                        orphan["resume_unknown"]) == (5, 0, 0, 1), fmt_transport(orphan)))

    with tempfile.TemporaryDirectory() as tmp:
        keep = {os.path.basename(path) for path in glob.glob(os.path.join(TRANSPORT_CORPUS, "*.json"))}
        parentless = transport_metrics(_records_variant(tmp, keep=keep - {"a.json"}),
                                       signatures, *TRANSPORT_CORPUS_WINDOW)
        checks.append(("A7: a retry whose parent is gone loses both the death and the retry",
                       (parentless["deaths"], parentless["retried"], parentless["died_again"],
                        parentless["resume_unknown"]) == (4, 0, 0, 1), fmt_transport(parentless)))

    with tempfile.TemporaryDirectory() as tmp:
        empty = _records_variant(tmp, keep=set())
        refusals = []
        for label, attempt in (("empty", lambda: transport_metrics(empty, signatures,
                                                                  *TRANSPORT_CORPUS_WINDOW,
                                                                  required=True)),
                               ("missing", lambda: transport_metrics(os.path.join(tmp, "absent"),
                                                                     signatures,
                                                                     *TRANSPORT_CORPUS_WINDOW,
                                                                     required=True))):
            try:
                attempt()
                refusals.append(f"{label}: no refusal")
            except TransportError as exc:
                refusals.append(f"{label}: {exc}")
        checks.append(("A2: the mode refuses an empty and an absent directory, and the default "
                       "report omits the line for an empty one",
                       all("records:" in detail and "no refusal" not in detail
                           for detail in refusals)
                       and transport_metrics(empty, signatures,
                                             *TRANSPORT_CORPUS_WINDOW) is None,
                       " ; ".join(refusals) + " ; default path: no reading"))

    stub_dir = tempfile.mkdtemp()
    commented = os.path.join(stub_dir, "commented.ts")
    with open(commented, "w", encoding="utf-8") as handle:
        handle.write('const TRANSPORT_SIGNATURES = [\n'
                     '\t"connection error",\n\t"econnreset",\n\t"fetch failed",\n'
                     '\t"network error",\n\t"etimedout",\n'
                     '\t// "obsolete pattern",\n] as const;\n')
    parsed = load_signatures(commented)
    short = os.path.join(stub_dir, "short.ts")
    with open(short, "w", encoding="utf-8") as handle:
        handle.write('const TRANSPORT_SIGNATURES = ["a", "b", "c", "d"] as const;\n')
    missing_source = os.path.join(stub_dir, "absent.ts")
    problems = []
    if parsed != ["connection error", "econnreset", "fetch failed", "network error", "etimedout"]:
        problems.append(f"the comment was not stripped: {parsed}")
    for label, path in (("short", short), ("absent", missing_source)):
        try:
            load_signatures(path)
            problems.append(f"{label}: no refusal")
        except TransportError as exc:
            if path not in str(exc):
                problems.append(f"{label}: the path is not named ({exc})")
    checks.append(("D2: a commented-out pattern is not a signature; a short block and a "
                   "missing source each refuse naming the path",
                   not problems, " ; ".join(problems) or f"{len(parsed)} parsed, 2 refusals"))
    return checks


def run_transport_selftest():
    """The transport checks; a broken corpus fails its case instead of crashing the run."""
    try:
        return _transport_checks()
    except Exception as exc:  # noqa: BLE001 — a named failure, never a stack trace
        return [("transport corpus", False, f"{type(exc).__name__}: {exc}")]


def _fmt_call_audit(m):
    """The non-zero-only clauses: what the dispatch count EXCLUDED, and why.

    A window with no refused, unresolved or duplicate call prints nothing here, so its line
    stays byte-identical to the pre-#591 output (the ordinary-pair parity the selftest pins).
    """
    parts = []
    if m.get("refused"):
        parts.append(f"refused: {m['refused']} (harness-rejected)")
    if m.get("failed_after_spawn"):
        parts.append(f"failed after spawn: {m['failed_after_spawn']} (counted as a dispatch)")
    if m.get("unresolved"):
        parts.append(f"unresolved: {m['unresolved']} (no result in the session log)")
    if m.get("duplicate_results"):
        parts.append(f"duplicate: {m['duplicate_results']}")
    return "".join(f" · {part}" for part in parts)


def fmt_dispatches(m):
    """The reconcile line: `dispatches: N (direct A + codemode B) · spawns: M · Δ D`.

    With no spawn log the line says so instead of printing a clean Δ — the
    dispatch count is then a session-log floor, not an authoritative figure.
    """
    line = (f"dispatches:      {m['total_dispatches']} "
            f"(direct {m['direct']} + codemode {m['codemode']})")
    line += _fmt_call_audit(m)
    if m.get("spawns") is None:
        return f"{line} · spawns: n/a · Δ n/a (reconcile unavailable)"
    return f"{line} · spawns: {m['spawns']} · Δ {m['delta']}"


def fmt_table(m, sprint):
    """Render the metrics row for METRICS.md (one sprint per row)."""
    return (
        f"| {sprint} | {m['total_dispatches']} | {m['foreground']}/{m['background']} "
        f"| {m['success_rate']}% ({m['done']}/{m['runs_settled']}) | {m['failed_rate']}% ({m['failed']}) "
        f"| {m['retries']} | {m['retry_success_rate']}% ({m['retry_success']}/{m['retries']}) "
        f"| {m['zero_work']} ({m['zero_work_rate']}%) | {m['poll_per_dispatch']} | {m['steers']} | {m['stops']} |"
    )


def main():
    ap = argparse.ArgumentParser(description="Derive sprint metrics from the pi session log.")
    ap.add_argument("--since", default=(datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d"))
    ap.add_argument("--until", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    ap.add_argument("--log", action="append", help="explicit session log path (repeatable)")
    ap.add_argument("--spawn-log", action="append",
                    help="explicit extension spawn-log path (repeatable; default: "
                         "<cwd>/.pi/subagent-logs/brl-subagent.log + rotated)")
    ap.add_argument("--sprint", default=None, help='cycle label for the METRICS.md row (historically "sprint"; default: since)')
    ap.add_argument("--candidates", default=None,
                    help="derive the friction candidates JSON into this path (exit 2, no file, "
                         "when a session or spawn source is missing or unreadable)")
    ap.add_argument("--out", default=None, help="append the row to this file (e.g. .development/METRICS.md)")
    ap.add_argument("--records", default=None,
                    help="run-record directory for the transport reading (default: "
                         f"<cwd>/{RECORDS_REL}; the default report omits the line when it is absent)")
    ap.add_argument("--transport", action="store_true",
                    help="print the transport deaths per label (refuses --out, and a missing or "
                         "empty --records directory)")
    ap.add_argument("--signatures", default=None,
                    help=f"source of TRANSPORT_SIGNATURES (default: <repo>/{SIGNATURES_REL})")
    ap.add_argument("--limit", type=int, default=TRANSPORT_LIMIT,
                    help="labels listed in the --transport block (default: %(default)s)")
    ap.add_argument("--selftest", action="store_true",
                    help="run the window-boundary + reconcile + candidates self-test and exit (no logs needed)")
    args = ap.parse_args()

    # The two refused combinations of §D1, checked BEFORE any mode runs: a mode that cannot
    # honour its own invariant must never be reached by a longer argument list.
    if args.transport and args.out:
        print("--transport may not write a table row (--out refused): the transport reading is "
              "not a METRICS.md column without a schema migration (issue #572 §5)", file=sys.stderr)
        sys.exit(2)
    if args.transport and (args.selftest or args.candidates):
        print("--transport is a mode of its own (--selftest and --candidates refused together "
              "with it): one invocation, one reading", file=sys.stderr)
        sys.exit(2)

    if args.selftest:
        sys.exit(run_selftest())

    if args.candidates:
        sys.exit(run_candidates(args))

    log_paths = args.log or sorted(glob.glob(SESSION_GLOB))
    if not log_paths:
        print("No session logs found.", file=sys.stderr)
        sys.exit(1)

    # Two passes over the same sources (#591 §2): the result map sees the WHOLE file set, so a
    # result that lands after `--until` still classifies the call it answers; the event stream
    # stays window-filtered, because a dispatch outside the window is not this window's.
    call_results = load_call_results(log_paths)
    events = load_events(log_paths, args.since, args.until)
    m = compute(events, call_results)
    sprint = args.sprint or args.since

    spawn_paths = args.spawn_log or default_spawn_logs()
    reconcile_ok, reconcile_reason = reconcile(m, spawn_paths, args.since, args.until)
    spawn_label = spawn_paths[0]
    if m["spawn_files"] > 1:
        spawn_label = f"{spawn_label} (+{m['spawn_files'] - 1} rotated)"

    # The transport reading is the SECOND source and is read LAST: everything above is the
    # session log, and a checkout with no run store must print exactly what it always printed
    # (the line is omitted, not zeroed — §D1's deliberate asymmetry).
    try:
        transport = transport_reading(args)
    except TransportError as exc:
        print(f"transport: {exc}", file=sys.stderr)
        sys.exit(2)

    print(f"Cycle metrics [{args.since} .. {args.until}] — source: {len(log_paths)} session log(s)")
    print(f"  {fmt_dispatches(m)}")
    print(f"  fg/bg:           {m['foreground']} fg / {m['background']} bg"
          + (f" ({m['codemode_assumed_background']} codemode assumed bg)"
             if m["codemode_assumed_background"] else ""))
    if transport is not None:
        for line in render_transport(transport, args.limit, labels=args.transport):
            print(line)
    if m["spawn_log_found"]:
        print(f"  spawn source:    {spawn_label} (found) — {m['spawns']} starts "
              f"({m['spawn_foreground']} fg / {m['spawn_background']} bg), "
              f"{m['retry_starts']} transport auto-retry starts")
        print(f"  allowance:       {m['allowance']} (retry starts {m['retry_starts']} "
              f"+ fan-out units {m['fanout_extra']})")
    else:
        print(f"  spawn source:    {spawn_label} (NOT FOUND) — reconcile unavailable; "
              f"the dispatch count is a session-log floor")
    if not reconcile_ok:
        print(f"  RECONCILE FAILED: {reconcile_reason}")
    print(f"  runs:            {m['runs_total']} total, {m['runs_settled']} settled "
          f"({m['done']} done, {m['failed']} failed, {m['running']} still running)")
    print(f"  success rate:    {m['success_rate']}%   failed rate: {m['failed_rate']}%")
    print(f"  zero-work:       {m['zero_work']} ({m['zero_work_rate']}% of settled)")
    print(f"  retries:         {m['retries']} — success {m['retry_success_rate']}% "
          f"({m['retry_success']} ok, {m['retry_fail']} failed, {m['retry_missing']} target-missing)")
    print(f"  polling:         {m['polls']} get_subagent_result calls "
          f"({m['poll_per_dispatch']}/dispatch — babysitting proxy)")
    print(f"  steering/stops:  {m['steers']} / {m['stops']}")
    print(f"  templates used:  {sum(m['template_usage'].values())} {dict(m['template_usage']) if m['template_usage'] else ''}")
    print(f"  modes:           {m['mode_usage']}")
    print(f"  presets:         {dict(sorted(m['preset_usage'].items(), key=lambda x: -x[1]))}")

    if args.out and not reconcile_ok:
        print(f"  → row NOT appended to {args.out}: the reconcile failed (fix the count first)",
              file=sys.stderr)
    elif args.out:
        out_path = Path(args.out)
        header = (
            "| Sprint | Dispatches | FG/BG | Success | Failed | Retries | Retry succ | "
            "Zero-work | Poll/dispatch | Steer | Stop |\n"
            "|--------|-----------|-------|---------|--------|---------|------------|----------|--------------|-------|------|"
        )
        if not out_path.exists():
            out_path.write_text(
                f"# Sprint Metrics (Trust Protocol — derived from session logs, never vibed)\n\n{header}\n",
                encoding="utf-8",
            )
        else:
            # Ensure the header exists if the file was created empty/manually
            content = out_path.read_text(encoding="utf-8")
            if "| Sprint | Dispatches |" not in content:
                out_path.write_text(content.rstrip() + "\n\n" + header + "\n", encoding="utf-8")
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(fmt_table(m, sprint) + "\n")
        print(f"  → appended row to {out_path}")

    if not reconcile_ok:
        sys.exit(3)


if __name__ == "__main__":
    main()
