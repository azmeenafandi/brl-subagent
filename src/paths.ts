/**
 * brl-subagent — Package-root path resolution
 *
 * The extension is loaded from `<pkg>/src/` (package.json `pi.extensions`
 * points at `./src/index.ts`), so every module in this package lives directly
 * in `src/` and the package root is exactly one level up. `pkgPath()` is the
 * single helper for resolving bundled assets against that root — the same base
 * used for `presets/`, `templates/`, `package.json`, and `AGENT.md`.
 */

import * as path from "node:path";

/**
 * Resolve `segments` against the package root.
 *
 * Because the extension loads from `<pkg>/src/`, the package root is one level
 * up from this module's directory. A wrong depth here would resolve inside
 * `src/` and fail to find the bundled asset.
 *
 * @param segments - Path segments below the package root (e.g. `"presets"`, `"AGENT.md"`)
 * @returns The absolute path to the bundled asset
 */
export function pkgPath(...segments: string[]): string {
	return path.join(__dirname, "..", ...segments);
}
