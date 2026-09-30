# Mutation Pilot — src/scheduler.ts

- Repo: brl-subagent (scratch worktree brl-subagent-wt-232)
- Base commit: b7c52e4
- Test target: `src/__tests__/scheduler.test.ts` (17 tests)
- Baseline: **17 passed, exit 0**
- NO COMMITS made. Only `src/scheduler.ts` edited, restored after every mutant.

## Results

| # | Mutation | Prediction | Verdict | Failing tests | Match? |
|---|----------|-----------|---------|---------------|--------|
| 1 | `depColor === 1` → `depColor === 2` (cycle detection) | KILLED | **KILLED** | `linear chain A→B→C produces 3 waves`, `diamond graph produces 3 waves (A, B+C parallel, D)`, `mixed deps produce 2 waves (A+C parallel, B)`, `handles tasks already in topological order`, `root node without dependsOn field + dependent produces 2 waves`, `detects self-loop (A→A)`, `detects mutual dependency (A↔B)`, `returns null for valid DAG` | MATCH (8/17) |
| 2 | `depColor === 0 && dfs(dep)` → `depColor === 2` | SURVIVED | **SURVIVED** | - | MATCH |
| 3 | `color.get(t.id) === 0` → `!== 0` (outer DFS guard) | KILLED | **KILLED** | `detects self-loop (A→A)`, `detects mutual dependency (A↔B)` | MATCH (2/17) |
| 4 | `color.set(nodeId, 2)` → `color.set(nodeId, 0)` | KILLED | **SURVIVED** | - | **MISMATCH** (predicted KILLED) |
| 5 | `newDegree = … - 1` → `+ 1` | KILLED | **KILLED** | `linear chain A→B→C produces 3 waves`, `diamond graph produces 3 waves (A, B+C parallel, D)`, `mixed deps produce 2 waves (A+C parallel, B)`, `handles tasks already in topological order`, `root node without dependsOn field + dependent produces 2 waves` | MATCH (5/17) |
| 6 | `if (newDegree === 0)` → `!== 0` | KILLED | **KILLED** | `linear chain A→B→C produces 3 waves`, `diamond graph produces 3 waves (A, B+C parallel, D)`, `mixed deps produce 2 waves (A+C parallel, B)`, `handles tasks already in topological order`, `root node without dependsOn field + dependent produces 2 waves` | MATCH (5/17) |
| 7 | `if (processed.has(depId)) continue;` → `if (false) continue;` | SURVIVED | **SURVIVED** | - | MATCH |
| 8 | Remove `.sort(localeCompare)` from INITIAL wave assignment | SURVIVED | **SURVIVED** | - | MATCH |
| 9 | `tasks.length > MAX_GRAPH_TASKS` → `>=` | KILLED | **KILLED** | `accepts graph at exactly MAX_GRAPH_TASKS` | MATCH (1/17) |
| 10 | `tasks.length === 0` → `=== -1` (empty-graph guard) | KILLED | **KILLED** | `returns error for empty graph` | MATCH (1/17) |
| 11 | `if (ids.has(t.id))` → `if (false)` (dup-ID check) | KILLED | **KILLED** | `returns error for duplicate task IDs` | MATCH (1/17) |
| 12 | `if (!ids.has(dep))` → `if (ids.has(dep))` | KILLED | **KILLED** | `returns error for missing dependency reference`, `returns empty errors for valid small graph` | MATCH (2/17) |
| 13 | in-degree loop `if (byId.has(dep))` → `if (true)` | SURVIVED (equiv) | **SURVIVED** | - | MATCH (equivalent mutant) |
| 14 | Remove `path.pop();` in detectCycle's dfs | SURVIVED | **SURVIVED** | - | MATCH |

## Per-mutant detail

(appended as each mutant completes)

### Mutant 1 — KILLED
- Description: `if (depColor === 1)` -> `if (depColor === 2)` (cycle detection branch)
- Prediction: KILLED / Actual: KILLED / **MATCH**
- Test summary: Tests  8 failed | 9 passed (17)
- Failing tests: `linear chain A→B→C produces 3 waves 7ms`, `diamond graph produces 3 waves (A, B+C parallel, D) 1ms`, `mixed deps produce 2 waves (A+C parallel, B) 1ms`, `handles tasks already in topological order 0ms`, `root node without dependsOn field + dependent produces 2 waves 1ms`, `detects self-loop (A→A) 2ms`, `detects mutual dependency (A↔B) 0ms`, `returns null for valid DAG 1ms`
- Diff proof: `/tmp/mutation-1-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..7638085 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -38 +38 @@ export function detectCycle(tasks: GraphTask[]): string[] | null {
-				if (depColor === 1) {
+				if (depColor === 2) {
```

### Mutant 2 — SURVIVED
- Description: `depColor === 0 && dfs(dep)` -> `depColor === 2 && dfs(dep)`
- Prediction: SURVIVED / Actual: SURVIVED / **MATCH**
- Test summary: Tests  17 passed (17)
- Failing tests: (none)
- Diff proof: `/tmp/mutation-2-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..ed45bb2 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -44 +44 @@ export function detectCycle(tasks: GraphTask[]): string[] | null {
-				if (depColor === 0 && dfs(dep)) {
+				if (depColor === 2 && dfs(dep)) {
```

### Mutant 3 — KILLED
- Description: `color.get(t.id) === 0` -> `!== 0` (outer DFS entry guard)
- Prediction: KILLED / Actual: KILLED / **MATCH**
- Test summary: Tests  2 failed | 15 passed (17)
- Failing tests: `detects self-loop (A→A) 4ms`, `detects mutual dependency (A↔B) 1ms`
- Diff proof: `/tmp/mutation-3-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..c8b1a7f 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -56 +56 @@ export function detectCycle(tasks: GraphTask[]): string[] | null {
-		if (color.get(t.id) === 0) {
+		if (color.get(t.id) !== 0) {
```

### Mutant 4 — SURVIVED
- Description: `color.set(nodeId, 2)` -> `color.set(nodeId, 0)` (black -> white)
- Prediction: KILLED / Actual: SURVIVED / **MISMATCH**
- Test summary: Tests  17 passed (17)
- Failing tests: (none)
- Diff proof: `/tmp/mutation-4-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..f524a2f 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -51 +51 @@ export function detectCycle(tasks: GraphTask[]): string[] | null {
-		color.set(nodeId, 2);
+		color.set(nodeId, 0);
```

### Mutant 5 — KILLED
- Description: `newDegree = (inDegree.get(depId) ?? 1) - 1` -> `+ 1`
- Prediction: KILLED / Actual: KILLED / **MATCH**
- Test summary: Tests  5 failed | 12 passed (17)
- Failing tests: `linear chain A→B→C produces 3 waves 8ms`, `diamond graph produces 3 waves (A, B+C parallel, D) 1ms`, `mixed deps produce 2 waves (A+C parallel, B) 1ms`, `handles tasks already in topological order 1ms`, `root node without dependsOn field + dependent produces 2 waves 2ms`
- Diff proof: `/tmp/mutation-5-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..dfe95a1 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -131 +131 @@ export function topologicalSort(tasks: GraphTask[]):
-				const newDegree = (inDegree.get(depId) ?? 1) - 1;
+				const newDegree = (inDegree.get(depId) ?? 1) + 1;
```

### Mutant 6 — KILLED
- Description: `if (newDegree === 0)` -> `if (newDegree !== 0)`
- Prediction: KILLED / Actual: KILLED / **MATCH**
- Test summary: Tests  5 failed | 12 passed (17)
- Failing tests: `linear chain A→B→C produces 3 waves 8ms`, `diamond graph produces 3 waves (A, B+C parallel, D) 1ms`, `mixed deps produce 2 waves (A+C parallel, B) 1ms`, `handles tasks already in topological order 1ms`, `root node without dependsOn field + dependent produces 2 waves 2ms`
- Diff proof: `/tmp/mutation-6-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..ed4bd4a 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -133 +133 @@ export function topologicalSort(tasks: GraphTask[]):
-				if (newDegree === 0) {
+				if (newDegree !== 0) {
```

### Mutant 7 — SURVIVED
- Description: `if (processed.has(depId)) continue;` -> `if (false) continue;`
- Prediction: SURVIVED / Actual: SURVIVED / **MATCH**
- Test summary: Tests  17 passed (17)
- Failing tests: (none)
- Diff proof: `/tmp/mutation-7-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..f9069ec 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -130 +130 @@ export function topologicalSort(tasks: GraphTask[]):
-				if (processed.has(depId)) continue;
+				if (false) continue;
```

### Mutant 8 — SURVIVED
- Description: Remove `.sort((a, b) => a.id.localeCompare(b.id))` from INITIAL wave assignment
- Prediction: SURVIVED / Actual: SURVIVED / **MATCH**
- Test summary: Tests  17 passed (17)
- Failing tests: (none)
- Diff proof: `/tmp/mutation-8-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..6b7ff42 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -118,3 +118 @@ export function topologicalSort(tasks: GraphTask[]):
-	let currentWave = tasks
-		.filter((t) => (inDegree.get(t.id) ?? 0) === 0)
-		.sort((a, b) => a.id.localeCompare(b.id));
+	let currentWave = tasks.filter((t) => (inDegree.get(t.id) ?? 0) === 0);
```

### Mutant 9 — KILLED
- Description: `tasks.length > MAX_GRAPH_TASKS` -> `>=`
- Prediction: KILLED / Actual: KILLED / **MATCH**
- Test summary: Tests  1 failed | 16 passed (17)
- Failing tests: `accepts graph at exactly MAX_GRAPH_TASKS 6ms`
- Diff proof: `/tmp/mutation-9-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..9de9e63 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -162 +162 @@ export function validateGraph(tasks: GraphTask[]): string[] {
-	if (tasks.length > MAX_GRAPH_TASKS) {
+	if (tasks.length >= MAX_GRAPH_TASKS) {
```

### Mutant 10 — KILLED
- Description: `tasks.length === 0` -> `tasks.length === -1` (empty-graph guard)
- Prediction: KILLED / Actual: KILLED / **MATCH**
- Test summary: Tests  1 failed | 16 passed (17)
- Failing tests: `returns error for empty graph 7ms`
- Diff proof: `/tmp/mutation-10-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..d6663eb 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -157 +157 @@ export function validateGraph(tasks: GraphTask[]): string[] {
-	if (tasks.length === 0) {
+	if (tasks.length === -1) {
```

### Mutant 11 — KILLED
- Description: `if (ids.has(t.id))` -> `if (false)` (duplicate-ID check)
- Prediction: KILLED / Actual: KILLED / **MATCH**
- Test summary: Tests  1 failed | 16 passed (17)
- Failing tests: `returns error for duplicate task IDs 5ms`
- Diff proof: `/tmp/mutation-11-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..97152bd 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -170 +170 @@ export function validateGraph(tasks: GraphTask[]): string[] {
-		if (ids.has(t.id)) {
+		if (false) {
```

### Mutant 12 — KILLED
- Description: `if (!ids.has(dep))` -> `if (ids.has(dep))` (missing-dep check)
- Prediction: KILLED / Actual: KILLED / **MATCH**
- Test summary: Tests  2 failed | 15 passed (17)
- Failing tests: `returns error for missing dependency reference 6ms`, `returns empty errors for valid small graph 1ms`
- Diff proof: `/tmp/mutation-12-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..04454bd 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -178 +178 @@ export function validateGraph(tasks: GraphTask[]): string[] {
-			if (!ids.has(dep)) {
+			if (ids.has(dep)) {
```

### Mutant 13 — SURVIVED
- Description: in-degree counting loop `if (byId.has(dep))` -> `if (true)` (by-design equivalent)
- Prediction: SURVIVED / Actual: SURVIVED / **MATCH**
- Test summary: Tests  17 passed (17)
- Failing tests: (none)
- Diff proof: `/tmp/mutation-13-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..a57be30 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -97 +97 @@ export function topologicalSort(tasks: GraphTask[]):
-			if (byId.has(dep)) {
+			if (true) {
```

### Mutant 14 — SURVIVED
- Description: Remove `path.pop();` in detectCycle's dfs
- Prediction: SURVIVED / Actual: SURVIVED / **MATCH**
- Test summary: Tests  17 passed (17)
- Failing tests: (none)
- Diff proof: `/tmp/mutation-14-diff.txt`
- Worktree clean after restore: YES

```diff
diff --git a/src/scheduler.ts b/src/scheduler.ts
index beb913f..d812fd1 100644
--- a/src/scheduler.ts
+++ b/src/scheduler.ts
@@ -50 +49,0 @@ export function detectCycle(tasks: GraphTask[]): string[] | null {
-		path.pop();
```

## Summary

- **Killed: 8** (#1, #3, #5, #6, #9, #10, #11, #12)
- **Survived: 6** (#2, #4, #7, #8, #13, #14)
- **Unverifiable: 0**
- Mutation score: 8/14 = 57%
- Prediction match: 13/14 (only #4 mismatched — predicted KILLED, actually SURVIVED)

## Survivor triage (judgement)

- **#13 (`byId.has(dep)` → `true` in the in-degree loop): TRUE EQUIVALENT MUTANT.** The very next
  test in the same suite (`returns error for missing dependency reference`) and the runtime path
  both filter such graphs out before `topologicalSort`; a dangling dep id is never present in
  `byId`, so the increment and `inDegree.set` are unreachable for the surviving inputs. No test
  can kill this. Not a gap — discard from the score denominator.
- **#2 (`depColor === 0` → `depColor === 2`): NEAR-EQUIVALENT / dead branch.** In the three-color
  DFS, `depColor === 2` (black/done) nodes are never recursed into. Removing the recursion into
  white nodes is observationally equivalent for cycle *detection* because the outer
  `for (const t of tasks) if (color.get(t.id) === 0)` loop re-enters dfs on any node left white.
  Equivalent for the boolean/cycle output; the only observable difference would be traversal
  cost, which no test asserts. Not a real correctness gap.
- **#14 (remove `path.pop();`): TRUE EQUIVALENT for these inputs.** `path` is only ever read via
  `path.indexOf(dep)` inside the cycle branch and returned as `[...path]` when a cycle IS found.
  A cycle is only ever reported on the first `return true` (immediately after `path.push(dep)`),
  so the pop on backtrack never affects any returned value. Equivalent, not a gap.
- **#4 (`color.set(nodeId, 2)` → `0`): REAL GAP — the only true survivor of concern.**
  This is the one survivor I judge to be a genuine test weakness. The mutation resets finished
  nodes to white, causing repeated re-visits. It does not change the returned cycle/null result
  for any DAG the suite builds (the re-visit is idempotent), but it is exactly the invariant
  that makes the DFS O(V+E) and prevents redundant work, and no test observes it. A
  traversal-count or call-count assertion (or a graph where a stale-white node changes
  `path.indexOf` results) would kill it. Low severity, but it is the honest signal here.
- **#7 (`processed.has(depId)` → `if (false)`): REAL GAP, but benign.** The guard is a
  no-op for acyclic inputs that reach this code (Kahn's algorithm only decrements a dep the first
  time its last parent is processed; `dependents` lists each dependent once per edge). Mutating it
  away does not change wave contents for the suite's graphs, so survival is arguably
  equivalent-on-this-input-class rather than a missing assertion. Worth a test with a
  multi-parent node whose dependents list would double-decrement if the guard were removed AND
  the resulting negative in-degree pushed a task early. Judgement: real but low-value gap.
- **#8 (remove initial-wave sort): REAL GAP, weak.** Every suite fixture is already supplied in
  alphabetical order, so the initial sort is a no-op on all 17 tests. Only later waves are sorted
  by an explicit test-visible assertion path. A single fixture with out-of-order input tasks
  (e.g. `[C, A, B]` with C depending on B) would kill it. Cheapest fix of the three real gaps.

**Net judgement:** of the 6 survivors, 3 (#2, #13, #14) are equivalent mutants that no test could
ever kill and which should be excluded from the score. The remaining 3 (#4, #7, #8) are genuine
gaps, all of the same species: the fixtures never vary the *order* tasks are supplied in, never
exercise a node that is a dependent of two tasks in the same wave in a way that stresses the
`processed` guard, and never observe traversal work. All three are cheap to close with three
additional fixtures. Effective mutation score excluding true equivalents: 8/11 = 73%.
