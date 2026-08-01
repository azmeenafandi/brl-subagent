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
 */

import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelIsAvailable } from "../model-availability";

/** Catalog model that exists in pi's builtin models. */
const CATALOG_MODEL = { provider: "anthropic", id: "claude-sonnet-4-5" };

async function createRealRegistry() {
	const authDir = await mkdtemp(join(tmpdir(), "brl-sdk-contract-"));
	const runtime = await ModelRuntime.create({
		modelsPath: null, // builtin catalog only — no user models.json, no network
		authPath: join(authDir, "auth.json"),
	});
	return { registry: new ModelRegistry(runtime), runtime };
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

		const model = registry.find(CATALOG_MODEL.provider, CATALOG_MODEL.id);
		expect(model).toBeDefined();
		expect(model!.provider).toBe(CATALOG_MODEL.provider);
		expect(model!.id).toBe(CATALOG_MODEL.id);

		// Unknown model -> undefined (same shape contract as ModelRegistryLike)
		expect(registry.find("anthropic", "no-such-model")).toBeUndefined();
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

		const model = registry.find(CATALOG_MODEL.provider, CATALOG_MODEL.id);
		expect(model).toBeDefined();
		// Fresh registry: no credentials configured for this provider
		expect(registry.hasConfiguredAuth(model!)).toBe(false);
	});

	it("getProviderAuthStatus(provider) returns { configured: boolean }", async () => {
		const { registry } = await createRealRegistry();

		const status = registry.getProviderAuthStatus(CATALOG_MODEL.provider);
		expect(typeof status).toBe("object");
		expect(typeof status!.configured).toBe("boolean");
		expect(status!.configured).toBe(false);
	});
});

describe("modelIsAvailable against the REAL pi SDK registry", () => {
	it("rejects a catalog model whose provider has no configured auth", async () => {
		const { registry } = await createRealRegistry();

		// Model exists in the real catalog...
		expect(registry.find(CATALOG_MODEL.provider, CATALOG_MODEL.id)).toBeDefined();
		// ...but the auth-aware check must report it as UNAVAILABLE
		expect(modelIsAvailable(registry, CATALOG_MODEL)).toBe(false);
	});

	it("accepts the same model once the provider has configured auth", async () => {
		const { registry, runtime } = await createRealRegistry();

		await runtime.setRuntimeApiKey(CATALOG_MODEL.provider, "contract-test-key");
		expect(registry.hasConfiguredAuth(registry.find(CATALOG_MODEL.provider, CATALOG_MODEL.id)!)).toBe(true);

		expect(modelIsAvailable(registry, CATALOG_MODEL)).toBe(true);
	});
});
