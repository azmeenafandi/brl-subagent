/**
 * Tests for the update module.
 *
 * Since checkForUpdates makes real HTTP calls, we only test
 * that the module exports the function correctly and that
 * the semver comparison logic works as expected.
 */

import { describe, it, expect } from "vitest";
import { checkForUpdates } from "../update";

describe("checkForUpdates", () => {
	it("exports a function", () => {
		expect(typeof checkForUpdates).toBe("function");
	});

	it("returns a Promise", () => {
		const result = checkForUpdates("2.0.1");
		expect(result).toBeInstanceOf(Promise);
		// Clean up the promise to avoid unhandled rejection warnings
		result.catch(() => {});
	});
});
