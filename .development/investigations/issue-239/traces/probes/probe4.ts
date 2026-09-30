// Probe 4 — strict two-way comparison: real hand DelegateTaskParams vs a Static-derived
// mirror of the FULL registered schema (25 top-level keys, element shapes per index.ts
// lines 2771-3013). The SDK's execute() check is bivariant (method syntax), so it cannot
// see mismatches that only break ONE direction. This probe breaks the tie.
//
// EXPECTED SIGNATURES:
//   4a (Static -> hand) EXPECT OK entirely: the schema's shapes are assignable to the hand type.
//   4b (hand -> Static) EXPECT FAIL ONLY on `priority` (hand: string; schema: 4-literal union)
//      at top level and in tasks[]/graph[] elements. Any OTHER error = a real drift the
//      issue brief did not list.

import { Type, type Static } from "typebox";
import type { DelegateTaskParams } from "./types";

const chainStep = Type.Object({
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

const prio = Type.Optional(
	Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]),
);

const taskItem = Type.Object({
	task: Type.String({}),
	label: Type.Optional(Type.String({})),
	model: Type.Optional(Type.String({})),
	thinkingLevel: Type.Optional(Type.String({})),
	priority: prio,
	cwd: Type.Optional(Type.String({})),
	timeout: Type.Optional(Type.Number({})),
	outputFile: Type.Optional(Type.String({})),
	tools: Type.Optional(Type.Array(Type.String({}))),
	excludeTools: Type.Optional(Type.Array(Type.String({}))),
	noBuiltinTools: Type.Optional(Type.Boolean({})),
	systemPrompt: Type.Optional(Type.String({})),
	inheritSystemPrompt: Type.Optional(Type.Boolean({})),
});

const graphNode = Type.Object({
	id: Type.String({}),
	task: Type.String({}),
	label: Type.Optional(Type.String({})),
	model: Type.Optional(Type.String({})),
	dependsOn: Type.Optional(Type.Array(Type.String({}))),
	thinkingLevel: Type.Optional(Type.String({})),
	priority: prio,
	cwd: Type.Optional(Type.String({})),
	timeout: Type.Optional(Type.Number({})),
	outputFile: Type.Optional(Type.String({})),
	tools: Type.Optional(Type.Array(Type.String({}))),
	excludeTools: Type.Optional(Type.Array(Type.String({}))),
	noBuiltinTools: Type.Optional(Type.Boolean({})),
	systemPrompt: Type.Optional(Type.String({})),
	inheritSystemPrompt: Type.Optional(Type.Boolean({})),
});

const fullSchema = Type.Object({
	task: Type.Optional(Type.String({})),
	label: Type.Optional(Type.String({})),
	model: Type.Optional(Type.String({})),
	preset: Type.Optional(Type.String({})),
	systemPrompt: Type.Optional(Type.String({})),
	inheritSystemPrompt: Type.Optional(Type.Boolean({})),
	thinkingLevel: Type.Optional(Type.String({})),
	outputFile: Type.Optional(Type.String({})),
	timeout: Type.Optional(Type.Number({})),
	cwd: Type.Optional(Type.String({})),
	tools: Type.Optional(Type.Array(Type.String({}))),
	excludeTools: Type.Optional(Type.Array(Type.String({}))),
	noBuiltinTools: Type.Optional(Type.Boolean({})),
	template: Type.Optional(Type.String({})),
	params: Type.Optional(Type.Record(Type.String(), Type.String({}))),
	retryRunId: Type.Optional(Type.String({})),
	retryOnTimeout: Type.Optional(Type.Boolean({})),
	background: Type.Optional(Type.Boolean({})),
	force: Type.Optional(Type.Boolean({})),
	gitMode: Type.Optional(Type.String({})),
	approvalMode: Type.Optional(Type.String({})),
	priority: prio,
	chain: Type.Optional(Type.Array(chainStep)),
	tasks: Type.Optional(Type.Array(taskItem)),
	graph: Type.Optional(Type.Array(graphNode)),
});

type SchemaParams = Static<typeof fullSchema>;

declare const hand: DelegateTaskParams;
declare const derived: SchemaParams;

// 4a — EXPECT OK (schema -> hand)
const a: DelegateTaskParams = derived;

// 4b — EXPECT: errors ONLY on priority (hand -> schema)
const b: SchemaParams = hand;

export type _Keep = [typeof a, typeof b];
