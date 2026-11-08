// Purpose: The per-invocation runtime context (pi, log, state) the composition root builds once and hands to the mode runners.
/**
 * brl-subagent — the runtime context (cycle S2, ADR 0027 D1/D3)
 *
 * ADR 0027 D1 splits the composition root from the code it composes. The mode
 * runners (S2) are the first consumers that need the three long-lived bindings
 * `src/index.ts`'s `default` export used to own as closures: `pi` (the extension
 * API), `log` (the session logger) and `state` (the session-bound store).
 *
 * `RuntimeContext` names those three, and `createRuntime` builds them with the
 * exact order and arguments `index.ts` used inline — `createLogger` first
 * because `createSessionState` takes the logger. D1 is why this is a value, not
 * a module-level singleton: one context per `initExtension` invocation, so two
 * loaded sessions in one process share no state.
 *
 * Deliberately NOT part of the context (D3): `sessionCtx`,
 * `recoveryNoticeDelivered` and the other `default`-export closures. The runners
 * never read them (recon at 46b427e: zero references across the moved range);
 * adding one here without a consumer would be a binding the split does not
 * need. ADR 0027 F1: if a runner ever needs a fourth field, the split is wrong —
 * report it rather than widening this interface.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger, type Logger } from "./logging";
import { createSessionState, type SessionState } from "./state";

/**
 * The three bindings the mode runners read, captured once per extension
 * invocation. `readonly` because the split's contract is "handed in, never
 * rebound": `createRuntime` produces it, `createModeRunners` destructures it,
 * and nothing downstream reassigns a field (a rebind would be a second owner).
 */
export interface RuntimeContext {
	readonly pi: ExtensionAPI;
	readonly log: Logger;
	readonly state: SessionState;
}

/**
 * Build the runtime context for one extension invocation — the same two calls
 * `index.ts` made inline (log → state, in that order). The only reason this is a
 * function rather than three lines at the call site: the S2 boundary test drives
 * two contexts and asserts they are independent (ADR 0027 D1).
 */
export function createRuntime(pi: ExtensionAPI): RuntimeContext {
	const log = createLogger("brl-subagent");
	const state = createSessionState(log);
	return { pi, log, state };
}
