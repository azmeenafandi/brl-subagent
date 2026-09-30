#!/usr/bin/env node
/**
 * Regression tests for the worktree-guard install heuristic (issue #215).
 *
 * Run from the cockpit checkout (dev):  node .pi/extensions/worktree-guard/guard.test.cjs
 *
 * The guard is a pi extension; its pure helpers are exported for this script.
 * jiti loads the TypeScript without a build step (the same mechanism the e2e
 * suite uses for the extension).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const jiti = require("jiti")(__filename);
const guard = jiti("./index.ts");
const { isInstallCommand, blockReason } = guard;

let failures = 0;
function check(name, actual, expected) {
	if (Object.is(actual, expected)) {
		console.log(`ok   ${name}`);
	} else {
		failures += 1;
		console.log(`FAIL ${name}\n       expected: ${expected}\n       actual:   ${actual}`);
	}
}

console.log("-- install detection: command position only (the #215 false positive)");
check(
	"echo banner containing 'npm install' is NOT an install",
	isInstallCommand('echo "=== 1. remove npm install ===" && pi remove npm:brl-subagent'),
	false,
);
check("quoted words inside a larger command are NOT an install", isInstallCommand('echo "run npm ci later"'), false);
check("plain npm ci IS an install", isInstallCommand("npm ci"), true);
check("npm install after && IS an install", isInstallCommand("cd ../somewhere && npm install"), true);
check("npm i after ; IS an install", isInstallCommand("true; npm i"), true);
check("env-prefixed install IS an install", isInstallCommand("CI=1 npm install"), true);
check("sudo-prefixed install IS an install", isInstallCommand("sudo npm ci"), true);
check("pnpm add IS an install", isInstallCommand("pnpm add -D typebox"), true);
check("npm run build is NOT an install", isInstallCommand("npm run build"), false);
check("npm test is NOT an install", isInstallCommand("npm test"), false);
check("documented gap: install inside an exec-string is not matched", isInstallCommand('bash -c "npm ci"'), false);

console.log("-- advice: shared-tree staleness vs an isolated worktree");
const cockpit = process.cwd();
const sharedFixture = fs.mkdtempSync(path.join(os.tmpdir(), "guard-shared-"));
fs.symlinkSync(path.join(cockpit, "node_modules"), path.join(sharedFixture, "node_modules"));
check(
	"symlink into the cockpit's shared tree gets the check-repo advice",
	/check-repo\.sh/.test(blockReason("shared-fixture", sharedFixture)),
	true,
);
const foreignFixture = fs.mkdtempSync(path.join(os.tmpdir(), "guard-foreign-"));
fs.symlinkSync(path.join(os.tmpdir(), "guard-nonexistent-target"), path.join(foreignFixture, "node_modules"));
check(
	"a foreign symlink keeps the --force-isolated advice",
	/--force-isolated/.test(blockReason("foreign-fixture", foreignFixture)),
	true,
);
fs.rmSync(sharedFixture, { recursive: true, force: true });
fs.rmSync(foreignFixture, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll guard checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
