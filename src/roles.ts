/**
 * brl-subagent — RBAC (Role-Based Access Control) Matrices
 *
 * Defines built-in roles and their tool permissions.
 */

import type { SubagentToolOptions, SandboxLevel } from "./types";
import { SANDBOX_TOOLS, SANDBOX_EXCLUDE } from "./types";

// ---------------------------------------------------------------------------
// Role Definitions
// ---------------------------------------------------------------------------

export type RoleName = "reviewer" | "developer" | "auditor";

export const ROLE_DEFINITIONS: Record<RoleName, { tools: string[]; excludeTools?: string[] }> = {
	reviewer: {
		tools: ["read", "grep", "find", "ls"],
		excludeTools: ["write", "edit", "bash"],
	},
	developer: {
		tools: ["read", "grep", "find", "ls", "write", "edit", "bash"],
		excludeTools: undefined,
	},
	auditor: {
		tools: ["read", "grep", "find", "ls"],
		excludeTools: ["write", "edit", "bash"],
	},
};

export const DEFAULT_ROLE: RoleName = "developer";

// ---------------------------------------------------------------------------
// Role Tool Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the tool permissions for a given role.
 * If sandboxLevel is also set, the more restrictive of the two wins.
 * Uses the same override semantics as existing sandbox:
 * explicit params.tools/excludeTools override role defaults.
 */
export function resolveRoleTools(
	role: RoleName | string,
	sandboxLevel?: SandboxLevel,
): SubagentToolOptions {
	const roleDef = ROLE_DEFINITIONS[role as RoleName] ?? ROLE_DEFINITIONS[DEFAULT_ROLE];

	// Start with role tools
	let tools = [...roleDef.tools];
	let excludeTools = roleDef.excludeTools ? [...roleDef.excludeTools] : [];

	// Apply sandbox restrictions (more restrictive wins)
	if (sandboxLevel && sandboxLevel !== "none") {
		const sandboxTools = SANDBOX_TOOLS[sandboxLevel];
		const sandboxExclude = SANDBOX_EXCLUDE[sandboxLevel];

		if (sandboxTools) {
			// Intersect tools
			tools = tools.filter((t) => sandboxTools.includes(t));
		}

		if (sandboxExclude) {
			// Union exclusions
			const excludeSet = new Set([...excludeTools, ...sandboxExclude]);
			excludeTools = [...excludeSet];
		}
	}

	const result: SubagentToolOptions = {};

	if (tools.length > 0) {
		result.tools = tools;
	}

	if (excludeTools.length > 0) {
		result.excludeTools = excludeTools;
	}

	return result;
}
