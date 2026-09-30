// Probe 1 — assignability claims for the four casts (issue #239).
// EXPECTED SIGNATURES (stated before running):
//   1a OK    : DelegateTaskParams["chain"] element -> SubTaskParams (structural subset)
//   1b OK    : DelegateTaskParams["tasks"] element -> SubTaskParams
//   1c ERROR : DelegateTaskParams["graph"] element -> GraphTask (dependsOn optional vs required)
//   1d OK    : same as 1c but with GraphTaskVariant (dependsOn?: string[])
//   1e OK    : DelegateTaskParams -> Record<string, unknown> (implicit index signature of type alias)
//   1f OK    : assertion params as {task: string; ...} (resolveSubagentParams call-site shape) legal
//   1g OK    : SubTaskParams -> inline chain element (reverse direction; both directions assignable => assertion is legal today)

import type { DelegateTaskParams, SubTaskParams, GraphTask } from "./types";

declare const params: DelegateTaskParams;

// 1a
const a: SubTaskParams[] = params.chain!;
// 1b
const b: SubTaskParams[] = params.tasks!;

// 1c — EXPECT ERROR on the next line
const c: GraphTask[] = params.graph!;

// 1d — EXPECT OK
interface GraphTaskVariant {
	id: string;
	task: string;
	label?: string;
	model?: string;
	thinkingLevel?: string;
	priority?: string;
	cwd?: string;
	timeout?: number;
	outputFile?: string;
	tools?: string[];
	excludeTools?: string[];
	noBuiltinTools?: boolean;
	systemPrompt?: string;
	inheritSystemPrompt?: boolean;
	dependsOn?: string[];
}
const d: GraphTaskVariant[] = params.graph!;

// 1e — EXPECT OK (this is how execute() passes params to findUnknownParams today)
const e: Record<string, unknown> = params;

// 1f — EXPECT OK (assertion used at the 4 resolveSubagentParams call sites)
const f = params as {
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
};

// 1g — EXPECT OK
declare const st: SubTaskParams;
const g: NonNullable<DelegateTaskParams["chain"]>[number] = st;

// keep "unused" quiet without affecting assignability checks
export type _Keep = [typeof a, typeof b, typeof c, typeof d, typeof e, typeof f, typeof g];
