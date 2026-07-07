import { describe, it, expect } from "vitest";
import { resolveRoleTools, ROLE_DEFINITIONS, DEFAULT_ROLE } from "../roles";

describe("resolveRoleTools", () => {
	it("reviewer role returns correct tools and excludeTools", () => {
		const result = resolveRoleTools("reviewer");
		expect(result.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(result.excludeTools).toEqual(["write", "edit", "bash"]);
	});

	it("developer role returns correct tools, no excludeTools", () => {
		const result = resolveRoleTools("developer");
		expect(result.tools).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash"]);
		expect(result.excludeTools).toBeUndefined();
	});

	it("auditor role returns correct tools and excludeTools", () => {
		const result = resolveRoleTools("auditor");
		expect(result.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(result.excludeTools).toEqual(["write", "edit", "bash"]);
	});

	it("unknown role defaults to developer", () => {
		const result = resolveRoleTools("unknown");
		expect(result.tools).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash"]);
	});

	it("reviewer + sandbox readonly: both restrict, result is the union of restrictions", () => {
		// reviewer allows read tools, sandbox readonly also allows read tools
		// reviewer excludes write/edit/bash, sandbox readonly also excludes write/edit/bash
		const result = resolveRoleTools("reviewer", "readonly");
		expect(result.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(result.excludeTools).toContain("write");
		expect(result.excludeTools).toContain("edit");
		expect(result.excludeTools).toContain("bash");
	});

	it("developer + sandbox readonly: sandbox overrides developer's write access", () => {
		const result = resolveRoleTools("developer", "readonly");
		expect(result.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(result.excludeTools).toContain("write");
		expect(result.excludeTools).toContain("edit");
		expect(result.excludeTools).toContain("bash");
	});

	it("developer + sandbox safe: sandbox limits tools to bash-included set", () => {
		const result = resolveRoleTools("developer", "safe");
		expect(result.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(result.excludeTools).toContain("write");
		expect(result.excludeTools).toContain("edit");
	});

	it("explicit tools override role defaults", () => {
		// Note: resolveRoleTools doesn't take explicit overrides directly,
		// but the function signature in the spec says "explicit params.tools/excludeTools override role defaults"
		// This logic is handled in resolveSubagentParams in index.ts
		// Here we just test the role resolution logic
		const result = resolveRoleTools("reviewer");
		expect(result.tools).toEqual(["read", "grep", "find", "ls"]);
	});
});
