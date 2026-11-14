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
  python3 sprint-metrics.py --selftest   # window-boundary + reconcile guard (CI-wired)

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

Reconcile (issue #489): `dispatches: N (direct A + codemode B) · spawns: M · Δ D`, where
M is the extension log's run-start count in the SAME window and D = M - N. Spawns may
legitimately exceed calls by the window's transport auto-retry starts plus its fan-out
units beyond the first; both are counted, so the allowance is derived, not guessed.
A negative Δ (a counted dispatch produced no spawn) or a Δ above that allowance is a
LOUD failure: a named `RECONCILE FAILED:` line, no row appended, exit 3.

Exit codes: 0 ok · 1 no session logs · 2 selftest failure · 3 reconcile failed.

The output table is designed to be appended to .development/METRICS.md (one row per
sprint — the only manual step, sharing the friction-log review cadence).
"""

import argparse
import glob
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
    s = _parse_ts(since)
    u = _parse_ts(until)
    if t is None or s is None or u is None:
        return False
    if len(str(since).strip()) <= 10:
        s = s.replace(hour=0, minute=0, second=0, microsecond=0)
    if len(str(until).strip()) <= 10:
        u = u.replace(hour=23, minute=59, second=59, microsecond=999999)
    return s <= t <= u


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


def _tool_call(name, args, call_id):
    return {"timestamp": SELFTEST_TS, "message": {"content": [
        {"type": "toolCall", "id": call_id, "name": name, "arguments": args},
    ]}}


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


def run_reconcile_case(case):
    """Run one reconcile fixture in a temp dir; return (ok, line, reason, problems)."""
    _name, session_entries, spawn_entries, exp_direct, exp_codemode, exp_spawns, exp_ok = case
    with tempfile.TemporaryDirectory() as tmp:
        session_path = os.path.join(tmp, "session.jsonl")
        spawn_path = os.path.join(tmp, "spawn.log")
        _write_jsonl(session_path, session_entries)
        _write_jsonl(spawn_path, spawn_entries)
        m = compute(load_events([session_path], *SELFTEST_WINDOW))
        ok, reason = reconcile(m, [spawn_path], *SELFTEST_WINDOW)
        line = fmt_dispatches(m)
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


def run_selftest() -> int:
    """Exercise the window parser's boundaries and the reconcile; 1 on failure."""
    total = len(SELFTEST_CASES) + len(RECONCILE_SELFTEST_CASES)
    print(f"sprint-metrics --selftest: {len(SELFTEST_CASES)} boundary cases "
          f"+ {len(RECONCILE_SELFTEST_CASES)} reconcile cases")
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


def load_events(log_paths, since, until):
    """Yield (kind, payload, ts) for every relevant event in range."""
    for path in log_paths:
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ts = iso_ts(d.get("timestamp"))
                    if not in_range(ts, since, until):
                        continue

                    # Run entries (custom type) — the settlement record
                    if d.get("type") == "custom" and d.get("customType") == "brl-subagent-run":
                        yield ("run", d.get("data") or {}, ts)
                        continue

                    # Tool calls (delegate_task, codemode, get_subagent_result, steer, stop)
                    msg = d.get("message") or {}
                    for c in msg.get("content") or []:
                        if not isinstance(c, dict) or c.get("type") != "toolCall":
                            continue
                        name = c.get("name")
                        args = c.get("arguments") or {}
                        if name == "delegate_task":
                            yield ("dispatch", {**args, "_call_id": c.get("id"), "_route": "direct"}, ts)
                        elif name == "codemode":
                            # Issue #489: a dispatch issued from inside a codemode
                            # script is a codemode toolCall, so the direct scan could
                            # never see it.
                            for background in codemode_dispatches(args.get("code") or ""):
                                yield ("dispatch", {"_call_id": c.get("id"),
                                                    "_route": "codemode",
                                                    "background": background}, ts)
                        elif name == "get_subagent_result":
                            yield ("poll", args, ts)
                        elif name == "steer_subagent":
                            yield ("steer", args, ts)
                        elif name == "stop_subagent":
                            yield ("stop", args, ts)
        except FileNotFoundError:
            continue


def compute(events):
    """Reduce events to the metrics dict."""
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
            dispatch_ids.append((payload.get("_call_id"), payload.get("label")))
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
    found = False
    files = 0
    bg_ids = set()
    fg = 0
    retry_starts = 0
    for path in spawn_paths:
        if not os.path.exists(path):
            continue
        found = True
        files += 1
        try:
            handle = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not in_range(iso_ts(d.get("timestamp")), since, until):
                    continue
                message = d.get("message")
                data = d.get("data") or {}
                if message == BG_SPAWN_MESSAGE:
                    bg_ids.add(data.get("agentId") or f"{path}:{d.get('timestamp')}")
                elif message == FG_SPAWN_MESSAGE:
                    fg += 1
                elif message == RETRY_SPAWN_MESSAGE:
                    retry_starts += 1
    return {"found": found, "files": files, "background": len(bg_ids), "foreground": fg,
            "spawns": len(bg_ids) + fg, "retry_starts": retry_starts}


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


def fmt_dispatches(m):
    """The reconcile line: `dispatches: N (direct A + codemode B) · spawns: M · Δ D`.

    With no spawn log the line says so instead of printing a clean Δ — the
    dispatch count is then a session-log floor, not an authoritative figure.
    """
    line = (f"dispatches:      {m['total_dispatches']} "
            f"(direct {m['direct']} + codemode {m['codemode']})")
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
    ap.add_argument("--out", default=None, help="append the row to this file (e.g. .development/METRICS.md)")
    ap.add_argument("--selftest", action="store_true",
                    help="run the window-boundary + reconcile self-test and exit (no logs needed)")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(run_selftest())

    log_paths = args.log or sorted(glob.glob(SESSION_GLOB))
    if not log_paths:
        print("No session logs found.", file=sys.stderr)
        sys.exit(1)

    events = load_events(log_paths, args.since, args.until)
    m = compute(events)
    sprint = args.sprint or args.since

    spawn_paths = args.spawn_log or default_spawn_logs()
    reconcile_ok, reconcile_reason = reconcile(m, spawn_paths, args.since, args.until)
    spawn_label = spawn_paths[0]
    if m["spawn_files"] > 1:
        spawn_label = f"{spawn_label} (+{m['spawn_files'] - 1} rotated)"

    print(f"Cycle metrics [{args.since} .. {args.until}] — source: {len(log_paths)} session log(s)")
    print(f"  {fmt_dispatches(m)}")
    print(f"  fg/bg:           {m['foreground']} fg / {m['background']} bg"
          + (f" ({m['codemode_assumed_background']} codemode assumed bg)"
             if m["codemode_assumed_background"] else ""))
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
