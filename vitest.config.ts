import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts", "scripts/__tests__/**/*.test.ts"],
		// Issue #511 (U2): a spawn creates a real scratch directory, so every
		// suite resolves its root into the repository's gitignored `.tmp/` chain
		// rather than the developer's real cache root. Per-test overrides go
		// through `createTempEnv` (`__setScratchRoot`).
		setupFiles: ["src/__tests__/setup-scratch-root.ts"],
		// Subprocess e2e tests spawn node + jiti (full extension load) —
		// needs more headroom than the 5s default, especially in CI.
		testTimeout: 30000,
		hookTimeout: 30000,
	},
});
