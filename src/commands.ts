// Purpose: The /brl-subagent command definition — its argument completions and the handler table — returned to the composition root to register.
/**
 * brl-subagent — the command surface (ADR 0027 S5, issue #483)
 *
 * `pi.registerCommand("brl-subagent", { … })` used to be a ~50-line object
 * literal inside `src/index.ts`'s default export. The definition moves here; the
 * REGISTRATION does not (D7): `index.ts` still calls `pi.registerCommand` with
 * what this factory returns, so the surface is composed in exactly one place.
 *
 * Two rules this module must keep, because the table is stateful per invocation:
 *
 *  - **No stale `ctx`.** Every handler reads `state` from the runtime and takes
 *    `ctx` from the per-call `handler(args, ctx)` signature. A `ctx` captured at
 *    factory time would be the previous session's context — the whole reason the
 *    table is built inside the handler rather than beside it.
 *  - **No `create*` factory here.** `applyConfig`/`resetState` (config writes
 *    owned by the composition root) and `abandonProductionRun` (the S4 boot
 *    factory's, whose notice latch is per-instance — D5) arrive through `deps`.
 *    Building a second one would give this module a second instance of state the
 *    runtime owns exactly once.
 */

import type { RuntimeContext } from "./runtime";
import type { ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import {
	showApprovalModeSelector,
	showCompletionNotifySelector,
	showComplianceMenu,
	showConcurrencyInput,
	showConfigMenu,
	showCostLimitInput,
	showDashboard,
	showDepthInput,
	showHistoryEntriesInput,
	showModelSelector,
	showMonitor,
	showPresetManager,
	showRecoverySelector,
	showRetryMenu,
	showRunHistory,
	showSLAConfig,
	showSLAStats,
	showTemplateManager,
	showThinkingSelector,
} from "./tui";

/**
 * What the command table needs from the composition root — injected, never
 * rebuilt here (see the header: a second config writer or a second boot factory
 * would be a second owner of state the runtime holds once).
 *
 * Deliberately narrow (interface segregation): each entry is the exact call the
 * table makes, not the factory that produced it.
 */
export interface CommandDeps {
	/** Persist a config change, repaint the footer and notify the user. */
	applyConfig: (ctx: ExtensionContext, message: string) => void;
	/** Factory-reset the configuration (and reload the file-backed templates). */
	resetState: (ctx: ExtensionContext) => void;
	/** The S4 boot cluster's abandon action, behind the retry menu. */
	abandonProductionRun: (ctx: ExtensionContext, id: string) => Promise<void>;
}

/**
 * The command definition `pi.registerCommand` consumes. `name` and `sourceInfo`
 * are the registrar's (it is called with the name), so they are excluded rather
 * than invented here — the definition is exactly the object literal the call
 * site used to inline.
 */
export type BrlCommandDefinition = Omit<RegisteredCommand, "name" | "sourceInfo">;

/**
 * Build the `/brl-subagent` definition over one runtime context (ADR 0027 D1/D3).
 *
 * The destructure re-creates the two names the moved table read from its old
 * closure (`pi` for `persistState`, `state` for every menu). The table itself is
 * built inside `handler`, so each invocation gets the live `ctx`.
 */
export function createCommands(
	rt: RuntimeContext,
	deps: CommandDeps,
): BrlCommandDefinition {
	const { pi, state } = rt;
	const { applyConfig, resetState, abandonProductionRun } = deps;

	return {
		description: "Configure subagent model and thinking level",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				"history", "historyentries", "monitor", "dashboard", "preset", "templates", "retry", "completionnotify", "recovery",
			];
			const filtered = options.filter((o) => o.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((o) => ({ value: o, label: o }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args?.trim();

			const handlers: Record<string, () => Promise<void> | void> = {
				model: () => showModelSelector(ctx, state, applyConfig),
				thinking: () => showThinkingSelector(ctx, state, applyConfig),
				concurrency: () => showConcurrencyInput(ctx, state, applyConfig),
				depth: () => showDepthInput(ctx, state, applyConfig),
				approval: () => showApprovalModeSelector(ctx, state, applyConfig),
				completionnotify: () => showCompletionNotifySelector(ctx, state, applyConfig),
				recovery: () => showRecoverySelector(ctx, state, applyConfig),
				costlimit: () => showCostLimitInput(ctx, state, applyConfig),
				reset: () => resetState(ctx),
				history: () => showRunHistory(ctx, state, () => state.persistState(pi)),
				historyentries: () => showHistoryEntriesInput(ctx, state, applyConfig),
				monitor: () => showMonitor(ctx, state),
				dashboard: () => showDashboard(ctx, state),
				preset: () => showPresetManager(ctx, state),
				templates: () => showTemplateManager(ctx, state),
				retry: () => showRetryMenu(ctx, state, (id) => abandonProductionRun(ctx, id)),
			sla: () => showSLAConfig(ctx, state, applyConfig),
			"sla-stats": () => showSLAStats(ctx, state),
			// E5: the compliance report menu (file access / secrets exposure /
			// full summary) shipped in tui.ts but had no handler key, so
			// `/brl-subagent compliance` fell through to the config menu and the
			// feature was unreachable (broken wiring, not dead code).
			compliance: () => showComplianceMenu(ctx, state),
			};

			if (trimmed && trimmed in handlers) {
				await handlers[trimmed]();
			} else if (trimmed?.startsWith("templates")) {
				await handlers.templates();
			} else if (trimmed?.startsWith("preset")) {
				await handlers.preset();
			} else {
				await showConfigMenu(ctx, state, handlers);
			}
		},
	};
}
