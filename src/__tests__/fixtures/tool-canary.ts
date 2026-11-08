/**
 * Shared canary harness for the #442 real-child proofs.
 *
 * Three pieces, all throwaway and loopback-only:
 *   - a scripted OpenAI-compatible provider on `127.0.0.1` that forces tool
 *     calls (built-in, extension, and all three MCP exposure routes) before
 *     answering "done", and records which tools each request DECLARED;
 *   - a scratch `HOME` carrying a direct extension tool, three stdio MCP
 *     servers (direct / codemode / deferred) and a `models.json` pointing at
 *     that provider with a literal dummy key;
 *   - a canary log, so "initialised" and "executed" are separately observable.
 *
 * No real network, no real credentials, no real MCP server, no `/reload`.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

export interface CapturedRequest {
	/** Tool names pi DECLARED to the model in this request. */
	tools: string[];
	/** True when the request carried a `tools` key at all. */
	hasToolsKey: boolean;
	/** The task marker this request belongs to (see `TASK_MARKER_PREFIX`). */
	marker: string;
}

/**
 * The forced calls per turn. Turn 3+ answers "done", so a scripted run is at
 * most three model turns and still exercises the deferred route (which needs a
 * `tool_search` turn before the tool can be declared).
 */
const FORCED_CALLS: Record<number, Array<{ name: string; args: Record<string, unknown> }>> = {
	1: [
		// A forced BUILT-IN tool.
		{ name: "bash", args: { command: "echo builtin-canary > builtin-canary.txt" } },
		// A forced EXTENSION tool.
		{ name: "extension_canary", args: {} },
		// A forced DIRECT-exposure MCP tool.
		{ name: "mcp__canary_direct__canary", args: {} },
		// A forced CODEMODE route to a codemode-exposure MCP tool.
		{ name: "codemode", args: { code: "return await tools.mcp__canary_codemode__canary({})" } },
		// The normal route that can DECLARE a deferred tool.
		{ name: "tool_search", args: { query: "canary" } },
	],
	2: [
		// After tool_search, a forced DEFERRED-exposure MCP tool.
		{ name: "mcp__canary_deferred__canary", args: {} },
	],
};

/**
 * Each run's task carries this prefix plus a unique marker, so concurrent or
 * sequential runs in one file each get their own turn counter (a global counter
 * would hand "done" to the second run's first turn and silently kill the
 * canary forcing).
 */
export const TASK_MARKER_PREFIX = "canary-marker:";

/** Turn number for this request, derived from the run's own transcript. */
function turnOf(body: { messages?: Array<{ role?: string }> }): { marker: string; turn: number } {
	const messages = body.messages ?? [];
	const firstUser = messages.find((m) => m.role === "user");
	const marker = markerOf(JSON.stringify(firstUser ?? {}));
	const assistantTurns = messages.filter((m) => m.role === "assistant").length;
	return { marker, turn: assistantTurns + 1 };
}

function markerOf(text: string): string {
	const match = /canary-marker:([A-Za-z0-9_-]+)/.exec(text);
	return match?.[1] ?? "unknown";
}

function sseChunk(delta: Record<string, unknown>, finish: string | null = null): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-canary",
		object: "chat.completion.chunk",
		created: 1,
		model: "scripted-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;
}

const USAGE_CHUNK = `data: ${JSON.stringify({
	id: "chatcmpl-canary",
	object: "chat.completion.chunk",
	created: 1,
	model: "scripted-model",
	choices: [],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
})}\n\n`;

function bodyForTurn(turn: number): string {
	const calls = FORCED_CALLS[turn];
	if (!calls) {
		return sseChunk({ role: "assistant", content: "done" }) + sseChunk({}, "stop") + USAGE_CHUNK + "data: [DONE]\n\n";
	}
	let body = sseChunk({ role: "assistant", content: null });
	calls.forEach((call, i) => {
		body += sseChunk({
			tool_calls: [
				{
					index: i,
					id: `call_${turn}_${i}`,
					type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.args) },
				},
			],
		});
	});
	body += sseChunk({}, "tool_calls") + USAGE_CHUNK + "data: [DONE]\n\n";
	return body;
}

export interface ScriptedProvider {
	/** OpenAI-compatible base URL, e.g. `http://127.0.0.1:PORT/v1`. */
	baseUrl: string;
	/** Everything the child declared, in arrival order. */
	requests: CapturedRequest[];
	/** Requests belonging to one run marker. */
	forMarker(marker: string): CapturedRequest[];
	close(): Promise<void>;
}

export async function startScriptedProvider(): Promise<ScriptedProvider> {
	const requests: CapturedRequest[] = [];
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			let parsed: {
				tools?: Array<{ function?: { name?: string } }>;
				messages?: Array<{ role?: string; content?: unknown }>;
			} = {};
			try {
				parsed = JSON.parse(raw);
			} catch {
				/* a malformed body records as "no tools" — never a silent pass */
			}
			const { marker, turn } = turnOf(parsed);
			requests.push({
				tools: (parsed.tools ?? []).map((t) => t.function?.name ?? "?"),
				hasToolsKey: parsed.tools !== undefined,
				marker,
			});
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.end(bodyForTurn(turn));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("scripted provider did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		forMarker: (marker: string) => requests.filter((r) => r.marker === marker),
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

// ---------------------------------------------------------------------------
// Scratch sources
// ---------------------------------------------------------------------------

/**
 * A harmless DIRECT extension tool. It appends on load, on session start and on
 * execution, so "initialised" and "executed" stay separable facts — that
 * distinction is the whole #442 policy.
 */
export function canaryExtensionSource(logPath: string): string {
	return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync } from "node:fs";

const LOG = ${JSON.stringify(logPath)};

export default function (pi: ExtensionAPI) {
	appendFileSync(LOG, "extension:loaded\\n");
	pi.on("session_start", () => appendFileSync(LOG, "extension:session_start\\n"));
	pi.registerTool({
		name: "extension_canary",
		label: "Extension Canary",
		description: "Records that the child executed the extension canary tool.",
		parameters: Type.Object({}),
		async execute() {
			appendFileSync(LOG, "extension_canary:executed\\n");
			return { content: [{ type: "text", text: "extension canary ran" }], details: {} };
		},
	});
}
`;
}

/** A minimal stdio MCP server exposing ONE tool named `canary`. */
export function mcpServerSource(): string {
	return `import { appendFileSync } from "node:fs";

const [name, log] = process.argv.slice(2);
const say = (m) => appendFileSync(log, \`mcp:\${name}:\${m}\\n\`);
say("start");

let buf = "";
process.stdin.on("data", (c) => {
	buf += c.toString();
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
		if (msg.method === "initialize") {
			say("initialize");
			reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } });
		} else if (msg.method === "notifications/initialized") {
			say("initialized");
		} else if (msg.method === "tools/list") {
			say("tools/list");
			reply({ tools: [{ name: "canary", description: \`\${name} canary\`, inputSchema: { type: "object", properties: {} } }] });
		} else if (msg.method === "tools/call") {
			say(\`call:\${msg.params?.name}\`);
			reply({ content: [{ type: "text", text: "mcp canary ran" }] });
		} else if (msg.id !== undefined) {
			reply({});
		}
	}
});
process.stdin.on("end", () => process.exit(0));
`;
}

/** Write a fresh scratch project + HOME. `agentDir` is `<home>/.pi/agent`. */
export function writeCanaryScratch(providerBaseUrl: string, prefix = "brl-442-canary"): Scratch {
	const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
	const home = join(root, "home");
	const project = join(root, "project");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(project, { recursive: true });

	const logPath = join(root, "canary.log");
	const serverPath = join(root, "mcp-server.mjs");
	writeFileSync(serverPath, mcpServerSource(), "utf8");
	writeFileSync(join(agentDir, "extensions", "canary.ts"), canaryExtensionSource(logPath), "utf8");
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					deepseek: {
						baseUrl: providerBaseUrl,
						apiKey: "fake-key-for-loopback-only",
						models: [
							{
								id: "scripted-model",
								name: "Scripted Loopback",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);
	// One server per MCP exposure mode: a mode that fails to connect cannot hide
	// behind another mode's success.
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify(
			{
				mcpServers: {
					canary_direct: { command: process.execPath, args: [serverPath, "canary_direct", logPath], exposure: "direct" },
					canary_codemode: {
						command: process.execPath,
						args: [serverPath, "canary_codemode", logPath],
						exposure: "codemode",
					},
					canary_deferred: {
						command: process.execPath,
						args: [serverPath, "canary_deferred", logPath],
						exposure: "deferred",
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);
	chmodSync(serverPath, 0o755);
	writeFileSync(join(project, "hello.txt"), "hello\n", "utf8");
	return {
		root,
		home,
		agentDir,
		project,
		logPath,
		serverPath,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

export interface Scratch {
	root: string;
	home: string;
	/** `<home>/.pi/agent` — the agent dir the child (or the SDK) reads. */
	agentDir: string;
	project: string;
	logPath: string;
	serverPath: string;
	dispose(): void;
}

/**
 * Canary log lines. An append-only read is fine for a settled child; for a LIVE
 * background session use `canarySnapshot` (it tolerates a partially written
 * line by dropping the tail).
 */
export function canaryLines(logPath: string): string[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}
