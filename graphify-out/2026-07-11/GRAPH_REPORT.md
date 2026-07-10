# Graph Report - .  (2026-07-10)

## Corpus Check
- 66 files · ~65,092 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 450 nodes · 1204 edges · 22 communities (19 shown, 3 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 20 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Metrics & Formatting
- Core Execution Engine
- Logging System
- Git Integration
- Run History
- State Management
- Phase 5 Hardening
- Chain & Parallel Tests
- Presets
- Session State
- Reports
- Package Config
- Backend System
- Metrics & SLA
- Diff Parsing
- Concurrency & Priority
- Cost Tracking
- E2E Subprocess Tests
- E2E Jiti Tests
- Git Tests
- Preflight Tests

## God Nodes (most connected - your core abstractions)
1. `execute()` - 37 edges
2. `runSubagent()` - 28 edges
3. `SessionState` - 25 edges
4. `showSelectList()` - 25 edges
5. `Logger` - 18 edges
6. `runGraphMode()` - 17 edges
7. `runChainMode()` - 16 edges
8. `runParallelMode()` - 16 edges
9. `Scheduler` - 16 edges
10. `renderDelegateResult()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `Data Analyst Preset` --configures--> `delegate_task Tool`  [INFERRED]
  presets/data-analyst.md → README.md
- `Dev Agent Preset` --uses--> `Git Integration`  [INFERRED]
  presets/dev-agent.md → README.md
- `Technical Writer Preset` --configures--> `delegate_task Tool`  [INFERRED]
  presets/tech-writer.md → README.md
- `Test Engineer Preset` --configures--> `delegate_task Tool`  [INFERRED]
  presets/test-engineer.md → README.md
- `Code Reviewer Preset` --configures--> `delegate_task Tool`  [INFERRED]
  presets/code-reviewer.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Delegation Preset Ecosystem** — presets_code_reviewer, presets_data_analyst, presets_debugger, presets_dev_agent, presets_rapid_prototyper, presets_refactorer, presets_security_auditor, presets_tech_writer, presets_test_engineer [INFERRED 0.75]
- **Phase 5 Hardening Features** — phase5_hardening, h1_pre_task_validation, h2_integration_test_suite, h3_post_mortem_diagnostics, h4_conductor_guardrails [EXTRACTED 1.00]

## Communities (22 total, 3 thin omitted)

### Community 0 - "Metrics & Formatting"
Cohesion: 0.06
Nodes (73): formatRunDuration(), renderCall(), renderResult(), computeCostTrend(), formatSparkline(), formatPresetSummary(), extractParamNames(), resolveTemplate() (+65 more)

### Community 1 - "Core Execution Engine"
Cohesion: 0.06
Nodes (53): acquireSlot(), releaseSlot(), updateProgressStatus(), resolveRetryParams(), execute(), mergeSubTaskParams(), resolveSubagentModel(), resolveSubagentParams() (+45 more)

### Community 2 - "Logging System"
Cohesion: 0.07
Nodes (11): createLogger(), LOG_LEVELS, Logger, ProcessPool, ScheduleConfig, ScheduleEntry, Scheduler, LogLevel (+3 more)

### Community 3 - "Git Integration"
Cohesion: 0.15
Nodes (22): updateStatus(), captureDiff(), createWorkBranch(), deleteBranch(), getCurrentBranch(), gitOpts(), hasUncommittedChanges(), mergeWorkBranch() (+14 more)

### Community 4 - "Run History"
Cohesion: 0.10
Nodes (20): cleanupRuns(), createEmptyResult(), finalizeRunRecord(), pruneSessionRuns(), BASE_PARAMS, BASE_RUN, buildRuns(), ERROR_CASES (+12 more)

### Community 5 - "State Management"
Cohesion: 0.12
Nodes (19): createSessionState(), ApprovalMode, AVAILABLE_BACKENDS, ComplianceSummary, CUSTOM_ENTRY_TYPES, FileAccessReport, GitMode, GraphDetails (+11 more)

### Community 6 - "Phase 5 Hardening"
Cohesion: 0.15
Nodes (23): delegate_task Tool, Git Integration, H1 Pre-task Validation, H2 Integration Test Suite, H3 Post-mortem Diagnostics, H4 Conductor Guardrails, Observability Dashboard, Phase 5 Hardening (+15 more)

### Community 7 - "Chain & Parallel Tests"
Cohesion: 0.16
Nodes (17): mergeSubTaskParams(), ResolvedParamsLike, resolveThinkingLevel(), SubagentToolOptions, SubTaskParams, ThinkingLevel, DiagnoseConfig, diagnoseFailure() (+9 more)

### Community 8 - "Presets"
Cohesion: 0.19
Nodes (14): getAllPresets(), loadBuiltinPresets(), parseFrontmatter(), validateAllPresets(), validatePreset(), autoRoutePreset(), CLASSIFICATION_RULES, ClassificationRule (+6 more)

### Community 9 - "Session State"
Cohesion: 0.16
Nodes (3): SessionState, CircuitBreakerState, LiveSubagent

### Community 10 - "Reports"
Cohesion: 0.26
Nodes (9): buildFileAccessReport(), buildSecretsExposureReport(), extractFilesFromGitDiff(), extractFilesFromOutputSummary(), FILE_SEVERITY_MAP, generateComplianceSummary(), hasSensitiveTaskKeywords(), SENSITIVE_FILE_PATTERNS (+1 more)

### Community 11 - "Package Config"
Cohesion: 0.17
Nodes (11): description, devDependencies, vitest, keywords, name, pi, extensions, version (+3 more)

### Community 12 - "Backend System"
Cohesion: 0.32
Nodes (7): AVAILABLE_BACKENDS, Backend, backends, DirectBackend, getBackend(), PiBackend, SubagentResult

### Community 13 - "Metrics & SLA"
Cohesion: 0.27
Nodes (8): computeDegradation(), computeSLAMetrics(), percentile(), SPARKLINE_CHARS, showSLAStats(), DegradationReport, ErrorCategory, SLAMetrics

### Community 14 - "Diff Parsing"
Cohesion: 0.22
Nodes (7): parseDiff(), BINARY_FILE_DIFF, MULTI_FILE_DIFF, ONLY_ADDITIONS_DIFF, ONLY_DELETIONS_DIFF, SINGLE_FILE_DIFF, FileDiff

### Community 15 - "Concurrency & Priority"
Cohesion: 0.53
Nodes (4): priorityInsert(), QueueEntry, Priority, PRIORITY_ORDER

### Community 17 - "E2E Subprocess Tests"
Cohesion: 0.47
Nodes (5): canRunSubprocessTests(), execFileAsync, PROJECT_ROOT, runDelegateTask(), TMP_SCRIPT_DIR

### Community 18 - "E2E Jiti Tests"
Cohesion: 0.40
Nodes (4): ISOLATED_FILES, jitiFactory, PI_DEPENDENT_FILES, SRC_DIR

## Knowledge Gaps
- **55 isolated node(s):** `name`, `version`, `description`, `pi-package`, `./src/index.ts` (+50 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SessionState` connect `Session State` to `Metrics & Formatting`, `Logging System`, `State Management`, `Concurrency & Priority`, `Cost Tracking`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Why does `Scheduler` connect `Logging System` to `Git Integration`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Why does `runSubagent()` connect `Core Execution Engine` to `Logging System`, `Git Integration`, `Backend System`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _58 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Metrics & Formatting` be split into smaller, more focused modules?**
  _Cohesion score 0.06101914962674456 - nodes in this community are weakly interconnected._
- **Should `Core Execution Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.06293706293706294 - nodes in this community are weakly interconnected._
- **Should `Logging System` be split into smaller, more focused modules?**
  _Cohesion score 0.07400555041628122 - nodes in this community are weakly interconnected._