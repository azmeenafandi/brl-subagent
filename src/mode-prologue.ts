// Purpose: The batch-mode prologue (cost → depth → resolve → targets → preflight → H1), one call per foreground batch handler.
/**
 * Batch-mode prologue (issue #379, the D1 cluster).
 *
 * `runChainMode`, `runParallelMode` and `runGraphMode` open with the SAME six
 * gates in the SAME order:
 *
 *     [graph only: DAG validation]  →  cost  →  depth  →  resolve params
 *        →  mode-level target validation  →  pre-flight  →  H1
 *
 * That sequence used to be copied into each handler (~110 lines × 3). This
 * module owns it once. The per-mode differences are parameters, not forks:
 *
 *   - `label`    — the warning/log lead: "Chain" → "Chain delegation" (cost
 *                  and depth logs), "Chain pre-flight check failed", "Chain
 *                  pre-task validation warnings/failed";
 *   - `units`    — the cost estimate's multiplier (IN2: the declared unit
 *                  count for chain/parallel/graph — never a wave count);
 *   - `beforeCost` — graph's DAG validation, the ONE hook that must run before
 *                  the cost gate (IN1 boundary: a malformed graph is rejected
 *                  before the session spends anything).
 *
 * Deliberately NOT here:
 *
 *   - the per-unit pre-pass (`validateUnitPrePass`, prelude.ts) — each handler
 *     CALLS it at its own position, because that position is part of the
 *     contract (IN8: chain/parallel before model resolution, graph after the
 *     circuit check and the topological sort);
 *   - the model tail (`resolveModeModel`, prelude.ts) — same reason: graph
 *     resolves the model before its per-node pass, chain/parallel after;
 *   - the single foreground path and the two background paths — they are a
 *     different gate sequence (design note §2.1; IN1/IN3/IN6), so forcing
 *     them through this skeleton would normalise their order.
 *
 * The gate functions are imported from `prelude.ts` (not re-implemented), so
 * the existing suite's call-through wrappers still observe each gate at the
 * same point in the sequence.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolResult } from "./types";
import type { SessionState } from "./state";
import type { Logger } from "./logging";
import { resolveSubagentParams, type ResolveInputParams } from "./params";
import { getCurrentDepth } from "./sanitize";
import { preflightCheck } from "./preflight";
import {
	depthLimitRejection,
	gateSessionCost,
	rejection,
	runPreTaskValidation,
	validateDelegationTargets,
} from "./prelude";

/** The params object the shared resolver consumes (`ResolveInputParams`,
 * params.ts) — the same type the background and single paths pass. */
export interface ModePrologueInput {
	params: ResolveInputParams;
	state: SessionState;
	ctx: ExtensionContext;
	log: Logger;
	/** Mode name, used as the warning/log lead: "Chain" | "Parallel" | "Graph". */
	label: string;
	/** Units this dispatch would spawn — the cost estimate's multiplier (IN2). */
	units: number;
	/**
	 * Mode-specific validation that MUST run before the cost gate. Graph uses
	 * it for `validateGraph`; chain/parallel pass nothing. Returns the
	 * rejection to surface, or `undefined` when the mode's precondition holds.
	 */
	beforeCost?: () => ToolResult<undefined> | undefined;
}

/** The resolved dispatch the handlers build on (IN4: resolved exactly once). */
export type ModeGlobalParams = ReturnType<typeof resolveSubagentParams>;

export type ModePrologueOutcome =
	| { ok: false; error: ToolResult<undefined> }
	| {
			ok: true;
			globalParams: ModeGlobalParams;
			resolvedCwd: string;
			/** The depth the depth gate measured — every unit spawns at `+ 1`. */
			currentDepth: number;
		};

/**
 * Run the batch-mode prologue. Returns the resolved params + validated cwd on
 * success, or the first gate's rejection in the verbatim wording the suites
 * pin. Gate order is the invariant (IN1/IN3/IN4/IN5/IN6/IN7): `beforeCost` →
 * cost → depth → resolve → targets → preflight → H1.
 */
export function runModePrologue(input: ModePrologueInput): ModePrologueOutcome {
	const { params, state, ctx, log, label, units, beforeCost } = input;

	// 0. Mode precondition (graph: DAG validation) — before the cost gate.
	const preCost = beforeCost?.();
	if (preCost) return { ok: false, error: preCost };

	// 1. Session cost gate (R5) — the first gate of every batch mode.
	const costError = gateSessionCost({
		state,
		ctx,
		log,
		units,
		label: `${label} delegation`,
	});
	if (costError) return { ok: false, error: costError };

	// 2. Recursion depth gate (IN3) — absent from the background paths by
	//    design (they spawn in-process SDK sessions, which do not stamp the
	//    depth env key); pinning the asymmetry, not "fixing" it here.
	const currentDepth = getCurrentDepth();
	if (currentDepth >= state.config.maxSubagentDepth) {
		log.warn(`${label} delegation rejected: max depth reached`, {
			currentDepth,
			maxDepth: state.config.maxSubagentDepth,
		});
		return {
			ok: false,
			error: depthLimitRejection(currentDepth, state.config.maxSubagentDepth),
		};
	}

	// 3. Resolve the global params exactly once (IN4).
	const globalParams = resolveSubagentParams(params, state, ctx, log);

	// 4. Mode-level target validation — cwd only. Every unit's own outputFile
	//    is validated by the per-unit pre-pass (IN5); the message bytes are
	//    identical to the inline spelling this replaced.
	const targets = validateDelegationTargets({ ctx, effectiveCwd: globalParams.effectiveCwd });
	if (!targets.ok) return { ok: false, error: targets.error };

	// 5. Pre-flight checks — fail fast before consuming resources (IN6).
	const pfResult = preflightCheck(targets.cwd);
	if (!pfResult.ok) {
		log.warn(`${label} pre-flight check failed`, { error: pfResult.error });
		return { ok: false, error: rejection(`Pre-flight check failed: ${pfResult.error}`) };
	}

	// 6. H1 at mode entry — mode-level params only, never prefixed and never
	//    carrying `force` (IN7). Warnings are logged, not surfaced: the result
	//    warnings come from the per-unit passes.
	const preTask = runPreTaskValidation({
		log,
		label,
		preTask: {
			task: globalParams.task,
			toolOptions: globalParams.toolOptions,
			thinkingLevel: globalParams.thinkingLevel,
			gitMode: globalParams.resolvedGitMode,
			outputFile: globalParams.outputFile,
		},
	});
	if (preTask.error) return { ok: false, error: preTask.error };

	return { ok: true, globalParams, resolvedCwd: targets.cwd, currentDepth };
}
