/**
 * Contract tests for the pi SDK `ModelRegistry` auth APIs (issue #17).
 *
 * `modelIsAvailable` (src/model-availability.ts) is implemented against a
 * structural subset of the pi SDK's `ModelRegistry` and falls back to
 * catalog-only behavior when the registry exposes no auth API. The 15
 * existing tests only use mock registry shapes, so if the pi SDK renames or
 * reshapes `hasConfiguredAuth` / `getProviderAuthStatus`, those tests keep
 * passing while the extension silently reverts to catalog-only checks.
 *
 * These tests import the REAL `ModelRegistry` from
 * `@earendil-works/pi-coding-agent` and pin the contract:
 *   1. prototype surface — `hasConfiguredAuth`, `getProviderAuthStatus`,
 *      `find`, `getAll` must remain functions (a rename fails loudly here);
 *   2. real instantiation — a registry built from the real `ModelRuntime`
 *      must accept the exact shapes src/model-availability.ts uses
 *      (find(provider, modelId) -> model, hasConfiguredAuth(model) -> bool,
 *      getProviderAuthStatus(provider) -> { configured: boolean });
 *   3. end-to-end — `modelIsAvailable` driven by the REAL registry must
 *      report a catalog model as unavailable until its provider has
 *      configured auth, then available once auth is set.
 *
 * The registry is created with `modelsPath: null` (builtin catalog only, no
 * user models.json, no network) and a throwaway auth file in the OS temp dir,
 * so the tests never touch real `.pi` state.
 *
 * Provider env vars (ANTHROPIC_API_KEY etc.) are scrubbed for the whole file:
 * ModelRuntime resolves ambient credentials into its auth snapshot at
 * create() time, and the negative-auth tests assume a clean environment.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelIsAvailable } from "../model-availability";

/**
 * Provider env vars the pi SDK resolves as ambient credentials (see
 * pi-ai/dist/env-api-keys.js). ModelRuntime snapshots these at create() time;
 * the negative-auth tests below assume a CLEAN environment, so the vars must
 * be scrubbed for the whole file regardless of the developer's shell.
 */
const PROVIDER_ENV_VARS = [
	"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY", "OPENAI_AUTH_TOKEN", "OPENAI_OAUTH_TOKEN",
	"COPILOT_GITHUB_TOKEN",
	"ANT_LING_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY",
	"AZURE_OPENAI_API_KEY", "NVIDIA_API_KEY", "DEEPSEEK_API_KEY",
	"GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS",
	"GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "RADIUS_API_KEY",
	"OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY", "HF_TOKEN",
	"FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENCODE_API_KEY",
	"KIMI_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_WEB_IDENTITY_TOKEN_FILE",
];

const savedEnv: Record<string, string | undefined> = {};
const createdAuthDirs: string[] = [];

function scrubProviderEnv() {
	for (const key of PROVIDER_ENV_VARS) delete process.env[key];
}

function restoreProviderEnv() {
	for (const key of PROVIDER_ENV_VARS) {
		if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
		else delete process.env[key];
	}
}

beforeAll(() => {
	for (const key of PROVIDER_ENV_VARS) savedEnv[key] = process.env[key];
	scrubProviderEnv();
});

afterAll(async () => {
	restoreProviderEnv();
	await Promise.all(
		createdAuthDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function createRealRegistry() {
	// Defense in depth: ModelRuntime.create() resolves ambient credentials into
	// its snapshot, so the beforeAll scrub covers today's behavior; re-scrub in
	// case the SDK ever resolves auth lazily or the registry is re-created.
	scrubProviderEnv();
	const authDir = await mkdtemp(join(tmpdir(), "brl-sdk-contract-"));
	createdAuthDirs.push(authDir);
	const runtime = await ModelRuntime.create({
		modelsPath: null, // builtin catalog only — no user models.json, no network
		authPath: join(authDir, "auth.json"),
	});
	return { registry: new ModelRegistry(runtime), runtime };
}

/**
 * Pick a model from the LIVE registry whose provider has no configured auth in
 * the scrubbed environment. Derived at runtime instead of hard-coding a model
 * id, so the tests survive pi catalog churn between releases.
 */
function pickUnconfiguredModel(registry: ModelRegistry) {
	const model = registry.getAll().find((m) => !registry.hasConfiguredAuth(m));
	expect(model).toBeDefined();
	return model!;
}

describe("pi SDK ModelRegistry — auth API contract", () => {
	it("exports ModelRegistry from the package entry", () => {
		expect(typeof ModelRegistry).toBe("function");
	});

	it("ModelRegistry.prototype.hasConfiguredAuth is a function", () => {
		expect(typeof ModelRegistry.prototype.hasConfiguredAuth).toBe("function");
	});

	it("ModelRegistry.prototype.getProviderAuthStatus is a function", () => {
		expect(typeof ModelRegistry.prototype.getProviderAuthStatus).toBe("function");
	});

	it("ModelRegistry.prototype.find is a function", () => {
		expect(typeof ModelRegistry.prototype.find).toBe("function");
	});

	it("ModelRegistry.prototype.getAll is a function", () => {
		expect(typeof ModelRegistry.prototype.getAll).toBe("function");
	});
});

describe("real ModelRegistry — shapes used by src/model-availability.ts", () => {
	it("find(provider, modelId) returns a model with provider/id strings", async () => {
		const { registry } = await createRealRegistry();
		const model = pickUnconfiguredModel(registry);

		const found = registry.find(model.provider, model.id);
		expect(found).toBeDefined();
		expect(found!.provider).toBe(model.provider);
		expect(found!.id).toBe(model.id);

		// Unknown model -> undefined (same shape contract as ModelRegistryLike)
		expect(registry.find(model.provider, "no-such-model")).toBeUndefined();
	});

	it("getAll() returns an array of models with provider/id strings", async () => {
		const { registry } = await createRealRegistry();

		const models = registry.getAll();
		expect(Array.isArray(models)).toBe(true);
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(typeof model.provider).toBe("string");
			expect(typeof model.id).toBe("string");
		}
	});

	it("hasConfiguredAuth(model) accepts a found model and returns a boolean", async () => {
		const { registry } = await createRealRegistry();
		const model = pickUnconfiguredModel(registry);

		// Fresh registry + scrubbed env: no credentials configured for this provider
		expect(registry.hasConfiguredAuth(model)).toBe(false);
	});

	it("getProviderAuthStatus(provider) returns { configured: boolean }", async () => {
		const { registry } = await createRealRegistry();
		const model = pickUnconfiguredModel(registry);

		const status = registry.getProviderAuthStatus(model.provider);
		expect(typeof status).toBe("object");
		expect(typeof status!.configured).toBe("boolean");
		expect(status!.configured).toBe(false);
	});
});

describe("modelIsAvailable against the REAL pi SDK registry", () => {
	it("rejects a catalog model whose provider has no configured auth", async () => {
		const { registry } = await createRealRegistry();
		const model = pickUnconfiguredModel(registry);

		// Model exists in the real catalog...
		expect(registry.find(model.provider, model.id)).toBeDefined();
		// ...but the auth-aware check must report it as UNAVAILABLE
		expect(modelIsAvailable(registry, model)).toBe(false);
	});

	it("accepts the same model once the provider has configured auth", async () => {
		const { registry, runtime } = await createRealRegistry();
		const model = pickUnconfiguredModel(registry);

		await runtime.setRuntimeApiKey(model.provider, "contract-test-key");
		expect(registry.hasConfiguredAuth(registry.find(model.provider, model.id)!)).toBe(true);

		expect(modelIsAvailable(registry, model)).toBe(true);
	});
});
