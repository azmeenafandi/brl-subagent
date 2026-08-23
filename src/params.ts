/**
 * brl-subagent — Parameter Resolution (issue #59)
 *
 * resolveSubagentParams merges per-call params with the resolved preset,
 * then applies thinking-level caps, timeout normalization, the edit→write
 * tool fix, git mode / approval mode resolution, and E2 auto-routing.
 *
 * The function used to live as a closure inside src/index.ts's default
 * export, which forced the integration tests to replicate it — a copy that
 * silently drifted from the real behavior. Extracted here so the tests can
 * drive the REAL function (no more silent test drift).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
	ThinkingLevel,
	SubagentPreset,
	GitMode,
	ApprovalMode,
	SubagentToolOptions,
	ResolvedParams,
} from "./types";
import { resolveThinkingLevel } from "./types";
import { getAllPresets, getPreset } from "./presets";
import { autoRoutePreset } from "./router";
import { normalizeTimeout } from "./validate";
import type { SessionState } from "./state";
import type { Logger } from "./logging";

// ---------------------------------------------------------------------------
// delegate_task known keys (issue #99)
// ---------------------------------------------------------------------------

/**
 * Keys the delegate_task schema declares. TypeBox's Type.Object allows
 * additional properties by default, so this set is the source of truth for
 * the unknown-param warn: any received key outside it is silently ignored
 * by execute and worth a warn.
 *
 * Single source of truth (review R1): index.ts imports this instead of
 * carrying a duplicate, and per-step-model.test.ts ratchets it against the
 * REAL registered schema (the #108-class drift that #99's fix targeted can
 * never silently return). Keep in sync with the schema's Type.Object({ ... })
 * block in index.ts.
 */
export const KNOWN_DELEGATE_KEYS = new Set([
	"task", "systemPrompt", "inheritSystemPrompt", "thinkingLevel",
	"outputFile", "label", "model", "timeout", "cwd", "tools",
	"excludeTools", "noBuiltinTools", "preset", "template", "params",
	"retryRunId", "gitMode", "retryOnTimeout", "approvalMode", "background",
	"priority", "chain", "tasks", "graph",
] as const);

/**
 * Issue #99: warn-worthy unknown keys in a delegate_task params object.
 * TypeBox's Type.Object allows additional properties by default and pi's
 * validateToolArguments returns validated args UNCHANGED — so unknown keys
 * survive to execute and are silently ignored. Comparing received keys
 * against the schema's known keys converts that silent class into a
 * visible one (warn-not-reject: never break a delegation).
 */
export function findUnknownParams(
	received: Record<string, unknown>,
	knownKeys: ReadonlySet<string>,
): string[] {
	return Object.keys(received).filter((k) => !knownKeys.has(k));
}

/**
 * Issue #108: snapshot the caller's raw delegate_task params onto a run
 * record's originalParams — single source of truth for the retry merge
 * (resolveRetryParams). The background and foreground run-record creation
 * sites previously duplicated this 12-field literal (priority added, issue
 * #114); a future param added to one and not the other would silently
 * degrade retries of that path.
 * NOTE: the schema's `params` (template slots) key is intentionally NOT
 * snapshotted — it is a template-resolution input, not a retry override.
 */
export function snapshotOriginalParams(params: {
	systemPrompt?: string;
	inheritSystemPrompt?: boolean;
	model?: string;
	thinkingLevel?: string;
	priority?: string;
	outputFile?: string;
	timeout?: number;
	cwd?: string;
	tools?: string[];
	excludeTools?: string[];
	noBuiltinTools?: boolean;
	preset?: string;
}): Record<string, unknown> {
	return {
		systemPrompt: params.systemPrompt,
		inheritSystemPrompt: params.inheritSystemPrompt,
		model: params.model,
		thinkingLevel: params.thinkingLevel,
		priority: params.priority,
		outputFile: params.outputFile,
		timeout: params.timeout,
		cwd: params.cwd,
		tools: params.tools,
		excludeTools: params.excludeTools,
		noBuiltinTools: params.noBuiltinTools,
		preset: params.preset,
	};
}

export function resolveSubagentParams(
	params: {
		task: string;
		label?: string;
		preset?: string;
		systemPrompt?: string;
		inheritSystemPrompt?: boolean;
		thinkingLevel?: string;
		outputFile?: string;
		timeout?: number;
		cwd?: string;
		tools?: string[];
		excludeTools?: string[];
		noBuiltinTools?: boolean;
		gitMode?: string;
		approvalMode?: string;
		template?: string;
	},
	state: SessionState,
	ctx: ExtensionContext,
	log: Logger,
): ResolvedParams & {
	resolvedGitMode: GitMode;
	resolvedApprovalMode: ApprovalMode;
	resolvedPreset?: SubagentPreset;
	autoRoutedPreset?: SubagentPreset; // set only when autoRoutePreset chose it
} {
	// E2: Auto-route to best preset only when the conductor expressed NO
	// explicit preference — an explicit preset, template, or tool
	// parameters (tools/excludeTools/noBuiltinTools) all count as intent
	// that must win over keyword-based routing (issue #57).
	let resolvedPreset = params.preset;
	let wasAutoRouted = false;
	const hasExplicitToolPreference =
		params.tools !== undefined ||
		params.excludeTools !== undefined ||
		params.noBuiltinTools !== undefined;
	if (!resolvedPreset && !params.template && !hasExplicitToolPreference) {
		const allPresets = getAllPresets(state.builtinPresets, state.customPresets);
		const suggested = autoRoutePreset(params.task, allPresets);
		if (suggested) {
			resolvedPreset = suggested;
			wasAutoRouted = true;
			log.info("Auto-routed task to preset", { preset: suggested });
		}
	}

	const preset = resolvedPreset
		? getPreset(resolvedPreset, state.builtinPresets, state.customPresets)
		: undefined;
	const autoRoutedPreset = wasAutoRouted ? preset : undefined;

	const mergedThinkingLevel =
		(params.thinkingLevel as ThinkingLevel | undefined) ??
		(preset?.thinkingLevel as ThinkingLevel | undefined);
	const mergedSystemPrompt = params.systemPrompt ?? preset?.systemPrompt;
	const mergedInheritSP = params.inheritSystemPrompt ?? preset?.inheritSystemPrompt;
	const mergedOutputFile = params.outputFile ?? preset?.outputFile;
	const mergedTimeout = normalizeTimeout(params.timeout ?? preset?.timeout);
	const mergedTools = params.tools ?? preset?.tools;
	// Fix: edit depends on write in pi's tool system.
	// If edit is in the allowlist but write is not, all tools fail to resolve.
	const resolvedTools = mergedTools && mergedTools.includes("edit") && !mergedTools.includes("write")
		? [...mergedTools, "write"]
		: mergedTools;
	const mergedExcludeTools = params.excludeTools ?? preset?.excludeTools;
	const mergedNoBuiltinTools = params.noBuiltinTools ?? preset?.noBuiltinTools;

	// QUIRK (pre-existing, preserved from the original closure): gitMode merges
	// from preset?.NAME, not a preset gitMode field (SubagentPreset has none).
	// A preset literally named "branch"/"none" would silently set gitMode.
	// Deliberately NOT changed here — altering it is a behavior change beyond
	// issue #59's scope.
	const mergedGitMode = (params.gitMode as GitMode | undefined) ?? preset?.name;
	const resolvedGitMode: GitMode =
		mergedGitMode === "branch" || mergedGitMode === "none"
			? mergedGitMode
			: state.config.gitMode;

	// P4: Resolve approval mode: per-call param > state config > default "writes"
	const mergedApprovalMode = params.approvalMode as ApprovalMode | undefined;
	const resolvedApprovalMode: ApprovalMode =
		mergedApprovalMode === "auto" || mergedApprovalMode === "writes" || mergedApprovalMode === "always"
			? mergedApprovalMode
			: state.config.approvalMode;

	const thinkingLevel = resolveThinkingLevel(
		mergedThinkingLevel,
		state.config.maxThinkingLevel,
	);

	const toolOptions: SubagentToolOptions | undefined =
		resolvedTools || mergedExcludeTools || mergedNoBuiltinTools
			? {
					tools: resolvedTools,
					excludeTools: mergedExcludeTools,
					noBuiltinTools: mergedNoBuiltinTools,
				}
			: undefined;

	return {
		task: params.task,
		label: params.label?.trim() || undefined,
		inheritSP: mergedInheritSP !== false,
		customSP: mergedSystemPrompt,
		outputFile: mergedOutputFile,
		timeout: mergedTimeout,
		effectiveCwd: params.cwd || ctx.cwd,
		thinkingLevel,
		toolOptions,
		resolvedGitMode,
		resolvedApprovalMode,
		resolvedPreset: preset,
		autoRoutedPreset,
	};
}
