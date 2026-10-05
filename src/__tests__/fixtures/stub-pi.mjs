#!/usr/bin/env node
/**
 * Tier-2 e2e fixture: a deterministic, model-free stand-in for the real `pi`
 * binary (issue #271).
 *
 * The Tier-2 harness (e2e-subprocess.test.ts) spawns a synthetic node process
 * that loads the extension via jiti. That process is NOT pi, so its argv[1] is
 * the harness script — without an explicit override the runner would "spawn
 * pi" by re-running the harness (and the tests would pass without ever
 * exercising delegation). The harness sets BRL_PI_BIN to this file's path, so
 * runSubagent (and preflight's checkPiBinary) invoke THIS script instead.
 *
 * Protocol: emit the JSON-line events `parseSubagentLine` consumes — one
 * assistant `message_end` carrying the final text. Keep stdout pure protocol;
 * diagnostics go to stderr.
 *
 * Side channel: append start/end invocation records to
 * `<cwd>/stub-pi-invocations.jsonl`. The runner spawns subagents with `cwd` =
 * the harness's TMP_SCRIPT_DIR, so the harness reads the same path. The log
 * path is deliberately NOT passed via env: `getSafeEnv` (F2) is an allowlist,
 * so BRL_* vars set by the harness never reach the child — the same isolation
 * that stops BRL_PI_BIN from leaking (issue #271).
 *
 * Delay: the task text may carry a `[delay=NNN]` token to force a
 * deterministic overlap between concurrent invocations (parallel mode), e.g.
 * "Say hello [delay=700]". Defaults to 150ms.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

// The runner passes the (fenced) task as the final argument; unwrap it.
const lastArg = args.length > 0 ? args[args.length - 1] : "";
const fence = lastArg.match(/^<task>\n([\s\S]*)\n<\/task>$/);
const task = fence ? fence[1] : lastArg;

const delayMatch = task.match(/\[delay=(\d+)\]/);
const delayMs = delayMatch ? Number(delayMatch[1]) : 150;

const logPath = join(process.cwd(), "stub-pi-invocations.jsonl");

function record(event) {
	try {
		appendFileSync(
			logPath,
			JSON.stringify({ event, pid: process.pid, at: Date.now(), task }) + "\n",
			"utf8",
		);
	} catch (err) {
		process.stderr.write(`stub-pi: log write failed: ${err.message}\n`);
	}
}

record("start");
await new Promise((resolve) => setTimeout(resolve, delayMs));

const response = `stub-pi: ${task}`;
process.stdout.write(
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			model: "stub/stub-model",
			stopReason: "stop",
			usage: { input: 1, output: 1, totalTokens: 2 },
			content: [{ type: "text", text: response }],
		},
	}) + "\n",
);

record("end");
