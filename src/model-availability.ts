// Purpose: Model identity + auth-aware availability: parse a provider/model-id string and check catalog presence plus configured provider auth.
/**
 * Auth-aware model availability check (issue #4).
 *
 * A model may exist in pi's CATALOG (built-in model list) while its provider
 * has no configured credentials (no API key / OAuth). Spawning a subagent with
 * such a model fails at spawn time ("No API key found") instead of triggering
 * the preset-model fallback. This module checks BOTH catalog presence AND
 * provider auth configuration before a model is considered available.
 *
 * Structural subset of the pi SDK `ModelRegistry` (see
 * @earendil-works/pi-coding-agent/dist/core/model-registry.d.ts):
 *   - find(provider, modelId): Model | undefined
 *   - getAll(): Model[]
 *   - hasConfiguredAuth(model): boolean
 *   - getProviderAuthStatus(provider): AuthStatus   // { configured: boolean; ... }
 *
 * Kept free of pi runtime imports so it can be unit-tested in isolation.
 */

export interface ModelLike {
	provider: string;
	id: string;
}

/**
 * Parse a `provider/model-id` string. Returns null on anything that is not
 * exactly one non-empty provider and one non-empty id (no provider-only or
 * trailing-slash values).
 */
export function parseModelString(s: string): { provider: string; id: string } | null {
	const trimmed = s.trim();
	const idx = trimmed.indexOf("/");
	if (idx <= 0 || idx === trimmed.length - 1) return null;
	return { provider: trimmed.slice(0, idx), id: trimmed.slice(idx + 1) };
}

export interface ProviderAuthStatusLike {
	configured?: boolean;
	source?: string;
	label?: string;
}

export interface ModelRegistryLike {
	find?(provider: string, modelId: string): ModelLike | undefined;
	getAll?(): ModelLike[];
	hasConfiguredAuth?(model: ModelLike): boolean;
	getProviderAuthStatus?(provider: string): ProviderAuthStatusLike | undefined;
}

/**
 * Check that provider/model exists in the catalog AND that the provider has
 * configured auth. Falls back to catalog-only presence when the registry
 * exposes no auth API (old behavior).
 */
export function modelIsAvailable(
	registry: ModelRegistryLike | undefined,
	m: { provider: string; id: string },
): boolean {
	try {
		// Find the model in the catalog
		let model: ModelLike | undefined;
		if (registry?.find) {
			model = registry.find(m.provider, m.id);
		}
		if (!model) {
			const models = registry?.getAll?.() ?? [];
			model = models.find((x) => x.provider === m.provider && x.id === m.id);
		}
		if (!model) return false;

		// Auth-aware check: model exists in catalog BUT provider must have configured auth
		if (typeof registry?.hasConfiguredAuth === "function") {
			return registry.hasConfiguredAuth(model);
		}
		// Fallback: getProviderAuthStatus (AuthStatus = { configured: boolean; ... })
		if (typeof registry?.getProviderAuthStatus === "function") {
			const status = registry.getProviderAuthStatus(m.provider);
			return status?.configured === true;
		}
		// No auth API — trust the catalog (old behavior)
		return true;
	} catch {
		return false;
	}
}
