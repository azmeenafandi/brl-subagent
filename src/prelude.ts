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
 * Messages are byte-identical to the pre-extraction copies (the suites pin
 * them); the parameters absorb only the real differences between sites — the
 * cost-gate log label and unit count, and the H1 log label / unit prefix /
 * extra log fields.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalMode, ToolResult } from "./types";
import type { SessionState } from "./state";
import type { Logger } from "./logging";
import { validateCwd, validateOutputFile } from "./sanitize";
import { validatePreTask, type ValidateConfig } from "./validate";

/** The standard rejection result shape shared by these gates. */
function rejection(text: string): ToolResult<undefined> {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
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
