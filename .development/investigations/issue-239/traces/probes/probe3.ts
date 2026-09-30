// Probe 3 — keyof on Static-derived alias is literal (so _DelegateParamCoverage stays meaningful),
// and the implicit index signature doesn't turn keyof into string.
// EXPECTED SIGNATURES:
//   3a OK   : keyof Derived is the literal union ("task" assignable FROM keyof)
//   3b OK   : Exclude<literal set, keyof Derived> === never, and NOT trivially never via keyof = string
//             (3a proves non-string; 3b proves the Exclude direction)

import { Type, type Static } from "typebox";

const schema = Type.Object({
	task: Type.Optional(Type.String({})),
	chain: Type.Optional(Type.Array(Type.Object({ task: Type.String({}) }))),
});
type Derived = Static<typeof schema>;

type K = keyof Derived;
// 3a — EXPECT OK: if keyof were `string`, this assignment would fail
const a: "task" = null as unknown as K;

// 3b — EXPECT OK; and to prove it isn't vacuous, a MISSING key must NOT be never
type _ExpectNever<T extends never> = T;
type Good = _ExpectNever<Exclude<"task" | "chain", K>>;
// @ts-expect-error — "bogus" is not in K, so Exclude is non-empty and this must FAIL
type Bad = _ExpectNever<Exclude<"task" | "bogus", K>>;

export type _Keep = [typeof a, Good, Bad];
