import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
		// Subprocess e2e tests spawn node + jiti (full extension load) —
		// needs more headroom than the 5s default, especially in CI.
		testTimeout: 30000,
		hookTimeout: 30000,
	},
});
