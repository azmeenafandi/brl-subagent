#!/usr/bin/env python3
"""Mutation pilot driver for src/scheduler.ts. One mutation at a time, always restores."""
import subprocess, sys, os, re

REPO = "/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-wt-232"
TARGET = "src/scheduler.ts"
FINDINGS = "/tmp/mutation-pilot-scheduler.md"
TESTLOG = "/tmp/mutation-%d.log"
DIFFLOG = "/tmp/mutation-%d-diff.txt"

# (n, description, prediction, find, replace)
MUTANTS = [
    (1,  "`if (depColor === 1)` -> `if (depColor === 2)` (cycle detection branch)", "KILLED",
     "\t\t\t\tif (depColor === 1) {", "\t\t\t\tif (depColor === 2) {"),
    (2,  "`depColor === 0 && dfs(dep)` -> `depColor === 2 && dfs(dep)`", "SURVIVED",
     "if (depColor === 0 && dfs(dep)) {", "if (depColor === 2 && dfs(dep)) {"),
    (3,  "`color.get(t.id) === 0` -> `!== 0` (outer DFS entry guard)", "KILLED",
     "if (color.get(t.id) === 0) {", "if (color.get(t.id) !== 0) {"),
    (4,  "`color.set(nodeId, 2)` -> `color.set(nodeId, 0)` (black -> white)", "KILLED",
     "color.set(nodeId, 2);", "color.set(nodeId, 0);"),
    (5,  "`newDegree = (inDegree.get(depId) ?? 1) - 1` -> `+ 1`", "KILLED",
     "const newDegree = (inDegree.get(depId) ?? 1) - 1;",
     "const newDegree = (inDegree.get(depId) ?? 1) + 1;"),
    (6,  "`if (newDegree === 0)` -> `if (newDegree !== 0)`", "KILLED",
     "if (newDegree === 0) {", "if (newDegree !== 0) {"),
    (7,  "`if (processed.has(depId)) continue;` -> `if (false) continue;`", "SURVIVED",
     "if (processed.has(depId)) continue;", "if (false) continue;"),
    (8,  "Remove `.sort((a, b) => a.id.localeCompare(b.id))` from INITIAL wave assignment", "SURVIVED",
     "\tlet currentWave = tasks\n\t\t.filter((t) => (inDegree.get(t.id) ?? 0) === 0)\n\t\t.sort((a, b) => a.id.localeCompare(b.id));",
     "\tlet currentWave = tasks.filter((t) => (inDegree.get(t.id) ?? 0) === 0);"),
    (9,  "`tasks.length > MAX_GRAPH_TASKS` -> `>=`", "KILLED",
     "if (tasks.length > MAX_GRAPH_TASKS) {", "if (tasks.length >= MAX_GRAPH_TASKS) {"),
    (10, "`tasks.length === 0` -> `tasks.length === -1` (empty-graph guard)", "KILLED",
     "if (tasks.length === 0) {", "if (tasks.length === -1) {"),
    (11, "`if (ids.has(t.id))` -> `if (false)` (duplicate-ID check)", "KILLED",
     "if (ids.has(t.id)) {", "if (false) {"),
    (12, "`if (!ids.has(dep))` -> `if (ids.has(dep))` (missing-dep check)", "KILLED",
     "if (!ids.has(dep)) {", "if (ids.has(dep)) {"),
    (13, "in-degree counting loop `if (byId.has(dep))` -> `if (true)` (by-design equivalent)", "SURVIVED",
     "\t\t\tif (byId.has(dep)) {\n\t\t\t\tinDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);",
     "\t\t\tif (true) {\n\t\t\t\tinDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);"),
    (14, "Remove `path.pop();` in detectCycle's dfs", "SURVIVED",
     "\t\tpath.pop();\n\t\tcolor.set(nodeId, 2);", "\t\tcolor.set(nodeId, 2);"),
]


def sh(cmd):
    return subprocess.run(cmd, shell=True, cwd=REPO, capture_output=True, text=True)


def git_dirty():
    r = sh("git status --porcelain --untracked-files=no")
    return r.stdout.strip()


def restore():
    sh("git checkout -- " + TARGET)


def append(text):
    with open(FINDINGS, "a") as f:
        f.write(text)


only = [int(x) for x in sys.argv[1:]] if len(sys.argv) > 1 else [m[0] for m in MUTANTS]

for n, desc, pred, find, repl in MUTANTS:
    if n not in only:
        continue

    # 1. restore + verify clean
    restore()
    if git_dirty():
        append("\n### Mutant %d — ABORTED: worktree not clean before start\n```\n%s\n```\n" % (n, git_dirty()))
        print(n, "ABORT dirty"); continue

    src = open(os.path.join(REPO, TARGET)).read()
    cnt = src.count(find)
    if cnt != 1:
        append("\n### Mutant %d — UNVERIFIABLE (find text occurs %d times)\n```\n%s\n```\n" % (n, cnt, find))
        print(n, "UNVERIFIABLE count=%d" % cnt); continue

    # 2. apply
    open(os.path.join(REPO, TARGET), "w").write(src.replace(find, repl, 1))

    # 3. record diff
    d = sh("git diff --unified=0 " + TARGET).stdout
    open(DIFFLOG % n, "w").write(d)
    if not d.strip():
        restore()
        append("\n### Mutant %d — UNVERIFIABLE (empty diff after apply)\n" % n)
        print(n, "UNVERIFIABLE empty diff"); continue

    # 4. run tests
    log = TESTLOG % n
    r = sh("npx vitest run src/__tests__/scheduler.test.ts > %s 2>&1" % log)
    txt = open(log).read()
    killed = r.returncode != 0

    # 6. failing test names
    fails = []
    for line in txt.splitlines():
        m = re.match(r"^\s*[×✗x]\s+(.+?)\s*$", line)
        if m and m.group(1) not in fails:
            fails.append(m.group(1))
    summary = ""
    for line in txt.splitlines():
        if re.search(r"Tests\s+.*(passed|failed)", line):
            summary = line.strip()

    verdict = "KILLED" if killed else "SURVIVED"
    match = "MATCH" if verdict == pred else "MISMATCH"

    # 7. restore + verify clean
    restore()
    dirty_after = git_dirty()

    row = {
        1: ("| 1 | `depColor === 1` -> `depColor === 2` (cycle detection) | KILLED | %s | %s | %s |" % (verdict, "; ".join(fails) or "-", match)),
        }
    append("\n### Mutant %d — %s\n" % (n, verdict))
    append("- Description: %s\n" % desc)
    append("- Prediction: %s / Actual: %s / **%s**\n" % (pred, verdict, match))
    append("- Test summary: %s\n" % (summary or "?"))
    append("- Failing tests: %s\n" % (", ".join("`%s`" % f for f in fails) if fails else "(none)"))
    append("- Diff proof: `/tmp/mutation-%d-diff.txt`\n" % n)
    append("- Worktree clean after restore: %s\n" % ("YES" if not dirty_after else "NO -> " + dirty_after))
    append("\n```diff\n%s```\n" % d)
    print(n, verdict, match, fails)
