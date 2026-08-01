/**
 * Tests for the auth-aware model availability check (issue #4).
 *
 * `modelIsAvailable` lives inside the extension's default-export closure in
 * src/index.ts, so it can't be imported directly. The implementation was
 * extracted into src/model-availability.ts (which index.ts delegates to) so
 * the check can be unit-tested with mocked registry shapes.
 *
 * Regression scenario: a preset model that EXISTS in the catalog but whose
 * provider has no configured auth must be treated as UNAVAILABLE — otherwise
 * the subagent spawns with `--model provider/id` and pi fails at spawn
 * ("No API key found") instead of falling back to the configured model.
 */

import { describe, it, expect } from "vitest";
import { modelIsAvailable, type ModelRegistryLike } from "../model-availability";

// Catalog model that exists but (per registry) has no provider auth
const catalogModel = { provider: "anthropic", id: "claude-opus-4-6" };

/** Registry with catalog lookup + hasConfiguredAuth (modern pi SDK shape). */
function registryWithAuth(authConfigured: boolean): ModelRegistryLike {
	return {
		find: (provider, modelId) =>
			provider === catalogModel.provider && modelId === catalogModel.id
				? { ...catalogModel }
				: undefined,
		hasConfiguredAuth: () => authConfigured,
	};
}

describe("modelIsAvailable — catalog + auth (hasConfiguredAuth path)", () => {
	it("accepts a catalog model whose provider has configured auth", () => {
		expect(modelIsAvailable(registryWithAuth(true), catalogModel)).toBe(true);
	});

	it("rejects a catalog model whose provider has NO auth (issue #4 regression)", () => {
		expect(modelIsAvailable(registryWithAuth(false), catalogModel)).toBe(false);
	});

	it("rejects a model that is not in the catalog, even with auth configured", () => {
		const registry = registryWithAuth(true);
		expect(modelIsAvailable(registry, { provider: "anthropic", id: "does-not-exist" })).toBe(false);
	});

	it("rejects unknown providers", () => {
		expect(modelIsAvailable(registryWithAuth(true), { provider: "nope", id: "x" })).toBe(false);
	});

	it("uses the catalog model object for the auth check (provider-level auth)", () => {
		let checked: { provider: string; id: string } | undefined;
		const registry: ModelRegistryLike = {
			find: () => ({ ...catalogModel }),
			hasConfiguredAuth: (model) => {
				checked = model;
				return true;
			},
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(true);
		expect(checked).toEqual(catalogModel);
	});
});

describe("modelIsAvailable — getProviderAuthStatus fallback", () => {
	it("accepts when AuthStatus.configured is true", () => {
		const registry: ModelRegistryLike = {
			find: () => ({ ...catalogModel }),
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(true);
	});

	it("rejects when AuthStatus.configured is false", () => {
		const registry: ModelRegistryLike = {
			find: () => ({ ...catalogModel }),
			getProviderAuthStatus: () => ({ configured: false }),
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(false);
	});

	it("rejects when AuthStatus is undefined", () => {
		const registry: ModelRegistryLike = {
			find: () => ({ ...catalogModel }),
			getProviderAuthStatus: () => undefined,
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(false);
	});

	it("prefers hasConfiguredAuth over getProviderAuthStatus when both exist", () => {
		const registry: ModelRegistryLike = {
			find: () => ({ ...catalogModel }),
			hasConfiguredAuth: () => false,
			getProviderAuthStatus: () => ({ configured: true }),
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(false);
	});
});

describe("modelIsAvailable — getAll() fallback and no-auth registries", () => {
	it("finds the model via getAll() when find() is missing", () => {
		const registry: ModelRegistryLike = {
			getAll: () => [{ provider: "openai", id: "gpt-5" }, { ...catalogModel }],
			hasConfiguredAuth: () => true,
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(true);
	});

	it("treats a getAll()-found model as unavailable when auth is missing", () => {
		const registry: ModelRegistryLike = {
			getAll: () => [{ ...catalogModel }],
			hasConfiguredAuth: () => false,
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(false);
	});

	it("trusts the catalog when the registry exposes no auth API (old behavior)", () => {
		const registry: ModelRegistryLike = {
			find: () => ({ ...catalogModel }),
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(true);
	});

	it("returns false for an empty registry", () => {
		expect(modelIsAvailable({}, catalogModel)).toBe(false);
		expect(modelIsAvailable(undefined, catalogModel)).toBe(false);
	});
});

describe("modelIsAvailable — robustness", () => {
	it("returns false when the registry throws", () => {
		const registry: ModelRegistryLike = {
			find: () => {
				throw new Error("boom");
			},
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(false);
	});

	it("returns false when hasConfiguredAuth throws", () => {
		const registry: ModelRegistryLike = {
			find: () => ({ ...catalogModel }),
			hasConfiguredAuth: () => {
				throw new Error("boom");
			},
		};
		expect(modelIsAvailable(registry, catalogModel)).toBe(false);
	});
});
