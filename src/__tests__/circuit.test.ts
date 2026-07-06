/**
 * Tests for circuit breaker (R1) — SessionState.recordSuccess, recordFailure,
 * checkCircuit, and auto-recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionState } from "../state";
import {
	MAX_CONSECUTIVE_FAILURES,
	CIRCUIT_BREAKER_RESET_MS,
	CIRCUIT_DEGRADED_THINKING,
} from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createState(): SessionState {
	return new SessionState();
}

// ---------------------------------------------------------------------------
// recordSuccess
// ---------------------------------------------------------------------------

describe("recordSuccess", () => {
	it("resets consecutiveFailures to 0", () => {
		const state = createState();
		state.config.circuitBreaker.consecutiveFailures = 3;
		state.recordSuccess();
		expect(state.config.circuitBreaker.consecutiveFailures).toBe(0);
	});

	it("closes the circuit when open", () => {
		const state = createState();
		state.config.circuitBreaker.circuitOpen = true;
		state.config.circuitBreaker.degradedThinkingLevel = "minimal";
		state.recordSuccess();
		expect(state.config.circuitBreaker.circuitOpen).toBe(false);
		expect(state.config.circuitBreaker.degradedThinkingLevel).toBeUndefined();
		expect(state.config.circuitBreaker.lastFailureTime).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// recordFailure
// ---------------------------------------------------------------------------

describe("recordFailure", () => {
	it("increments consecutiveFailures by 1", () => {
		const state = createState();
		state.recordFailure();
		expect(state.config.circuitBreaker.consecutiveFailures).toBe(1);
	});

	it("does not open the circuit below the threshold", () => {
		const state = createState();
		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
			state.recordFailure();
		}
		expect(state.config.circuitBreaker.circuitOpen).toBe(false);
		expect(state.config.circuitBreaker.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES - 1);
	});

	it("opens the circuit at the threshold", () => {
		const state = createState();
		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
			state.recordFailure();
		}
		expect(state.config.circuitBreaker.circuitOpen).toBe(true);
		expect(state.config.circuitBreaker.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
	});

	it("sets degradedThinkingLevel when circuit opens", () => {
		const state = createState();
		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
			state.recordFailure();
		}
		expect(state.config.circuitBreaker.degradedThinkingLevel).toBe(CIRCUIT_DEGRADED_THINKING);
	});

	it("records lastFailureTime when circuit opens", () => {
		const state = createState();
		const before = Date.now();
		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
			state.recordFailure();
		}
		const after = Date.now();
		expect(state.config.circuitBreaker.lastFailureTime).toBeGreaterThanOrEqual(before);
		expect(state.config.circuitBreaker.lastFailureTime).toBeLessThanOrEqual(after);
	});
});

// ---------------------------------------------------------------------------
// checkCircuit — circuit open
// ---------------------------------------------------------------------------

describe("checkCircuit", () => {
	it("returns isOpen: false when circuit is closed", () => {
		const state = createState();
		const result = state.checkCircuit();
		expect(result.isOpen).toBe(false);
		expect(result.message).toBeUndefined();
	});

	it("returns isOpen: true when circuit is open and reset window has not passed", () => {
		const state = createState();
		// Manually open the circuit with a recent failure time
		state.config.circuitBreaker.circuitOpen = true;
		state.config.circuitBreaker.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
		state.config.circuitBreaker.lastFailureTime = Date.now();
		state.config.circuitBreaker.degradedThinkingLevel = "minimal";

		const result = state.checkCircuit();
		expect(result.isOpen).toBe(true);
		expect(result.message).toContain("Circuit breaker is open");
		expect(result.waitTimeRemaining).toBeGreaterThan(0);
		expect(result.waitTimeRemaining).toBeLessThanOrEqual(CIRCUIT_BREAKER_RESET_MS);
	});

	it("returns a user-friendly message when circuit is open", () => {
		const state = createState();
		state.config.circuitBreaker.circuitOpen = true;
		state.config.circuitBreaker.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
		state.config.circuitBreaker.lastFailureTime = Date.now();

		const result = state.checkCircuit();
		expect(result.message).toContain("5 consecutive failures");
		expect(result.message).toContain("Auto-recovery");
		expect(result.message).toContain("Wait");
	});

	it("auto-recovers and returns isOpen: false after reset window passes", () => {
		const state = createState();
		// Open the circuit with a failure time far in the past
		state.config.circuitBreaker.circuitOpen = true;
		state.config.circuitBreaker.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
		state.config.circuitBreaker.lastFailureTime = Date.now() - CIRCUIT_BREAKER_RESET_MS - 1000;
		state.config.circuitBreaker.degradedThinkingLevel = "minimal";

		const result = state.checkCircuit();
		expect(result.isOpen).toBe(false);
		expect(result.message).toBeUndefined();

		// Verify circuit state was reset
		expect(state.config.circuitBreaker.circuitOpen).toBe(false);
		expect(state.config.circuitBreaker.consecutiveFailures).toBe(0);
		expect(state.config.circuitBreaker.degradedThinkingLevel).toBeUndefined();
	});

	it("degradedThinkingLevel is set when circuit is open", () => {
		const state = createState();
		// Open the circuit naturally through repeated failures
		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
			state.recordFailure();
		}
		expect(state.config.circuitBreaker.circuitOpen).toBe(true);
		expect(state.config.circuitBreaker.degradedThinkingLevel).toBe(CIRCUIT_DEGRADED_THINKING);
	});
});

// ---------------------------------------------------------------------------
// Integration: recordSuccess resets after circuit open
// ---------------------------------------------------------------------------

describe("recordSuccess after circuit open", () => {
	it("resets the circuit breaker fully", () => {
		const state = createState();

		// Open the circuit
		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
			state.recordFailure();
		}
		expect(state.config.circuitBreaker.circuitOpen).toBe(true);

		// Record success
		state.recordSuccess();

		// Verify full reset
		expect(state.config.circuitBreaker.consecutiveFailures).toBe(0);
		expect(state.config.circuitBreaker.circuitOpen).toBe(false);
		expect(state.config.circuitBreaker.degradedThinkingLevel).toBeUndefined();
		expect(state.config.circuitBreaker.lastFailureTime).toBe(0);
		expect(state.checkCircuit().isOpen).toBe(false);
	});
});
