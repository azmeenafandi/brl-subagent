// Purpose: Shared guard/validation prelude for delegation modes: the individual gates (cost, approval, targets, H1), the per-unit pre-pass, and the batch modes' model tail.
/**
 * Shared guard/validation prelude for delegation modes (issue #201).
 *
 * delegate_task's mode handlers each open with the same prelude shape:
 *
 *   1. session cost gate — perTaskEstimate fallback ($0.05) →
 *      checkCostLimit → the verbatim "Cannot delegate: session cost limit
 *      reached …" rejection;
 *   2. approvalMode 'always' rejection (background paths only) — the verbatim
 *      "Cannot spawn background agent with approvalMode 'always' …";
 *   3. cwd → outputFile → H1 pre-task validation — the same "Invalid cwd:" /
 *      "Invalid outputFile:" / joined-errors messages, optionally
 *      unit-prefixed (`Task 2 ("two"): …`) for per-unit loops.
 *
 * Each helper returns the rejection ToolResult when the gate trips and
 * `undefined` when it passes, so call sites keep their original gate order:
 *
 *     const err = gateSessionCost({ … });
 *     if (err) return err;
 *
 * Exception: runPreTaskValidation returns a { error?, warnings } outcome —
 * `error` follows the same `if (outcome.error) return outcome.error` shape,
 * and `warnings` must be surfaced in the returned tool result:
 *
 *     const pre = runPreTaskValidation({ … });
 *     if (pre.error) return pre.error;
 *
 * The per-unit pre-pass (merge → targets → H1 → warnings, repeated per unit)
 * is validateUnitPrePass. Handlers CALL it at their own position; the gate
 * order around it stays visible per mode.
 *
 * The batch modes' tail — model resolution, the empty-model rejection and the
 * circuit check (IN11) — is resolveModeModel, built on
 * resolveSubagentModelPrecedence, the one precedence chain the single and
 * background paths resolve through too.
 *
 * The three foreground batch handlers compose the cost, target, preflight and
 * H1 gates through `mode-prologue.ts` (`runModePrologue`), so their sequence
 * is defined in one place; this module keeps the individual gates.
 *
 * Messages are byte-identical to the pre-extraction copies (the suites pin
 * them); the parameters absorb only the real differences between sites — the
 * cost-gate log label and unit count, and the H1 log label / unit prefix /
 * extra log fields.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalMode, GitMode, SubagentPreset, SubagentToolOptions, ThinkingLevel, ToolResult } from "./types";
import type { SessionState } from "./state";
import type { Logger } from "./logging";
import { validateCwd, validateOutputFile } from "./sanitize";
import { validatePreTask, type ValidateConfig } from "./validate";
import { modelIsAvailable, parseModelString } from "./model-availability";

/** The standard rejection result shape shared by these gates. */
export function rejection(text: string): ToolResult<undefined> {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

// ── Shared rejection messages (one wording, every dispatch path) ────────

/**
 * The recursion-depth rejection (IN3). The gate itself lives per family (the
 * batch prologue and the single foreground path), but the wording must not
 * drift between them — the #375 prose guard treats a second copy as a build
 * failure.
 */
export function depthLimitRejection(currentDepth: number, maxDepth: number): ToolResult<undefined> {
	return rejection(
		`Cannot delegate further: subagent recursion depth limit reached ` +
		`(depth ${currentDepth}/${maxDepth}). ` +
		`Subagents can delegate up to ${maxDepth} levels deep (configurable via /brl-subagent depth). Complete the remaining work directly.`,
	);
}

/**
 * The empty-`provider/id` rejection (IN11): a model resolved to nothing usable.
 * Shared by the batch tail (`resolveModeModel`) and the single foreground path.
 */
export function modelNotConfiguredRejection(): ToolResult<undefined> {
	return rejection(
		"Subagent model is not configured. " +
		"Use /brl-subagent to set a model, or ensure your current session has a valid model.",
	);
}

// ── Gate 1: session cost ────────────────────────────────────────────────

/**
 * Session cost gate (R5 / W6): falls back to the $0.05 per-unit estimate,
 * checks the whole dispatch (units × estimate) against the session limit, and
 * returns the verbatim rejection result when it would be exceeded.
 *
 * This module holds the codebase's SINGLE `checkCostLimit(perTaskEstimate * …)`
 * site — the duplication that shape caused a mutation-target-drift incident
 * (issue #201).
 */
export function gateSessionCost(input: {
	state: SessionState;
	ctx: ExtensionContext;
	log: Logger;
	/** Number of units this dispatch would spawn (1 for single-task modes). */
	units: number;
	/** e.g. "Parallel delegation" → log line "Parallel delegation rejected: session cost limit reached". */
	label: string;
}): ToolResult<undefined> | undefined {
	const { state, ctx, log, units, label } = input;
	const perTaskEstimate =
		state.config.perTaskCostEstimate > 0
			? state.config.perTaskCostEstimate
			: 0.05;
	if (state.checkCostLimit(perTaskEstimate * units, ctx)) {
		const currentTotal = state.getSessionTotalCost(ctx);
		const limit = state.config.sessionCostLimit;
		log.warn(`${label}: session cost limit reached`, {
			currentTotal,
			estimatedCost: perTaskEstimate * units,
			limit,
		});
		return rejection(
			`Cannot delegate: session cost limit reached ` +
			`($${currentTotal.toFixed(4)} spent of $${limit.toFixed(2)} limit). ` +
			`Increase the limit via /brl-subagent costlimit or set to 0 for unlimited.`,
		);
	}
	return undefined;
}

// ── Gate 2: approvalMode 'always' in background ─────────────────────────

/**
 * Background paths (single spawn and fan-out) reject approvalMode 'always'
 * before spawning: there is no interactive dialog to approve the diff, so
 * 'always' cannot work — reject loudly instead of running unattended with
 * write access (W5, issue #28). Verbatim message, pinned by the suites.
 */
export function rejectApprovalAlwaysInBackground(
	approvalMode: ApprovalMode,
): ToolResult<undefined> | undefined {
	if (approvalMode !== "always") return undefined;
	return rejection(
		`Cannot spawn background agent with approvalMode 'always': background agents run unattended ` +
		`and cannot present the approval dialog. Use approvalMode 'auto' (default) or 'writes'.`,
	);
}

// ── Gate 3a: cwd (+ outputFile) target validation ───────────────────────

export type DelegationTargetsResult =
	| { ok: true; cwd: string; outputFile: string | undefined }
	| { ok: false; error: ToolResult<undefined> };

/**
 * Validate the dispatch's target cwd, then — when `outputFile` is given — the
 * outputFile path (F1), returning both resolved values on success. `prefix`
 * (a per-unit label like `Task 2 ("two")`) is prepended as `${prefix}: ` to
 * the rejection messages; omit it for the unprefixed single-unit messages.
 *
 * Note: the foreground parallel mode historically validates only the cwd
 * here (no outputFile step) — it simply passes no outputFile.
 */
export function validateDelegationTargets(input: {
	ctx: ExtensionContext;
	effectiveCwd: string;
	/** Raw outputFile to path-validate; the step is skipped when omitted. */
	outputFile?: string;
	/** Unit prefix for the rejection messages, e.g. `Task 2 ("two")`. */
	prefix?: string;
}): DelegationTargetsResult {
	const prefix = input.prefix ? `${input.prefix}: ` : "";

	const cwdResult = validateCwd(input.effectiveCwd, input.ctx.cwd);
	if (!cwdResult.ok) {
		return { ok: false, error: rejection(`${prefix}Invalid cwd: ${cwdResult.error}`) };
	}

	let outputFile: string | undefined;
	if (input.outputFile) {
		const ofResult = validateOutputFile(input.outputFile, cwdResult.value);
		if (!ofResult.ok) {
			return { ok: false, error: rejection(`${prefix}Invalid outputFile: ${ofResult.error}`) };
		}
		outputFile = ofResult.value;
	}

	return { ok: true, cwd: cwdResult.value, outputFile };
}

// ── Gate 3b: H1 pre-task validation ─────────────────────────────────────

/** Outcome of one pre-task validation: the rejection (hard failure) and/or
 * the warnings the caller must surface in the tool result. */
export interface PreTaskValidationOutcome {
	/** Rejection result when validation failed (hard errors); undefined when it passed. */
	error?: ToolResult<undefined>;
	/** Validation warnings — surfaced in the returned tool result, not just logged. */
	warnings: string[];
}

/**
 * Render validation warnings for a tool result: one labelled, bulleted
 * block. Empty input renders the empty string so results stay
 * byte-identical when there is nothing to say.
 */
export function formatValidationWarnings(warnings: string[]): string {
	if (warnings.length === 0) return "";
	return `\n\n[pre-task validation warnings]\n` + warnings.map((w) => `- ${w}`).join("\n");
}

/**
 * Run validatePreTask (H1) with the site's exact input, warn on warnings,
 * and return the rejection outcome (joined errors) on hard failure.
 * `label` names the site in the warn logs ("Parallel pre-task validation
 * warnings" / "Background fan-out …" / "Background …"); `prefix` is
 * prepended as `${prefix}: ` to the hard-failure message; `logContext` adds
 * site fields to both warn entries (the fan-out adds the task index).
 * The returned warnings are for RESULT surfacing — the log.warn calls stay
 * regardless (a warning must reach both the log and the conductor).
 */
export function runPreTaskValidation(input: {
	log: Logger;
	preTask: ValidateConfig;
	label: string;
	/** Unit prefix for the rejection message, e.g. `Task 2 ("two")`. */
	prefix?: string;
	/** Extra structured fields merged into the warn entries. */
	logContext?: Record<string, unknown>;
}): PreTaskValidationOutcome {
	const { log, preTask, label, prefix, logContext } = input;
	const validation = validatePreTask(preTask);
	if (validation.warnings.length > 0) {
		log.warn(`${label} pre-task validation warnings`, { ...logContext, warnings: validation.warnings });
	}
	if (!validation.valid) {
		const errText = validation.errors.join("; ");
		log.warn(`${label} pre-task validation failed`, { ...logContext, errors: validation.errors });
		return {
			error: rejection(prefix ? `${prefix}: ${errText}` : errText),
			warnings: validation.warnings,
		};
	}
	return { warnings: validation.warnings };
}

// ── Gate 4: per-unit pre-pass (merge → targets → H1) ────────────────────

/**
 * A merged per-unit source, structurally (mergeSubTaskParams lives in
 * index.ts and is passed in by the handler). These are the fields the
 * pre-pass reads; the handler's own type is preserved through the generic
 * `M` so it can build its mode-specific unit records from the result.
 */
export interface UnitPrePassSource {
	task: string;
	label?: string;
	effectiveCwd: string;
	outputFile?: string;
	thinkingLevel: ThinkingLevel;
	toolOptions?: SubagentToolOptions;
}

/** One validated unit: the handler's unit and merged source, plus the
 * resolved cwd/outputFile that unit must spawn in. */
export interface ValidatedUnit<U, M extends UnitPrePassSource> {
	unit: U;
	merged: M;
	cwd: string;
	outputFile: string | undefined;
}

export interface UnitPrePassInput<U, M extends UnitPrePassSource> {
	units: readonly U[];
	/** The handler's mergeSubTaskParams, bound to its globalParams. */
	merge: (unit: U, index: number) => M;
	/**
	 * Per-unit display data the handler already computes — no formatting
	 * policy lives in this helper. Called after `merge` and before target
	 * validation, so the unit is described exactly once, in unit order.
	 */
	describe: (
		unit: U,
		merged: M,
		index: number,
	) => {
		/** Unit prefix, e.g. `Step 1 ("one")` / `Node "n1"`. */
		prefix: string;
		/** Extra structured fields merged into the H1 warn entries. */
		logContext: Record<string, unknown>;
		/** Text H1 validates (defaults to `merged.task`); the graph
		 * pre-pass passes its placeholder-stripped declared text. */
		task?: string;
	};
	/** H1 site label, e.g. "Chain" / "Parallel" / "Graph". */
	label: string;
	/** Mode-level resolved git mode applied to every unit's H1. */
	gitMode: GitMode;
	ctx: ExtensionContext;
	log: Logger;
	/** Per-unit force flag (IN10): mode entry never carries it. */
	force?: boolean;
	/**
	 * The call-level `noJev` bypass (issue #412), forwarded to every unit's H1.
	 * Mode entry never carries it either: the mode-level pre-task check has no
	 * task text of its own to bypass, and a per-unit bypass would let a caller
	 * silence the check for a batch while appearing to pass it for the call.
	 */
	noJev?: string;
}

export type UnitPrePassOutcome<U, M extends UnitPrePassSource> =
	| { ok: false; error: ToolResult<undefined> }
	| { ok: true; units: Array<ValidatedUnit<U, M>>; warnings: string[] };

/**
 * The per-unit pre-pass shared by chain, parallel and graph: for EVERY unit,
 * merge → validate cwd/outputFile → H1 → collect `${prefix}: ${warning}`.
 *
 * This is a helper each handler CALLS at its own position; it is deliberately
 * not a hook the mode prologue invokes — the three modes run it at different
 * points (chain/parallel before model resolution, graph after the circuit
 * check and the topological sort), and the position is part of the contract
 * (design note #379 IN8). All units are validated before any spawn; the first
 * rejection wins, so nothing starts on a bad unit. Warnings come back in unit
 * order for the caller to surface after the result payload (IN9).
 */
export function validateUnitPrePass<U, M extends UnitPrePassSource>(
	input: UnitPrePassInput<U, M>,
): UnitPrePassOutcome<U, M> {
	const { units, merge, describe, label, gitMode, ctx, log, force, noJev } = input;
	const validated: Array<ValidatedUnit<U, M>> = [];
	const warnings: string[] = [];

	for (let i = 0; i < units.length; i++) {
		const unit = units[i];
		const merged = merge(unit, i);
		const display = describe(unit, merged, i);

		const targets = validateDelegationTargets({
			ctx,
			effectiveCwd: merged.effectiveCwd,
			outputFile: merged.outputFile,
			prefix: display.prefix,
		});
		if (!targets.ok) return { ok: false, error: targets.error };
		validated.push({ unit, merged, cwd: targets.cwd, outputFile: targets.outputFile });

		const validation = runPreTaskValidation({
			log,
			label,
			prefix: display.prefix,
			logContext: display.logContext,
			preTask: {
				task: display.task ?? merged.task,
				toolOptions: merged.toolOptions,
				thinkingLevel: merged.thinkingLevel,
				gitMode,
				outputFile: merged.outputFile,
				force,
				cwd: targets.cwd,
				noJev,
			},
		});
		if (validation.error) return { ok: false, error: validation.error };
		for (const w of validation.warnings) warnings.push(`${display.prefix}: ${w}`);
	}

	return { ok: true, units: validated, warnings };
}

// ── Batch tail: model resolution + empty-model + circuit (IN11) ──────────

export type SubagentModelResolution =
	| { ok: true; model: { provider: string; id: string } }
	| { ok: false; error: ToolResult<undefined> };

/**
 * Resolve WHICH model a dispatch runs on: per-call override > preset.model >
 * configured model > conductor model. The preset handed in is the mode-level
 * `resolvedPreset` — already carrying the auto-route decision when routing
 * chose it — so this one chain serves the batch tail and the single/background
 * paths alike (the fallbacks log, they never throw).
 */
export function resolveSubagentModelPrecedence(input: {
	state: SessionState;
	ctx: ExtensionContext;
	log: Logger;
	preset: SubagentPreset | undefined;
	/** Top-level delegate_task model override (issue #96) — beats the preset. */
	perCallModel?: string;
}): SubagentModelResolution {
	const { state, ctx, log, preset, perCallModel } = input;
	let subagentModel: { provider: string; id: string } | undefined;

	if (perCallModel) {
		const parsed = parseModelString(perCallModel);
		if (!parsed) {
			log.warn("Model override is not a valid provider/model-id, falling back", { model: perCallModel });
		} else if (modelIsAvailable(ctx.modelRegistry, parsed)) {
			log.info("Using per-call model override", { model: perCallModel });
			return { ok: true, model: parsed };
		} else {
			log.warn("Model override unavailable, falling back", { model: perCallModel });
		}
	}

	if (preset?.model) {
		const parsed = parseModelString(preset.model);
		if (parsed && modelIsAvailable(ctx.modelRegistry, parsed)) {
			subagentModel = parsed;
			log.info("Using preset model", { preset: preset.name, model: preset.model });
		} else {
			// Fallback: preset model unavailable → configured model
			log.warn("Preset model unavailable, falling back to configured model", {
				preset: preset.name,
				model: preset.model,
			});
		}
	}

	if (!subagentModel) {
		subagentModel =
			state.config.model ||
			(ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
	}

	if (!subagentModel) {
		return {
			ok: false,
			error: rejection(
				"No model available. Configure API keys first, then use /brl-subagent to set a model.",
			),
		};
	}

	return { ok: true, model: subagentModel };
}

export type ModeModelOutcome =
	| { ok: true; model: { provider: string; id: string }; modelStr: string }
	| { ok: false; error: ToolResult<undefined> };

/**
 * The batch modes' shared tail (IN11): resolve the model (preset + per-call
 * override), reject an empty `provider/id` resolution, then apply the circuit
 * breaker. Handlers CALL it at their own position — chain/parallel after the
 * per-unit pass, graph before its topological sort and per-node pass — because
 * that position is pinned (IN8/IN11).
 */
export function resolveModeModel(input: {
	state: SessionState;
	ctx: ExtensionContext;
	log: Logger;
	preset: SubagentPreset | undefined;
	perCallModel?: string;
}): ModeModelOutcome {
	const { state, ctx, log, preset, perCallModel } = input;

	const resolution = resolveSubagentModelPrecedence({ state, ctx, log, preset, perCallModel });
	if (!resolution.ok) return { ok: false, error: resolution.error };
	const subagentModel = resolution.model;

	const modelStr = `${subagentModel.provider}/${subagentModel.id}`.trim();
	if (!modelStr || modelStr === "/") {
		log.warn("Model string is empty after resolution", { model: subagentModel });
		return {
			ok: false,
			error: modelNotConfiguredRejection(),
		};
	}

	// R1: Circuit breaker check — after model resolution (IN11).
	const circuitCheck = state.checkCircuit();
	if (circuitCheck.isOpen) {
		return { ok: false, error: rejection(circuitCheck.message!) };
	}

	return { ok: true, model: subagentModel, modelStr };
}
