// Probe 4c — isolate the priority mismatch per surface (hand -> schema direction).
// EXPECTED SIGNATURES: each `bad` assignment FAILS (string vs union); each `good` (hand field -> hand field) passes.
import { Type, type Static } from "typebox";
import type { DelegateTaskParams } from "./types";

const prio = Type.Optional(
	Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]),
);
type SPrio = Static<typeof prio>;

declare const hand: DelegateTaskParams;
declare const sp: SPrio;

// top-level hand priority -> schema union.  EXPECT ERROR
const bad1: SPrio = hand.priority!;
// tasks element priority -> schema union.  EXPECT ERROR
const bad2: SPrio = hand.tasks![0].priority!;
// chain element (no priority in either shape).  EXPECT OK
const ok1: { task: string; label?: string } = hand.chain![0];

export type _Keep = [typeof bad1, typeof bad2, typeof ok1, typeof sp];
