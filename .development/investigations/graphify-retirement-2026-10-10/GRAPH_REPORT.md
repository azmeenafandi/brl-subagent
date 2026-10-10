# Graph Report - brl-subagent  (2026-09-27)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 990 nodes · 2572 edges · 61 communities (52 shown, 9 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 64 edges (avg confidence: 0.81)
- Token cost: 2,944 input · 5,374 output

## Graph Freshness
- Built from commit: `b7c52e4f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Subagent Run Orchestration
- Subagent Messaging
- Git Branch Operations
- Delegate UI Rendering
- Terminal Status Consistency Tests
- Agent Capability Documentation
- Completion Notification Delivery
- Per-Step Model Tests
- Transcript Tail Rendering
- Subagent Session State
- Template Loading and Logging
- Dispatch Capability Guard Tests
- Security Compliance Reports
- Package Manifest Metadata
- Model Availability and Auth
- Task Classification Routing
- Preset File Management
- Background Fan-Out Tests
- Session State Lifecycle
- Runtime Vocabulary Checks
- Subagent Option Validation
- Runtime Import Specifier Checks
- TUI Formatting Utilities
- Subagent Type Definitions
- Per-Step CWD Tests
- Run Usage Benchmarks
- Chain and Parallel Runs
- Template Agent Guidance
- Background Run Extraction Tests
- Background Batch Rejection Tests
- Diff Parsing Utilities
- Delegate Result Rendering
- Subagent Run History
- Subagent Metrics and SLA
- Streaming Sentinel Tests
- TypeScript Configuration
- Transcript File Management
- Unit Run Tests
- Guardrail and Abort Tests
- Subagent Event Bus
- Graph Task Scheduler
- Development Dependencies
- Logging Configuration
- Stale State Sweep Tests
- README Command Tests
- Artifact Packaging Checks
- Package Manifest Paths
- CI/CD Release Workflows
- Peer Dependencies
- Priority Queue Concurrency
- Subprocess E2E Tests
- Preset File Tests
- E2E Test Setup
- Background Session Safety
- Data Analyst Preset
- Dev Agent Preset
- Rapid Prototyper Preset
- Refactorer Preset
- Security Auditor Preset
- Tech Writer Preset

## God Nodes (most connected - your core abstractions)
1. `vitest` - 55 edges
2. `execute()` - 51 edges
3. `runGraphMode()` - 34 edges
4. `SessionState` - 33 edges
5. `runChainMode()` - 32 edges
6. `runParallelMode()` - 30 edges
7. `runSubagent()` - 29 edges
8. `spawnBackgroundSession()` - 28 edges
9. `SubagentRun` - 24 edges
10. `isSubagentError()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `Execution Models Matrix` --semantically_similar_to--> `Multi-step Execution Models (chain, tasks, graph)`  [INFERRED] [semantically similar]
  AGENT.md → README.md
- `Query: What is the complexity to enable background running of parallel tasks?` --references--> `execute()`  [EXTRACTED]
  graphify-out/memory/query_20260915_113237_44729c7f_what_is_the_complexity_to_enable_background_runnin.md → src/index.ts
- `Query: What is the complexity to enable background running of parallel tasks?` --references--> `runParallelMode()`  [EXTRACTED]
  graphify-out/memory/query_20260915_113237_44729c7f_what_is_the_complexity_to_enable_background_runnin.md → src/index.ts
- `Query: What is the complexity to enable background running of parallel tasks?` --references--> `spawnBackgroundSession()`  [EXTRACTED]
  graphify-out/memory/query_20260915_113237_44729c7f_what_is_the_complexity_to_enable_background_runnin.md → src/session-manager.ts
- `Query: What connects the backlog issues (#30, #31, #61) to existing code?` --references--> `showMonitor()`  [EXTRACTED]
  graphify-out/memory/query_20260807_113359_what_connects_the_backlog_issues___30_error_disclo.md → src/tui.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Pre-spawn Validation Guards** — readme_capability_preflight, readme_delegate_task, readme_background_fanout, readme_gitmode_branch [EXTRACTED 0.85]
- **Background Execution Flow** — readme_delegate_task, readme_background_execution, readme_background_fanout, agent_completion_contract, readme_get_subagent_result, readme_stop_subagent [EXTRACTED 0.90]
- **Builtin Template / Companion Preset Pairs** — templates_code_review, presets_code_reviewer, templates_debug_issue, presets_debugger, templates_write_tests, presets_test_engineer [EXTRACTED 0.95]
- **Background Parallel Dispatch Flow** — src_index_execute, src_index_runparallelmode, src_session_manager_spawnbackgroundsession, src_concurrency, src_session_manager_gitbranchlocks, src_types_max_parallel_tasks [INFERRED 0.75]
- **npm Staged Release Pipeline** — github_workflows_publish, github_workflows_publish_staged_publishing, github_workflows_publish_oidc_trusted_publishing, github_workflows_publish_smoke_artifact_gate [INFERRED 0.75]

## Communities (61 total, 9 thin omitted)

### Community 0 - "Subagent Run Orchestration"
Cohesion: 0.10
Nodes (66): acquireSlot(), releaseSlot(), updateProgressStatus(), updateStatus(), finalizeRunRecord(), resolveRetryParams(), applyConfig(), execute() (+58 more)

### Community 1 - "Subagent Messaging"
Cohesion: 0.06
Nodes (53): ref_node_child_process, extractMessages(), formatPendingMessages(), Intercom, Message, TO_PATTERN, checkCwdReadable(), checkPiBinary() (+45 more)

### Community 2 - "Git Branch Operations"
Cohesion: 0.07
Nodes (56): ref_crypto, ref_fs, ref_path, captureDiff(), captureWorkingDiff(), commitAll(), createWorkBranch(), deleteBranch() (+48 more)

### Community 3 - "Delegate UI Rendering"
Cohesion: 0.09
Nodes (35): renderCall(), formatPresetSummary(), buildDelegateLabel(), buildScopeLabel(), findPresetSource(), findTemplateSource(), getConfigMenuItems(), getTemplate() (+27 more)

### Community 4 - "Terminal Status Consistency Tests"
Cohesion: 0.10
Nodes (28): CASES, COMPARISON_OPERATORS, EQUALITY_OPERATORS, FAILURE_REASON_SET, FAILURE_REASONS, failureLiteralsIn(), failureLiteralText(), isAllowed() (+20 more)

### Community 5 - "Agent Capability Documentation"
Cohesion: 0.16
Nodes (27): AGENT.md Capability Reference, Claim Verification, Completion Contract, Delegation Judgment, Execution Models Matrix, bash Tool, brl-subagent Changelog, Preset: code-reviewer (+19 more)

### Community 6 - "Completion Notification Delivery"
Cohesion: 0.13
Nodes (19): formatRunDuration(), deliverCompletionAlert(), buildCompletionMessage(), buildSummaryLine(), CompletionMessageDetails, CompletionMessagePayload, CompletionStatus, DeliveryResolution (+11 more)

### Community 7 - "Per-Step Model Tests"
Cohesion: 0.09
Nodes (18): Container, DynamicBorder, GLOBAL_MODEL, loadBuiltins(), makeCtx(), makeRegistry(), makeResult(), Markdown (+10 more)

### Community 8 - "Transcript Tail Rendering"
Cohesion: 0.13
Nodes (23): bashMsg, textMsg, thinkingMsg, toolCallMsg, toolResultMsg, userMsg, blockLines(), buildTranscriptTail() (+15 more)

### Community 9 - "Subagent Session State"
Cohesion: 0.12
Nodes (6): SessionState, sweepStaleLiveSubagents(), showRunHistory(), CircuitBreakerState, SubagentRun, SubagentState

### Community 10 - "Template Loading and Logging"
Cohesion: 0.13
Nodes (9): Logger, getAllTemplates(), getTemplate(), loadAllTemplates(), loadBuiltinTemplates(), loadCustomTemplates(), validateTemplate(), tempDirs (+1 more)

### Community 11 - "Dispatch Capability Guard Tests"
Cohesion: 0.11
Nodes (18): Container, DynamicBorder, execute(), executeWithSpawn(), EXPLORE_TASK_NO_BROWSE, GLOBAL_MODEL, h, loadBuiltins() (+10 more)

### Community 12 - "Security Compliance Reports"
Cohesion: 0.14
Nodes (17): buildFileAccessReport(), buildSecretsExposureReport(), extractFilesFromGitDiff(), extractFilesFromOutputSummary(), FILE_SEVERITY_MAP, generateComplianceSummary(), hasSensitiveTaskKeywords(), SENSITIVE_FILE_PATTERNS (+9 more)

### Community 13 - "Package Manifest Metadata"
Cohesion: 0.10
Nodes (19): description, files, keywords, license, name, overrides, nanoid, pi (+11 more)

### Community 14 - "Model Availability and Auth"
Cohesion: 0.14
Nodes (10): modelIsAvailable(), ModelLike, ModelRegistryLike, ProviderAuthStatusLike, catalogModel, createdAuthDirs, createRealRegistry(), PROVIDER_ENV_VARS (+2 more)

### Community 15 - "Task Classification Routing"
Cohesion: 0.14
Nodes (16): findUnknownParams(), KNOWN_DELEGATE_KEYS, NOTE: the schema's `params` (template slots) key is intentionally NOT, getAllPresets(), AutoRouteDecision, autoRoutePreset(), CLASSIFICATION_RULES, ClassificationRule (+8 more)

### Community 16 - "Preset File Management"
Cohesion: 0.23
Nodes (15): buildFrontmatter(), buildPresetMarkdown(), getPreset(), loadBuiltinPresets(), loadCustomPresets(), parseFrontmatter(), sanitizeFileName(), validateAllPresets() (+7 more)

### Community 17 - "Background Fan-Out Tests"
Cohesion: 0.12
Nodes (16): Container, Ctx, DynamicBorder, GLOBAL_MODEL, h, makeCtx(), makeFakeAgent(), makeRegistry() (+8 more)

### Community 18 - "Session State Lifecycle"
Cohesion: 0.16
Nodes (11): @earendil-works/pi-coding-agent, createSessionState(), FINALIZE_RESET_WINDOW_MS, NOTE: this method does NOT touch activeSubagents — callers that know the, createState(), CIRCUIT_BREAKER_RESET_MS, CIRCUIT_DEGRADED_THINKING, COMPLETION_NOTIFY_MODES (+3 more)

### Community 19 - "Runtime Vocabulary Checks"
Cohesion: 0.17
Nodes (16): ref_node_fs, ref_node_path, allowlistKey(), closestAncestor(), flattenLiteralText(), FORBIDDEN_TERMS, isPlusConcatenation(), REPO_ROOT (+8 more)

### Community 20 - "Subagent Option Validation"
Cohesion: 0.18
Nodes (16): ResolvedParamsLike, SubagentToolOptions, ThinkingLevel, UnitRunSource, BUILTIN_TOOLS, DiagnoseConfig, isBuiltinTool(), isToolAvailable() (+8 more)

### Community 21 - "Runtime Import Specifier Checks"
Cohesion: 0.21
Nodes (14): checks, classifyRuntimeSpecifiers(), collectRuntimeSpecifiers(), importEqualsSpecifier(), isBuiltinSpecifier(), isRelativeSpecifier(), isRuntimeImportClause(), isTypeOnlyExport() (+6 more)

### Community 22 - "TUI Formatting Utilities"
Cohesion: 0.23
Nodes (15): Query: What connects the backlog issues (#30, #31, #61) to existing code?, Query: What is the structural shape of issue #52 (test pollution + monitor liveness)?, formatSparkline(), buildHorizontalBar(), compactDuration(), formatElapsed(), formatLiveRowDim(), LIVE_SPINNER_FRAMES (+7 more)

### Community 23 - "Subagent Type Definitions"
Cohesion: 0.14
Nodes (13): DEFAULT_MAX_SUBAGENT_DEPTH, DEFAULT_OUTPUT_CAP_BYTES, DEFAULT_PRIORITY, DEFAULT_SLA_WINDOW_SIZE, GRAPH_OUTPUT_PLACEHOLDER_RE, GraphWave, isSubagentStateShape(), MAX_SLA_WINDOW_SIZE (+5 more)

### Community 24 - "Per-Step CWD Tests"
Cohesion: 0.13
Nodes (11): Container, DynamicBorder, execute(), GLOBAL_MODEL, makeCtx(), Markdown, runnerMocks, SelectList (+3 more)

### Community 25 - "Run Usage Benchmarks"
Cohesion: 0.13
Nodes (14): BASE_PARAMS, BASE_RUN, buildRuns(), ERROR_CASES, FULL_USAGE, LARGE_USAGE, makeRun(), MINIMAL_USAGE (+6 more)

### Community 26 - "Chain and Parallel Runs"
Cohesion: 0.15
Nodes (12): Query: What is the complexity to enable background running of parallel tasks?, gitBranchLocks, mergeSubTaskParams(), ChainDetails, MAX_CHAIN_STEPS, MAX_PARALLEL_TASKS, MultiSubagentDetails, ParallelDetails (+4 more)

### Community 27 - "Template Agent Guidance"
Cohesion: 0.20
Nodes (12): buildInventorySummary(), buildTemplateGuideline(), formatTemplateSummaryItem(), buildTemplateFrontmatter(), buildTemplateMarkdown(), extractParamNames(), resolveTemplate(), writeTemplateFile() (+4 more)

### Community 28 - "Background Run Extraction Tests"
Cohesion: 0.15
Nodes (12): ref_node_os, Container, DynamicBorder, GLOBAL_MODEL, h, makeCtx(), makeRegistry(), Markdown (+4 more)

### Community 29 - "Background Batch Rejection Tests"
Cohesion: 0.15
Nodes (12): __setStorageDir(), Container, DynamicBorder, GLOBAL_MODEL, makeCtx(), makeRegistry(), Markdown, runnerMocks (+4 more)

### Community 30 - "Diff Parsing Utilities"
Cohesion: 0.18
Nodes (8): parseDiff(), BINARY_FILE_DIFF, MULTI_FILE_DIFF, ONLY_ADDITIONS_DIFF, ONLY_DELETIONS_DIFF, SINGLE_FILE_DIFF, FileDiff, MAX_HUNKS_PER_FILE

### Community 31 - "Delegate Result Rendering"
Cohesion: 0.24
Nodes (13): renderResult(), addExpandedDiffSection(), renderCollapsedGraph(), renderCollapsedText(), renderDelegateResult(), renderExpandedChain(), renderExpandedGraph(), renderExpandedParallel() (+5 more)

### Community 32 - "Subagent Run History"
Cohesion: 0.26
Nodes (9): cleanupRuns(), createEmptyResult(), pruneSessionRuns(), LiveTranscriptBuilder, makeResult(), TranscriptMessage, isSubagentRunShape(), MAX_RUN_HISTORY_ENTRIES (+1 more)

### Community 33 - "Subagent Metrics and SLA"
Cohesion: 0.24
Nodes (9): computeCostTrend(), computeDegradation(), computeSLAMetrics(), percentile(), SPARKLINE_CHARS, showSLAStats(), DegradationReport, ErrorCategory (+1 more)

### Community 34 - "Streaming Sentinel Tests"
Cohesion: 0.17
Nodes (5): collapsed, mocks, renderLines(), theme, EMPTY_USAGE

### Community 35 - "TypeScript Configuration"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, noEmit, skipLibCheck, strict (+3 more)

### Community 36 - "Transcript File Management"
Cohesion: 0.38
Nodes (9): appendEntry(), completeTranscript(), ensureOutputDir(), getTranscript(), getTranscriptPath(), __setOutputDir(), startTranscript(), TranscriptEntry (+1 more)

### Community 37 - "Unit Run Tests"
Cohesion: 0.18
Nodes (3): STEP_MODEL, TRANSCRIPT, CUSTOM_ENTRY_TYPES

### Community 38 - "Guardrail and Abort Tests"
Cohesion: 0.22
Nodes (5): vitest, INDEX_SRC, mockExecFileSync, fakeModelRuntime(), signalAwareStream()

### Community 39 - "Subagent Event Bus"
Cohesion: 0.20
Nodes (6): createEvent(), globalListeners, listeners, SubagentEvent, SubagentEventListener, SubagentEventType

### Community 40 - "Graph Task Scheduler"
Cohesion: 0.33
Nodes (5): detectCycle(), topologicalSort(), validateGraph(), GraphTask, MAX_GRAPH_TASKS

### Community 41 - "Development Dependencies"
Cohesion: 0.22
Nodes (9): devDependencies, @earendil-works/pi-agent-core, @earendil-works/pi-ai, @earendil-works/pi-coding-agent, @earendil-works/pi-tui, jiti, typebox, typescript (+1 more)

### Community 42 - "Logging Configuration"
Cohesion: 0.28
Nodes (7): createLogger(), log(), LOG_LEVELS, resolveLogDir(), rotateIfNeeded(), setLogCwd(), LogLevel

### Community 43 - "Stale State Sweep Tests"
Cohesion: 0.28
Nodes (4): STALE_FINALIZE_GRACE_MS, createMockContext(), makeRun(), twoEntryContext()

### Community 44 - "README Command Tests"
Cohesion: 0.25
Nodes (5): indexSource, NOTE: /brl-subagent update-check was removed after v2.3.5 (see #164) — kept as…, readmeSource, repoRoot, RESERVED_COMMAND_NAMES

### Community 45 - "Artifact Packaging Checks"
Cohesion: 0.38
Nodes (7): check(), extractTarball(), main(), packToTemp(), record(), runArtifactChecks(), walkFiles()

### Community 46 - "Package Manifest Paths"
Cohesion: 0.33
Nodes (5): pkgPath(), agentMd, packageJson, readme, repoRoot

### Community 47 - "CI/CD Release Workflows"
Cohesion: 0.40
Nodes (6): Dependabot Configuration, CI Workflow, Publish Workflow (npm Staged Release), OIDC Trusted Publishing, Packed-Artifact Smoke Gate, npm Staged Publishing

### Community 48 - "Peer Dependencies"
Cohesion: 0.33
Nodes (6): peerDependencies, @earendil-works/pi-agent-core, @earendil-works/pi-ai, @earendil-works/pi-coding-agent, @earendil-works/pi-tui, typebox

### Community 49 - "Priority Queue Concurrency"
Cohesion: 0.53
Nodes (4): priorityInsert(), QueueEntry, Priority, PRIORITY_ORDER

### Community 50 - "Subprocess E2E Tests"
Cohesion: 0.47
Nodes (5): canRunSubprocessTests(), execFileAsync, PROJECT_ROOT, runDelegateTask(), TMP_SCRIPT_DIR

### Community 52 - "E2E Test Setup"
Cohesion: 0.40
Nodes (4): jiti, ISOLATED_FILES, PI_DEPENDENT_FILES, SRC_DIR

## Knowledge Gaps
- **248 isolated node(s):** `DelegationTargetsResult`, `PreflightResult`, `LiveBlockKind`, `Container`, `DynamicBorder` (+243 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 361 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Work-memory lessons

**Preferred sources** — corroborated by past sessions; start here.
- `spawnBackgroundSession()` (4× useful, score=1.668842881)
- `attachAbortHandler()` (2× useful, score=0.59282649)
- `stopAgent()` (2× useful, score=0.59282649)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `Guardrail and Abort Tests` to `Subagent Run Orchestration`, `Subagent Messaging`, `Git Branch Operations`, `Terminal Status Consistency Tests`, `Completion Notification Delivery`, `Per-Step Model Tests`, `Transcript Tail Rendering`, `Template Loading and Logging`, `Dispatch Capability Guard Tests`, `Security Compliance Reports`, `Package Manifest Metadata`, `Model Availability and Auth`, `Task Classification Routing`, `Preset File Management`, `Background Fan-Out Tests`, `Session State Lifecycle`, `Runtime Vocabulary Checks`, `Subagent Option Validation`, `Runtime Import Specifier Checks`, `TUI Formatting Utilities`, `Subagent Type Definitions`, `Per-Step CWD Tests`, `Run Usage Benchmarks`, `Chain and Parallel Runs`, `Template Agent Guidance`, `Background Run Extraction Tests`, `Background Batch Rejection Tests`, `Diff Parsing Utilities`, `Subagent Run History`, `Subagent Metrics and SLA`, `Streaming Sentinel Tests`, `Transcript File Management`, `Unit Run Tests`, `Graph Task Scheduler`, `Stale State Sweep Tests`, `README Command Tests`, `Package Manifest Paths`, `Priority Queue Concurrency`, `Subprocess E2E Tests`, `Preset File Tests`, `E2E Test Setup`?**
  _High betweenness centrality (0.188) - this node is a cross-community bridge._
- **Why does `Query: What is the complexity to enable background running of parallel tasks?` connect `Chain and Parallel Runs` to `Subagent Run Orchestration`, `Git Branch Operations`, `Agent Capability Documentation`, `Completion Notification Delivery`, `Priority Queue Concurrency`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Why does `AGENT.md Capability Reference` connect `Agent Capability Documentation` to `Chain and Parallel Runs`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `runGraphMode()` (e.g. with `.register()` and `getFinalOutput()`) actually correct?**
  _`runGraphMode()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `DelegationTargetsResult`, `PreflightResult`, `LiveBlockKind` to the rest of the system?**
  _248 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Subagent Run Orchestration` be split into smaller, more focused modules?**
  _Cohesion score 0.0981012658227848 - nodes in this community are weakly interconnected._
- **Should `Subagent Messaging` be split into smaller, more focused modules?**
  _Cohesion score 0.05583972719522592 - nodes in this community are weakly interconnected._