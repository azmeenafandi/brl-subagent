// Probe 2 — schema-linked (Static<>) claims + drift-silence claim.
// EXPECTED SIGNATURES (stated before running):
//   2a OK    : Static chain element -> SubTaskParams (priority union -> string ok)
//   2b OK    : Static tasks element -> SubTaskParams
//   2c PROBE : Static-derived alias -> Record<string, unknown>  (implicit index signature via generic? — UNCERTAIN, this is the probe)
//   2d OK    : keyof Static gives literal keys; Exclude<SetLiteral, keyof Static> === never (the _DelegateParamCoverage shape works)
//   2e OK    : `params.priority as string` / `as string | undefined` still compiles on Static-derived top level
//   2f PROBE : drift-silence — a schema element with an EXTRA key stays assignable BOTH ways to a hand type without it (=> today's bivariant check cannot see element key drift)
//   2g PROBE : strict (contravariant) function-type check rejects even a single-key element drift — the check a Static-derived type makes unnecessary

import { Type, type Static } from "typebox";
import type { SubTaskParams, DelegateTaskParams } from "./types";

const chainStepSchema = Type.Object({
	task: Type.String({}),
	label: Type.Optional(Type.String({})),
	model: Type.Optional(Type.String({})),
	thinkingLevel: Type.Optional(Type.String({})),
	cwd: Type.Optional(Type.String({})),
	timeout: Type.Optional(Type.Number({})),
	outputFile: Type.Optional(Type.String({})),
	tools: Type.Optional(Type.Array(Type.String({}))),
	excludeTools: Type.Optional(Type.Array(Type.String({}))),
	noBuiltinTools: Type.Optional(Type.Boolean({})),
	systemPrompt: Type.Optional(Type.String({})),
	inheritSystemPrompt: Type.Optional(Type.Boolean({})),
});

const taskItemSchema = Type.Object({
	task: Type.String({}),
	label: Type.Optional(Type.String({})),
	model: Type.Optional(Type.String({})),
	thinkingLevel: Type.Optional(Type.String({})),
	priority: Type.Optional(
		Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]),
	),
	cwd: Type.Optional(Type.String({})),
	timeout: Type.Optional(Type.Number({})),
	outputFile: Type.Optional(Type.String({})),
	tools: Type.Optional(Type.Array(Type.String({}))),
	excludeTools: Type.Optional(Type.Array(Type.String({}))),
	noBuiltinTools: Type.Optional(Type.Boolean({})),
	systemPrompt: Type.Optional(Type.String({})),
	inheritSystemPrompt: Type.Optional(Type.Boolean({})),
});

const graphNodeSchema = Type.Object({
	id: Type.String({}),
	task: Type.String({}),
	label: Type.Optional(Type.String({})),
	model: Type.Optional(Type.String({})),
	dependsOn: Type.Optional(Type.Array(Type.String({}))),
	thinkingLevel: Type.Optional(Type.String({})),
	priority: Type.Optional(
		Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]),
	),
	cwd: Type.Optional(Type.String({})),
	timeout: Type.Optional(Type.Number({})),
	outputFile: Type.Optional(Type.String({})),
	tools: Type.Optional(Type.Array(Type.String({}))),
	excludeTools: Type.Optional(Type.Array(Type.String({}))),
	noBuiltinTools: Type.Optional(Type.Boolean({})),
	systemPrompt: Type.Optional(Type.String({})),
	inheritSystemPrompt: Type.Optional(Type.Boolean({})),
});

// The full params schema — only the fields needed for the checks.
const delegateSchema = Type.Object({
	task: Type.Optional(Type.String({})),
	priority: Type.Optional(
		Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]),
	),
	chain: Type.Optional(Type.Array(chainStepSchema)),
	tasks: Type.Optional(Type.Array(taskItemSchema)),
	graph: Type.Optional(Type.Array(graphNodeSchema)),
});

export type ChainStepParams = Static<typeof chainStepSchema>;
export type TaskItemParams = Static<typeof taskItemSchema>;
export type GraphNodeParams = Static<typeof graphNodeSchema>;
export type DelegateParamsDerived = Static<typeof delegateSchema>;

declare const dp: DelegateParamsDerived;

// 2a — EXPECT OK
const a: SubTaskParams[] = dp.chain!;
// 2b — EXPECT OK
const b: SubTaskParams[] = dp.tasks!;

// 2c — PROBE: does the Static-derived alias get the implicit index signature?
const c: Record<string, unknown> = dp;

// 2d — EXPECT OK (compiles only if the coverage shape evaluates to never)
type _KnownKey = "task" | "priority" | "chain" | "tasks" | "graph";
type _ExpectNever<T extends never> = T;
type _Coverage = _ExpectNever<Exclude<_KnownKey, keyof DelegateParamsDerived>>;

// 2e — EXPECT OK
const e1 = dp.priority as string | undefined;
const e2 = dp.priority && ["critical", "high", "normal", "low"].includes(dp.priority as string);

// 2f — drift-silence probe: schema element gains a key the hand type lacks.
const driftedSchema = Type.Object({
	task: Type.String({}),
	label: Type.Optional(Type.String({})),
	brandNewSchemaKey: Type.Optional(Type.String({})), // drift: in schema only
});
type Drifted = Static<typeof driftedSchema>;
declare const dv: Drifted;
declare const st: SubTaskParams; // hand type WITHOUT brandNewSchemaKey
// Both directions — EXPECT BOTH OK (i.e. drift is invisible to assignability):
const f1: SubTaskParams = dv;
const f2: Drifted = st;

// 2g — strict function-type check: contravariant parameter position.
// EXPECT: g1 FAILS (Static has a key the hand type lacks -> Static not assignable under strict check? no —
//   excess source props are fine, so g1 may still pass...). The REAL discriminator is required-ness:
//   schema says task required; hand type DelegateTaskParams has task?: string.
// g1: (hand accepts Static) requires Static -> hand.  EXPECT OK (excess source props allowed).
const g1: (p: DelegateParamsDerived) => void = (_p: DelegateParamsDerived) => {};
// g2: hand DelegateTaskParams in the parameter slot (this is what ToolDefinition does, but as a METHOD = bivariant).
// strictFunctionTypes applies only to function-type properties; simulate both directions:
const g2: (p: DelegateTaskParams) => void = (_p: DelegateParamsDerived) => {}; // needs Static -> hand
const g3: (p: DelegateParamsDerived) => void = (_p: DelegateTaskParams) => {}; // needs hand -> Static

export type _Keep = [typeof a, typeof b, typeof c, _Coverage, typeof e1, typeof e2, typeof f1, typeof f2, typeof g1, typeof g2, typeof g3];
