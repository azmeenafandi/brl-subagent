#!/usr/bin/env node
// Purpose: The bash-only interface to the private scratch root (issue #512) — `path`, `init`, `check`,
// `create`, `append`, each with `--json`.
//
// A review preset has `bash` and no `write`/`edit` tool, so the record and the findings bank have to
// be writable from a shell. That is what this CLI is: the same primitives as
// `scripts/lib/scratch-root.mjs`, with a named refusal on stderr and an exit code instead of a
// returned object. There is no second implementation — every command calls the library.
//
//   node scripts/scratch-root.mjs path                  # resolve + validate the root, print it
//   node scripts/scratch-root.mjs init                  # create the chain at 0700, then validate
//   node scripts/scratch-root.mjs check [path]          # validate a root candidate (default: the root)
//   node scripts/scratch-root.mjs append review-512/findings.md   # append stdin (the findings bank)
//   node scripts/scratch-root.mjs create review-512/note.md       # create exclusively; stdin
//
// `<file>` is relative to the root or absolute at/below it; `create`/`append` ensure the root and the
// parent directory exist (mode 0700), which is the same shape `review-record.mjs` uses for
// `<root>/review-<pr>/`. A path outside the root is refused `outside-root` — there is no
// unconfined write here, and no fallback to a system temp directory.
//
// Exit: 0 ok · 1 a named refusal (the code is in the message) · 2 usage. `--json` prints one object
// on every exit, so a caller never has to parse prose.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	appendBytes,
	confine,
	createExclusive,
	defaultRoot,
	ensureDir,
	ensureRoot,
	validateRoot,
} from "./lib/scratch-root.mjs";

export const EXIT = Object.freeze({ OK: 0, REFUSED: 1, USAGE: 2 });

export const USAGE = `usage: scratch-root.mjs [--root <path>] [--json] <command> [args]

  path              resolve and validate the scratch root, and print it
  init              create the root chain (mode 0700) and validate it
  check [path]      validate <path> (default: the root) as a scratch root
  create <file>     create <file> exclusively; the bytes come from stdin
  append <file>     append stdin to <file>, creating it if it is missing

  <file> is relative to the root, or absolute at or below it.
  exit 0 ok · 1 a named refusal · 2 usage`;

/** The commands, with the positional arity each one accepts. One table, no second list to drift. */
export const COMMANDS = Object.freeze({
	path: { min: 0, max: 0 },
	init: { min: 0, max: 0 },
	check: { min: 0, max: 1 },
	create: { min: 1, max: 1 },
	append: { min: 1, max: 1 },
});

/** `{ ok: true, command, root, positional, json }` or `{ ok: false, message }` — never throws. */
export function parseArgs(argv) {
	const parsed = { command: "", root: defaultRoot(), json: false, positional: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--json") {
			parsed.json = true;
			continue;
		}
		if (argument === "--root") {
			const value = argv[index + 1];
			if (value === undefined) return { ok: false, message: "--root needs a path" };
			parsed.root = value;
			index += 1;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			return { ok: false, message: "", help: true };
		}
		if (argument.startsWith("--")) return { ok: false, message: `unknown argument: ${argument}` };
		if (parsed.command === "") {
			parsed.command = argument;
			continue;
		}
		parsed.positional.push(argument);
	}
	if (parsed.command === "") return { ok: false, message: "missing a command" };
	const arity = COMMANDS[parsed.command];
	if (arity === undefined) return { ok: false, message: `unknown command: ${parsed.command}` };
	if (parsed.positional.length < arity.min || parsed.positional.length > arity.max) {
		return { ok: false, message: `${parsed.command} takes ${arity.min === arity.max ? `${arity.min}` : `${arity.min}-${arity.max}`} path argument(s)` };
	}
	return { ok: true, ...parsed };
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/** One result, three renderings (json / refusal / success): the shapes cannot drift from each other. */
function emit(result, { json, out, err }) {
	if (json) {
		out(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.ok) {
		out(`scratch-root: ${result.line}\n`);
	} else {
		err(`scratch-root: refused (${result.code}): ${result.message}`);
	}
	return result.ok ? EXIT.OK : EXIT.REFUSED;
}

/**
 * Run one command. Returns the exit code; stdout / stderr / stdin go through `out` / `err` /
 * `readStdin`, which is what lets the tests drive every path in-process.
 */
export function main(argv = process.argv.slice(2), io = {}) {
	const {
		out = (chunk) => process.stdout.write(chunk),
		err = (line) => process.stderr.write(`${line}\n`),
		readStdin = () => readFileSync(0, "utf8"),
	} = io;
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		if (!parsed.help) err(`scratch-root: ${USAGE}\n${parsed.message}`);
		else out(`${USAGE}\n`);
		return parsed.help ? EXIT.OK : EXIT.USAGE;
	}
	const { command, root, json, positional } = parsed;
	const render = (result) => emit(result, { json, out, err });

	if (command === "path" || command === "init") {
		const result = command === "path" ? validateRoot(root) : ensureRoot(root);
		return render(result.ok ? { ok: true, command, root: result.root, line: result.root } : { ok: false, command, root, ...result });
	}

	if (command === "check") {
		const target = positional.length === 1 ? positional[0] : root;
		const result = validateRoot(target);
		return render(
			result.ok
				? { ok: true, command, root, checked: result.root, line: `${result.root} is a valid scratch root` }
				: { ok: false, command, root, checked: target, ...result },
		);
	}

	// create / append: the bytes are read BEFORE the root is touched, so a failure to read stdin
	// cannot leave a root created for a write that will not happen.
	let data;
	try {
		data = readStdin();
	} catch (error) {
		err(`scratch-root: cannot read stdin (${describe(error)})`);
		return EXIT.USAGE;
	}
	const rootCheck = ensureRoot(root);
	if (!rootCheck.ok) return render({ ok: false, command, root, ...rootCheck });
	const target = positional[0];
	const confined = confine(rootCheck.root, target);
	if (!confined.ok) return render({ ok: false, command, root: rootCheck.root, path: target, ...confined });
	const dirCheck = ensureDir(dirname(confined.path), { root: rootCheck.root });
	if (!dirCheck.ok) return render({ ok: false, command, root: rootCheck.root, path: target, ...dirCheck });
	const result =
		command === "create"
			? createExclusive(target, data, { root: rootCheck.root })
			: appendBytes(target, data, { root: rootCheck.root });
	return render(
		result.ok
			? {
					ok: true,
					command,
					root: rootCheck.root,
					path: result.path,
					bytes: result.bytes,
					line: `${command === "create" ? "created" : "appended to"} ${result.path} (${result.bytes} bytes)`,
				}
			: { ok: false, command, root: rootCheck.root, path: target, ...result },
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
