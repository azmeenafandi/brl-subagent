/**
 * Issue #449 — a settled background run with no assistant output is not a success.
 *
 * A MINIMAL REPRODUCTION, not a suite test: it drives the REAL pi 1.5.0 SDK
 * (real `AgentSession`, real anthropic-messages wire code, real HTTP/SSE) and the
 * REAL `spawnBackgroundSession` against a LOOPBACK fake provider. No vendor
 * endpoint is contacted and no paid inference happens.
 *
 * It lives here — outside `src/__tests__` — on purpose: it is evidence for the
 * investigation, not a contract the suite carries on every run.
 *
 * ISOLATION IS LOAD-BEARING. `env -i` and `PI_OFFLINE=1` are NOT sufficient on
 * their own: `env -i … node -p 'os.homedir()'` still prints the real home, the
 * SDK derives its config/auth paths from it, and `PI_OFFLINE` only disables
 * *startup* network operations. The invocation must therefore set a scratch
 * `HOME`, a scratch `PI_CODING_AGENT_DIR`, and a loopback-only provider base URL
 * — see ./README.md. This file refuses to run otherwise (the guard below).
 *
 * OBSERVED CRITERION (each assertion is one half of it):
 *   1. the SDK emits `message_end` with `stopReason: "length"` for that turn,
 *      `prompt()` RESOLVES, and the projected `session.messages` holds ZERO
 *      assistant messages — the omission the defect rides on;
 *   2. the production settle then persists `failed` / `incomplete`, with
 *      `exitCode 1` on the agent record and NO `done` run entry.
 * A script that merely exits 0 proves nothing.
 */
import { expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { __setStorageDir, getAgent, spawnBackgroundSession } from "../../../../src/session-manager";

const SCRATCH = process.env.BRL449_SCRATCH ? resolve(process.env.BRL449_SCRATCH) : "";
const HOME_DIR = join(SCRATCH, "home");
const AGENT_DIR = join(SCRATCH, "agent");
const CWD = join(SCRATCH, "cwd");
const STORE = join(SCRATCH, "store");

/**
 * Isolation guard. Fails closed and LOUD instead of quietly reading the real
 * home/agent dir — the falsifier is "the repro can reach real auth".
 */
function requireScratchEnv(): void {
	if (!SCRATCH) throw new Error("BRL449_SCRATCH is not set — see the invocation in README.md");
	if (resolve(homedir()) !== HOME_DIR) {
		throw new Error(`HOME is not the scratch home (${homedir()}) — refusing to run; see README.md`);
	}
	if (resolve(getAgentDir()) !== AGENT_DIR) {
		throw new Error(`PI_CODING_AGENT_DIR is not the scratch agent dir (${getAgentDir()}) — see README.md`);
	}
	for (const dir of [HOME_DIR, AGENT_DIR, CWD, STORE]) mkdirSync(dir, { recursive: true });
}

/** Anthropic-messages SSE frames for one truncated turn (`max_tokens`). */
function sse(res: http.ServerResponse, events: Array<[string, unknown]>): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
	res.end();
}

const messageStart = (): [string, unknown] => [
	"message_start",
	{
		type: "message_start",
		message: {
			id: "msg_449",
			type: "message",
			role: "assistant",
			model: "probe-model",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 7, output_tokens: 1 },
		},
	},
];

/**
 * `stop_reason: max_tokens` at 32 output tokens — far below the catalog's
 * `maxTokens` → `isRecoverableLength` → the SDK omits the message.
 */
const truncatedTurn = (): Array<[string, unknown]> => [
	messageStart(),
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "truncated" } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	[
		"message_delta",
		{
			type: "message_delta",
			delta: { stop_reason: "max_tokens", stop_sequence: null },
			usage: { output_tokens: 32 },
		},
	],
	["message_stop", { type: "message_stop" }],
];

/** Start the loopback provider and point the scratch agent dir's models.json at it. */
async function startProvider(): Promise<{ close: () => Promise<void>; hits: string[] }> {
	const hits: string[] = [];
	const server = http.createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			hits.push(`${req.method} ${req.url}`);
			sse(res, truncatedTurn());
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	writeFileSync(
		join(AGENT_DIR, "models.json"),
		// Loopback only: the SDK's own client performs the fetch, but it can only
		// ever reach 127.0.0.1 here. The key is fake by construction.
		JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "sk-probe-not-real" } } }),
	);
	writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({}));
	// The omission is gated on the SDK's compaction setting — pin it explicitly.
	writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
	return { hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

it("1. the SDK emits message_end:length, resolves, and projects zero assistants", async () => {
	requireScratchEnv();
	const provider = await startProvider();
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(AGENT_DIR, "auth.json"),
			modelsPath: join(AGENT_DIR, "models.json"),
		});
		const model = runtime
			.getModels()
			.find((m) => m.provider === "anthropic" && (m as { api?: string }).api === "anthropic-messages");
		const settings = SettingsManager.create(CWD, AGENT_DIR);
		settings.setCompactionEnabled(true);
		const { session } = await createAgentSession({
			cwd: CWD,
			agentDir: AGENT_DIR,
			sessionManager: SessionManager.inMemory(CWD),
			settingsManager: settings,
			modelRuntime: runtime as never,
			model: model as never,
			thinkingLevel: "off",
		});

		const messageEnds: Array<{ role: string; stopReason?: string }> = [];
		session.subscribe((event) => {
			const e = event as { type: string; message?: { role?: string; stopReason?: string } };
			if (e.type === "message_end" && e.message?.role === "assistant") {
				messageEnds.push({ role: "assistant", stopReason: e.message.stopReason });
			}
		});

		let settled = "pending";
		await session.prompt("probe task").then(
			() => (settled = "resolved"),
			() => (settled = "rejected"),
		);
		await new Promise((r) => setTimeout(r, 100));

		const projected = session.messages as Array<{ role: string }>;
		const assistantCount = projected.filter((m) => m.role === "assistant").length;
		console.log(
			`\nOBSERVED ${JSON.stringify({ settled, messageEnds, providerHits: provider.hits.length, assistantCount, roles: projected.map((m) => m.role) })}`,
		);

		expect(provider.hits.length).toBe(1); // one loopback request, no vendor call
		expect(settled).toBe("resolved");
		expect(messageEnds).toEqual([{ role: "assistant", stopReason: "length" }]);
		expect(assistantCount).toBe(0);
	} finally {
		await provider.close();
	}
});

it("2. the production settle persists failed/incomplete, not a success", async () => {
	requireScratchEnv();
	const provider = await startProvider();
	try {
		__setStorageDir(STORE);
		const runtime = await ModelRuntime.create({
			authPath: join(AGENT_DIR, "auth.json"),
			modelsPath: join(AGENT_DIR, "models.json"),
		});
		const model = runtime
			.getModels()
			.find((m) => m.provider === "anthropic" && (m as { api?: string }).api === "anthropic-messages");
		if (!model) throw new Error("no anthropic-messages model resolved from the loopback provider");

		const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
		const pi = { appendEntry: (type: string, data: Record<string, unknown>) => entries.push({ type, data }) };
		const ctx = {
			cwd: CWD,
			modelRegistry: {
				find: (providerId: string, id: string) => (providerId === model.provider && id === model.id ? model : undefined),
			},
		};

		const agent = await spawnBackgroundSession(pi as never, ctx as never, {
			task: "probe: produce an answer",
			model: `${model.provider}/${model.id}`,
			thinkingLevel: "off",
			gitMode: "none",
			timeout: 45000,
		});

		const deadline = Date.now() + 40000;
		while (Date.now() < deadline && !agent.completedAt) await new Promise((r) => setTimeout(r, 25));
		await new Promise((r) => setTimeout(r, 150));

		const runs = entries.filter((e) => String(e.type).includes("run")).map((e) => e.data);
		const last = runs[runs.length - 1];
		const record = {
			agentStatus: agent.status,
			exitCode: agent.result?.exitCode,
			usageTurns: agent.result?.usage?.turns,
			runStatus: last?.status,
			runStatuses: runs.map((r) => r.status),
			runErrorCategory: last?.errorCategory,
			runErrorMessage: last?.errorMessage,
			persistedStatus: getAgent(agent.id)?.status,
		};
		console.log(`\nRECORD ${JSON.stringify(record, null, 2)}`);

		expect(agent.status).toBe("failed");
		expect(agent.result?.exitCode).toBe(1);
		expect(agent.error).toContain("Run settled with no assistant output");
		expect(getAgent(agent.id)?.status).toBe("failed");
		expect(last?.status).toBe("failed");
		expect(last?.errorCategory).toBe("incomplete");
		expect(runs.map((r) => r.status)).toEqual(["running", "failed"]); // no `done` entry
	} finally {
		await provider.close();
	}
});
