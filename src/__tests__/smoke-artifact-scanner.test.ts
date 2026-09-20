import { describe, expect, it } from "vitest";

import { classifyRuntimeSpecifiers, collectRuntimeSpecifiers } from "../../.github/scripts/smoke-artifact.mjs";

// ---------------------------------------------------------------------------
// Issue #176 review: the packaging smoke test's import scanner decides which
// runtime specifiers the "every runtime import is a declared dependency" gate
// enforces. Nothing pinned that classification, so an edit could silently
// weaken the gate (e.g. by dropping a recognised form) with no test going red.
//
// `collectRuntimeSpecifiers` is the AST classifier — which import forms are
// runtime. `classifyRuntimeSpecifiers` is the dependency classifier the gate
// actually applies: it drops relative / builtin / subpath specifiers and
// reduces each remaining specifier to its package name.
//
// The negative direction matters as much as the positive one: a regression in
// the type-only exclusions would make the gate fail spuriously on correct code.
// ---------------------------------------------------------------------------

const scan = (source: string): string[] => collectRuntimeSpecifiers("fixture.ts", source);

const deps = (source: string): string[] =>
	classifyRuntimeSpecifiers("fixture.ts", source).map((entry) => entry.packageName);

describe("collectRuntimeSpecifiers — runtime import forms", () => {
	it("collects a default import", () => {
		expect(scan(`import def from "pkg-default";`)).toEqual(["pkg-default"]);
	});

	it("collects a named import", () => {
		expect(scan(`import { a, b } from "pkg-named";`)).toEqual(["pkg-named"]);
	});

	it("collects a namespace import", () => {
		expect(scan(`import * as ns from "pkg-ns";`)).toEqual(["pkg-ns"]);
	});

	it("collects a side-effect import", () => {
		expect(scan(`import "pkg-side-effect";`)).toEqual(["pkg-side-effect"]);
	});

	it("collects a bare `import {}`", () => {
		expect(scan(`import {} from "pkg-empty";`)).toEqual(["pkg-empty"]);
	});

	it("collects a dynamic import() expression", () => {
		expect(scan(`const mod = await import("pkg-dynamic");`)).toEqual(["pkg-dynamic"]);
	});

	it("collects a CommonJS require() call", () => {
		expect(scan(`const cjs = require("pkg-require");`)).toEqual(["pkg-require"]);
	});

	it("collects an `import = require()` declaration", () => {
		expect(scan(`import legacy = require("pkg-import-equals");`)).toEqual(["pkg-import-equals"]);
	});

	it("collects each runtime form exactly once when combined", () => {
		const source = [
			`import def from "pkg-default";`,
			`import { a } from "pkg-named";`,
			`import * as ns from "pkg-ns";`,
			`import "pkg-side-effect";`,
			`const dyn = await import("pkg-dynamic");`,
			`const cjs = require("pkg-require");`,
			`import legacy = require("pkg-import-equals");`,
		].join("\n");
		expect(scan(source)).toEqual([
			"pkg-default",
			"pkg-named",
			"pkg-ns",
			"pkg-side-effect",
			"pkg-dynamic",
			"pkg-require",
			"pkg-import-equals",
		]);
	});
});

describe("collectRuntimeSpecifiers — re-exports", () => {
	it("collects `export { … } from`", () => {
		expect(scan(`export { a } from "pkg-reexport";`)).toEqual(["pkg-reexport"]);
	});

	it("collects `export * from`", () => {
		expect(scan(`export * from "pkg-star";`)).toEqual(["pkg-star"]);
	});

	it("collects `export * as ns from`", () => {
		expect(scan(`export * as ns from "pkg-star-ns";`)).toEqual(["pkg-star-ns"]);
	});
});

describe("collectRuntimeSpecifiers — type-only forms impose no runtime dependency", () => {
	it("ignores `import type { … }`", () => {
		expect(scan(`import type { T } from "types-only";`)).toEqual([]);
	});

	it("ignores `import type Default from …`", () => {
		expect(scan(`import type Default from "types-only";`)).toEqual([]);
	});

	it("ignores `import type * as ns from …`", () => {
		expect(scan(`import type * as ns from "types-only";`)).toEqual([]);
	});

	it("ignores a fully inline type-only named import", () => {
		expect(scan(`import { type T } from "types-only";`)).toEqual([]);
	});

	it("keeps a mixed inline import (value + type specifier)", () => {
		expect(scan(`import { type T, value } from "pkg-mixed";`)).toEqual(["pkg-mixed"]);
	});

	it("ignores `export type { … } from …`", () => {
		expect(scan(`export type { T } from "types-only";`)).toEqual([]);
	});

	it("ignores a fully inline type-only re-export", () => {
		expect(scan(`export { type T } from "types-only";`)).toEqual([]);
	});

	it("ignores `import type x = require(…)`", () => {
		expect(scan(`import type legacy = require("types-only");`)).toEqual([]);
	});
});

describe("classifyRuntimeSpecifiers — dependency classification", () => {
	it("keeps a sub-path specifier as its package", () => {
		expect(deps(`import x from "pkg/sub";`)).toEqual(["pkg"]);
	});

	it("keeps a scoped package intact", () => {
		expect(deps(`import x from "@scope/name";`)).toEqual(["@scope/name"]);
	});

	it("reduces a scoped sub-path specifier to the scoped package", () => {
		expect(deps(`import x from "@scope/name/sub/deep";`)).toEqual(["@scope/name"]);
	});

	it("ignores relative specifiers (they resolve inside the package)", () => {
		expect(deps(`import "./relative"; import "../parent"; import "/absolute";`)).toEqual([]);
	});

	it("ignores node: builtins", () => {
		expect(deps(`import { readFileSync } from "node:fs";`)).toEqual([]);
	});

	it("ignores bare builtins", () => {
		expect(deps(`const path = require("path");`)).toEqual([]);
	});

	it("ignores package subpath imports (#internal)", () => {
		expect(deps(`import x from "#internal";`)).toEqual([]);
	});

	it("classifies require() and import = require() as dependencies", () => {
		expect(deps(`const a = require("pkg-a"); import b = require("pkg-b");`)).toEqual(["pkg-a", "pkg-b"]);
	});
});
