#!/usr/bin/env python3
"""
sprint-metrics.py — the Trust Protocol / Rule 11 extractor (sprint_process_improvements.md).

Derives sprint metrics mechanically from the pi session log — figures are computed,
never vibed. One run produces BOTH outputs:
  1. Trust metrics (dispatch/success/retry/zero-work/polling rates)
  2. Recurrence counts (Rule 11 escalation input — friction classes by tag)

Usage:
  python3 sprint-metrics.py [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--log <path>]
                            [--out .development/METRICS.md] [--sprint "2026-08-16"]

Defaults: --since = today-1 day (covers the current sprint's work), --log = the most
recent session log for this project, --out = none (print only).

Data sources (all automatic, no human entries):
  - delegate_task toolCall events       → dispatch count, fg/bg ratio, retry rate
  - brl-subagent-run custom entries     → success/failed/stopped rates, retry success,
                                          zero-work rate (done + empty fullOutput)
  - get_subagent_result toolCall events → polling frequency (babysitting proxy)

The output table is designed to be appended to .development/METRICS.md (one row per
sprint — the only manual step, sharing the friction-log review cadence).
"""

import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT = "public_projects-brl-subagent_workspace"  # session dir name uses '-' separators
SESSION_GLOB = os.path.expanduser(
    f"~/.pi/agent/sessions/*{PROJECT}*/*.jsonl"
)


def iso_ts(ts) -> str:
    """Normalize a log timestamp to ISO (they arrive as ISO strings)."""
    return str(ts or "")


def in_range(ts: str, since: str, until: str) -> bool:
    """True if ts falls in [since, until] (ISO date strings, inclusive)."""
    if not ts:
        return False
    day = ts[:10]
    return since <= day <= until


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

                    # Tool calls (delegate_task, get_subagent_result, steer, stop)
                    msg = d.get("message") or {}
                    for c in msg.get("content") or []:
                        if not isinstance(c, dict) or c.get("type") != "toolCall":
                            continue
                        name = c.get("name")
                        args = c.get("arguments") or {}
                        if name == "delegate_task":
                            yield ("dispatch", {**args, "_call_id": c.get("id")}, ts)
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
    dispatch_ids = []    # (call_id, label) in order
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
            dispatch_ids.append((payload.get("_call_id"), payload.get("label")))
            if payload.get("background"):
                bg_count += 1
            else:
                fg_count += 1
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
        if not label:
            retry_missing += 1
            continue
        # Find the run entry spawned by THIS retry dispatch (same label,
        # id != retryRunId). If multiple, take the settled one.
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

    total_dispatches = len(dispatch_ids)
    settled = len(finalized)
    done = statuses.get("done", 0)
    failed = statuses.get("failed", 0)
    running = statuses.get("running", 0)

    return {
        "total_dispatches": total_dispatches,
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
    ap.add_argument("--sprint", default=None, help="sprint label for the METRICS.md row (default: since)")
    ap.add_argument("--out", default=None, help="append the row to this file (e.g. .development/METRICS.md)")
    args = ap.parse_args()

    log_paths = args.log or sorted(glob.glob(SESSION_GLOB))
    if not log_paths:
        print("No session logs found.", file=sys.stderr)
        sys.exit(1)

    events = load_events(log_paths, args.since, args.until)
    m = compute(events)
    sprint = args.sprint or args.since

    print(f"Sprint metrics [{args.since} .. {args.until}] — source: {len(log_paths)} session log(s)")
    print(f"  dispatches:      {m['total_dispatches']} (fg {m['foreground']} / bg {m['background']})")
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

    if args.out:
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


if __name__ == "__main__":
    main()
