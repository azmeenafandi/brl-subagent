// Purpose: Ratchet tool schemas to JSON-Schema-compatible TypeBox — pi 1.5.0 validates with pi-schema.
/**
 * pi 1.5.0's breaking change: tool arguments validate on `@earendil-works/pi-schema` instead of
 * TypeBox. TypeBox features outside JSON Schema — `Type.Refine()`, `Type.BigInt()`,
 * `Type.Undefined()`, codecs, `Format.Set()` — **no longer apply** to tool arguments
 * (docs/extensions.md#tool-parameter-schemas-and-typebox). The failure is silent: the schema
 * still compiles, the argument just stops being validated.
 *
 * Our tool schema (`src/schema.ts`) uses only JSON-Schema-compatible constructs today
 * (Object/Optional/String/Number/Boolean/Array/Literal/Record/Union). This ratchet keeps a
 * future edit from introducing one of the ignored constructs, which no other gate would catch.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The constructs pi-schema ignores; kept byte-aligned with the 1.5.0 docs list. */
const FORBIDDEN = /\bType\.(Refine|BigInt|Undefined|Codec|Transform)\b|\bFormat\.Set\b/;

const SRC = join(process.cwd(), "src");
const productionSources = readdirSync(SRC)
	.filter((file) => file.endsWith(".ts"))
	.map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));

describe("tool schemas stay JSON-Schema-compatible (pi 1.5.0 pi-schema validation)", () => {
	it("no production module uses a TypeBox feature pi-schema ignores", () => {
		const offenders = productionSources
			.filter((source) => FORBIDDEN.test(source.text))
			.map((source) => source.file);
		expect(offenders).toEqual([]);
	});

	it("the scan is not vacuous: src/schema.ts still builds tool parameters with Type", () => {
		const schema = productionSources.find((source) => source.file === "schema.ts");
		expect(schema, "src/schema.ts must exist").toBeDefined();
		expect(schema?.text).toMatch(/\bType\.Object\b/);
		expect(schema?.text).toMatch(/\bType\.Optional\b/);
	});
});
