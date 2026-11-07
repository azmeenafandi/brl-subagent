import { defineConfig } from "vitest/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The repro runs with ITSELF as the vitest root so the shipped suite
// (`src/__tests__/**`) never picks it up.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		root: here,
		include: ["*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
		pool: "forks",
		reporters: ["verbose"],
	},
});
