// Purpose: Entry point: tool/command registration, the delegate_task handlers, dispatch and single mode.
/**
 * brl-subagent — multi-agent orchestration for pi.
 * Entry point: tool registrations, command surface, dispatch (mode selection,
 * guard construction, single mode). The three batch-mode runners live in
 * `mode-runners.ts` (ADR 0027 S2) and the background pipeline (the fan-out,
 * the shared spawn tail and the single-background spawn) in
 * `background-pipeline.ts` (ADR 0027 S3).
 * See AGENT.md for the conductor-facing capability reference.
 */

import type { SessionState } from "./state";
import type { DelegateTaskParams } from "./types";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { KNOWN_DELEGATE_KEYS, type ResolveInputParams } from "./params";
import { createBackgroundPipeline } from "./background-pipeline";
import { createBootRecovery } from "./boot-recovery";
import { createModeRunners } from "./mode-runners";
import { createRuntime } from "./runtime";
import { createCommands } from "./commands";
import { createDelegateHandler } from "./delegate-handler";
import { createAgentTools } from "./agent-tools";
import { loadAllTemplates, loadBuiltinTemplates, validateTemplatePresetRefs } from "./templates";
import { pkgPath } from "./paths";
import { loadBuiltinPresets, loadCustomPresets, getAllPresets, writePresetFile } from "./presets";
import { cleanupTempDirs, reapActiveChildren } from "./runner";
import { clearProgressLinger, repaintStatus, stopProgressTicker } from "./concurrency";
import { setLogCwd } from "./logging";
import { createTerminalNotifier } from "./terminal-notifier";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Issue #354 review minor: the synchronous shutdown cleanup, extracted so the
 * real body (not a hand-mirrored copy) is exercised by tests. Clears every
 * session-bound live collection, resets the counters, and stops both footer
 * timers. Ordering is significant: the ticker is stopped before the linger is
 * cleared, and the maps are cleared before their guard claim set.
 */
export function cleanupSessionState(state: SessionState): void {
	// Clear all live subagent sessions
	state.subagentSessions.clear();
	// Drop pending finalize claims too (PR #71 review: the claim set must
	// not outlive the map it guards — a fresh session could otherwise
	// no-op on an id a stale claim still remembers).
	state.resetLiveFinalizeClaims();
	// Reset counters
	state.activeSubagents = 0;
	state.completedSubagents = 0;
	state.failedSubagents = 0;
	state.unseenSubagents = 0;
	// Issue #354: the footer ticker must not outlive the session (it also
	// drops the elapsed anchor, so a new session starts its own clock), and
	// neither may the 3 s linger timer (F2) — it would repaint a dead pane.
	stopProgressTicker(state);
	clearProgressLinger(state);
	// Clear pending queue
	state.pendingQueue.length = 0;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Compile-time coverage (issue #229 item 4): fails to compile if
 * DelegateTaskParams omits any KNOWN_DELEGATE_KEYS entry. Runtime drift is
 * invisible (the schema passes the key through, the handler ignores it), so
 * only the compiler can catch it. Together with per-step-model.test.ts's
 * runtime ratchet this closes the chain: registered schema <-> KNOWN_DELEGATE_KEYS <-> DelegateTaskParams.
 */
type _KnownDelegateKey = (typeof KNOWN_DELEGATE_KEYS extends Set<infer K> ? K : never) & string;
type _ExpectNever<T extends never> = T;
type _DelegateParamCoverage = _ExpectNever<Exclude<_KnownDelegateKey, keyof DelegateTaskParams>>;

/**
 * Issue #379: `ResolveInputParams` derives from the schema via `Pick`, so a
 * params field ADDED to the schema is not in the resolver's input until the
 * key list names it — and a missed field is invisible at runtime (the key
 * reaches execute and is silently unused). Only the compiler can catch it.
 *
 * The excluded keys are the ones resolution deliberately does not read: the
 * execution-shape inputs (`chain`/`tasks`/`graph`), the template machinery
 * (`template` is the exception — it IS read, so it stays in the resolver;
 * `params` is not), the retry inputs, and the per-dispatch fields
 * (`model`/`priority`/`background`) that resolve outside this merge.
 */
type _NonResolutionDelegateKey =
	| "chain"
	| "tasks"
	| "graph"
	| "params"
	| "retryRunId"
	| "retryOnTimeout"
	| "model"
	| "priority"
	| "background"
	// Issue #412: `force`/`noJev` are consumed at the validation seam (they
	// reach `validatePreTask`, not the merge), so `force` stays in the resolver's
	// key list while `noJev` — never read by resolution — is excluded here.
	| "noJev";
type _ResolveInputCoverage = _ExpectNever<
	Exclude<_KnownDelegateKey, keyof ResolveInputParams | _NonResolutionDelegateKey>
>;

export default function (pi: ExtensionAPI) {
	// ADR 0027 (S2): the composition root builds the runtime once per invocation
	// and composes the mode runners over it. `state` is no longer a rebindable
	// `let`: the context owns the instance, and a rebind here would be a second
	// owner of the store the runners hold.
	const rt = createRuntime(pi);
	const { log, state } = rt;
	const { runChainMode, runParallelMode, runGraphMode, resolveStepModel, applyUnitShapeGuard } = createModeRunners(rt);
	// ADR 0027 (S3): the background pipeline. The loader thunk is invoked only
	// inside `startBackgroundAgent`, so session-manager's lifecycle mutators stay
	// lazily imported from the one module allowed to reach them.
	const backgroundPipeline = createBackgroundPipeline(rt, {
		loadSessionManager: () => import("./session-manager"),
		resolveStepModel,
		applyUnitShapeGuard,
	});
	const { runBackgroundFanOut, startBackgroundAgent, spawnBackgroundRun } = backgroundPipeline;

	// Issue #147: the completion-push subscriber needs the session context to
	// resolve the run entry (state.getLogicalRunEntries(ctx)). The event-bus listener
	// receives no ctx, so capture it in session_start where it is available.
	let sessionCtx: ExtensionContext | undefined;

	// ADR 0027 (S4): the boot recovery cluster — the interrupted-run scan, the
	// head-state reconcile, the two boot notices and the abandon action, built
	// over this runtime. Its once-per-boot latch (`recoveryNoticeDelivered`) is
	// the factory's own (D5): a latch here would be shared by two runtimes.
	const {
		performBootRecovery,
		reconcileHeadStatesAtBoot,
		maybeSendHeadStateNotice,
		maybeSendRecoveryNotice,
		abandonProductionRun,
		visibleRunsFor,
		resetRecoveryNotice,
	} = createBootRecovery(rt);

	// -------------------------------------------------------------------
	// Config change callback
	// -------------------------------------------------------------------

	function applyConfig(ctx: ExtensionContext, message: string) {
		// Issue #354: a config change mid-run must not blank the footer —
		// repaintStatus renders the activity line while runs are active and
		// falls back to the idle config line when none are.
		repaintStatus(state, ctx);
		state.persistState(pi);
		ctx.ui.notify(message, "info");
	}

	function resetState(ctx: ExtensionContext) {
		state.reset();
		// Templates are file-backed (issue #66): state.reset() clears
		// state.config.templates, so reload them from disk — otherwise
		// template lookups stay empty until the next session_start.
		// Full stack: custom (project+global) merged over builtins.
		state.config.templates = loadAllTemplates(ctx.cwd, log);
		// Issue #81: cross-check template `preset:` refs against the full
		// preset universe now that both loads are complete — warn (never skip)
		// for dangling references instead of running preset-less silently.
		validateTemplatePresetRefs(
			state.config.templates,
			getAllPresets(state.builtinPresets, state.customPresets),
			log,
		);
		repaintStatus(state, ctx);
		state.persistState(pi);
		ctx.ui.notify("Subagent configuration reset", "info");
	}

	// -------------------------------------------------------------------
	// /brl-subagent command
	// -------------------------------------------------------------------

	pi.registerCommand(
		"brl-subagent",
		createCommands(rt, { applyConfig, resetState, abandonProductionRun }),
	);

	// -------------------------------------------------------------------
	// delegate_task tool — the definition is built by `createDelegateHandler`
	// and registered HERE: the registration surface stays in the composition
	// root (ADR 0027 D7), and the handler receives the SAME mode-runner,
	// background-pipeline and boot-recovery instances created above (D5).
	// -------------------------------------------------------------------

	pi.registerTool(
		createDelegateHandler(rt, {
			runChainMode,
			runParallelMode,
			runGraphMode,
			runBackgroundFanOut,
			spawnBackgroundRun,
			visibleRunsFor,
		}),
	);

	// -------------------------------------------------------------------
	// Agent tools — get_subagent_result / steer_subagent / stop_subagent.
	// Registered here, one `pi.registerTool` call per definition returned.
	// -------------------------------------------------------------------

	for (const tool of createAgentTools()) pi.registerTool(tool);

	// -------------------------------------------------------------------
	// Session lifecycle — F7: Session-bound state initialization
	// -------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Issue #147: capture the session context for the completion-push subscriber.
		sessionCtx = ctx;
		// Issue #179 (D6): createLogger ran at module load with no cwd — point
		// the shared file sink at this session's cwd now that it exists.
		setLogCwd(ctx.cwd);
		// Load built-in presets
		const presetsDir = pkgPath("presets");
		state.builtinPresets = loadBuiltinPresets(presetsDir, log);
		state.customPresets = loadCustomPresets(ctx.cwd, log);
		// Builtin templates + merged full stack (custom overrides builtin)
		const templatesDir = pkgPath("templates");
		state.builtinTemplates = loadBuiltinTemplates(templatesDir, log);
		state.config.templates = loadAllTemplates(ctx.cwd, log, templatesDir);

		// Issue #81: cross-check template `preset:` refs against the full
		// preset universe now that both loads are complete — warn (never skip)
		// for dangling references instead of running preset-less silently with
		// auto-route suppressed.
		validateTemplatePresetRefs(
			state.config.templates,
			getAllPresets(state.builtinPresets, state.customPresets),
			log,
		);

		// Migration: write any session-persisted presets to files
		if (state._migratedPresets && state._migratedPresets.length > 0) {
			for (const preset of state._migratedPresets) {
				writePresetFile(preset, path.join(ctx.cwd, ".pi", "brl-subagent", "presets"));
			}
			state._migratedPresets = undefined;
			state.customPresets = loadCustomPresets(ctx.cwd, log);
			state.config.templates = loadAllTemplates(ctx.cwd, log);
			log?.info("Migrated presets from session to files");
		}

		// R2: Clean stale temp dirs from previous sessions
		cleanupTempDirs(ctx.cwd).then((count) => {
			if (count > 0) log.info("Cleaned stale temp directories", { count });
		});

		log.info("Session started", {
			builtinPresets: state.builtinPresets.length,
			builtinTemplates: state.builtinTemplates.length,
			presetsDir,
		});

		// F5/F9: Safe state restoration with type guards
		state.restoreFromSession(ctx);

		// Option B U1: reap a dead conductor's orphaned children and mark the
		// records interrupted BEFORE anything else touches their worktrees.
		await performBootRecovery();

		// Issue #466 (ADR 0026 D2/D5): reconcile the durable head-state records —
		// the ONE step allowed to move git at boot, and only for a record whose
		// owner it has proved dead.
		const headStateOutcomes = reconcileHeadStatesAtBoot();

		// Option B U3 (D2): after the scan, surface every unresolved interrupted
		// run ONCE, at the next turn boundary (never mid-turn).
		await maybeSendRecoveryNotice(ctx);

		// Issue #466: the head-state verdicts ride the same nextTurn channel.
		maybeSendHeadStateNotice(headStateOutcomes);

		// Issue #356: boot is a config-paint edge — route it through the same
		// chokepoint as every other footer repaint. With no runs in flight the
		// chokepoint draws the idle config line the old direct call painted.
		repaintStatus(state, ctx);
	});

	// F7: Clean up session-bound state on shutdown
	pi.on("session_shutdown", async (_event, _ctx) => {
		// Issue #437: release THIS runtime's terminal subscribers FIRST — before
		// any await or fallible cleanup. A clean replacement (/new, /resume,
		// /fork, /reload, quit) tears this runtime down and loads a new factory
		// instance; the old listeners used to survive and win the shared terminal
		// claim for the NEW session's run, delivering (or throwing) through dead
		// pi/ctx handles. Only our three exact identities are removed, and the
		// release is idempotent, so other subscribers and a later runtime are
		// untouched. `releaseTerminalSubscriptions` is the notifier factory's own
		// `release` (ADR 0027 D5), built below at the position the subscription
		// block used to occupy — this handler body runs after init completes.
		releaseTerminalSubscriptions();

		log.info("Session shutting down", {
			activeSubagents: state.activeSubagents,
		});

		// Option B U1: reap in-flight foreground children first, so a clean exit
		// never orphans a subprocess (the crash case is covered by boot recovery).
		try {
			await reapActiveChildren(log);
		} catch (err) {
			log.warn("Shutdown reap failed", { error: (err as Error).message });
		}

		cleanupSessionState(state);
		// U3: a new session boot may notify again (the latch is the boot
		// factory's own — ADR 0027 D5, so the reset goes through it).
		resetRecoveryNotice();
	});

	// -------------------------------------------------------------------
	// Issue #147: completion-push wake — the terminal notifier (ADR 0027 S4)
	// -------------------------------------------------------------------
	// The notifier owns its three subscriptions AND their release latch (D5).
	// Created HERE, where the subscription block used to live, so the bus sees
	// the same registration order. Its one backward edge — the transport-retry
	// re-dispatch — reaches the S3 pipeline's spawn through this deps literal.
	const terminalNotifier = createTerminalNotifier(rt, {
		// ADR 0027 D2: `sessionCtx` stays a `let` here; the listener gets a getter.
		getSession: () => sessionCtx,
		spawnBackgroundRun,
	});
	// The shutdown hook keeps its old name and its position: `release` is
	// idempotent and removes only this instance's three listeners (#437).
	const releaseTerminalSubscriptions = terminalNotifier.release;

}
