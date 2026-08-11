import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CURRENT_SESSION_VERSION,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	type SessionEntry,
	SessionManager,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "fork_agent";
const CHILD_MARKER_TYPE = "fork-agent-child";
const COMPACTION_SIGNAL_ENV = "PI_FORK_AGENT_COMPACTION_SIGNAL";
const RUNNER_PATH = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const SDK_MODULE_URL = import.meta.resolve("@earendil-works/pi-coding-agent");
const AI_MODULE_URL = import.meta.resolve("@earendil-works/pi-ai");
const MAX_RUNNER_DIAGNOSTIC_LENGTH = 64 * 1024;

function isForkedChild(entries: SessionEntry[]): boolean {
	return entries.some((entry) => entry.type === "custom" && entry.customType === CHILD_MARKER_TYPE);
}

function containsToolCall(entry: SessionEntry, toolCallId: string): boolean {
	return (
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)
	);
}

interface RunnerResult {
	ok: boolean;
	text: string;
	stopReason?: string;
}

function appendDiagnostic(current: string, chunk: Buffer): string {
	return (current + chunk.toString("utf8")).slice(-MAX_RUNNER_DIAGNOSTIC_LENGTH);
}

export function formatChildResult(
	text: string,
	sessionFile: string,
	persisted: boolean,
): string {
	const truncation = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!truncation.truncated) return text;
	const location = persisted
		? `Full answer retained in child session: ${sessionFile}`
		: "The ephemeral child transcript was removed after execution.";
	return (
		`${truncation.content}${truncation.content ? "\n\n" : ""}` +
		`[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
		`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${location}]`
	);
}

async function runChildProcess(
	configPath: string,
	resultPath: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
): Promise<RunnerResult> {
	const childProcess = spawn(process.execPath, [RUNNER_PATH, configPath], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	childProcess.stdout.on("data", (chunk: Buffer) => {
		stdout = appendDiagnostic(stdout, chunk);
	});
	childProcess.stderr.on("data", (chunk: Buffer) => {
		stderr = appendDiagnostic(stderr, chunk);
	});

	const requestAbort = () => childProcess.kill("SIGTERM");
	signal?.addEventListener("abort", requestAbort, { once: true });
	if (signal?.aborted) requestAbort();

	let exitCode: number | null;
	let exitSignal: NodeJS.Signals | null;
	try {
		({ code: exitCode, signal: exitSignal } = await new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve, reject) => {
			childProcess.once("error", reject);
			childProcess.once("close", (code, closedBySignal) =>
				resolve({ code, signal: closedBySignal }),
			);
		}));
	} finally {
		signal?.removeEventListener("abort", requestAbort);
	}

	let result: RunnerResult;
	try {
		result = JSON.parse(await readFile(resultPath, "utf8")) as RunnerResult;
	} catch (error) {
		const diagnostics = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
		const exit = exitSignal ? `signal ${exitSignal}` : `code ${exitCode ?? "unknown"}`;
		throw new Error(
			`Forked child process exited with ${exit} without a valid result${diagnostics ? `:\n${diagnostics}` : "."}`,
			{ cause: error },
		);
	}
	if (typeof result.ok !== "boolean" || typeof result.text !== "string") {
		throw new Error("Forked child process returned an invalid result.");
	}
	return result;
}

export default function forkAgentExtension(pi: ExtensionAPI) {
	let activeToolNames: string[] | undefined;

	// The extension context intentionally exposes only a read-only session manager.
	// Capture the active tool ordering at prompt start so the child can reproduce the
	// provider-visible tool prefix instead of falling back to Pi's default tools.
	pi.on("before_agent_start", (event) => {
		activeToolNames = [...(event.systemPromptOptions.selectedTools ?? [])];
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!isForkedChild(ctx.sessionManager.getEntries())) return;
		const signalPath = process.env[COMPACTION_SIGNAL_ENV];
		if (signalPath) {
			writeFileSync(
				signalPath,
				`${JSON.stringify({ reason: event.reason, willRetry: event.willRetry })}\n`,
				{ encoding: "utf8", mode: 0o600 },
			);
		}
		return { cancel: true };
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Fork agent",
		description:
			"Run one focused task in a child that forks the exact active conversation branch. " +
			"The child uses the same model, thinking level, system prompt, tools, working directory, and provider cache key. " +
			"Its intermediate messages and tool calls stay out of the parent branch in a linked child session; this tool returns only its final answer. " +
			"Give it a precise, self-contained task. fork_agent remains visible in children to preserve the exact tool schema, but child calls are rejected.",
		parameters: Type.Object({
			task: Type.String({
				description: "The single focused task to append to the forked conversation",
				minLength: 1,
			}),
		}),
		async execute(toolCallId, { task }, signal, _onUpdate, ctx) {
			if (isForkedChild(ctx.sessionManager.getEntries())) {
				throw new Error(
					"fork_agent cannot be used from a forked subagent. Complete the delegated task directly and return the result to the parent.",
				);
			}
			if (!ctx.model) {
				throw new Error("Cannot fork an agent without an active model.");
			}
			if (!activeToolNames) {
				throw new Error("Cannot fork before the parent prompt configuration is available.");
			}
			if (signal?.aborted) {
				throw new Error("Forked task was aborted before it started.");
			}

			const branch = ctx.sessionManager.getBranch();
			const callEntry = [...branch].reverse().find((entry) => containsToolCall(entry, toolCallId));
			if (!callEntry) {
				throw new Error("Cannot locate the parent tool call in the active session branch.");
			}

			// Exclude the assistant message that requested this tool. The provider never
			// saw that message as input; ending at its parent reproduces the exact prompt
			// prefix that produced the delegation, with no dangling tool call.
			const inheritedEntries = callEntry.parentId ? ctx.sessionManager.getBranch(callEntry.parentId) : [];
			const parentHeader = ctx.sessionManager.getHeader();
			const childSessionId = randomUUID();
			const parentSessionId = ctx.sessionManager.getSessionId();
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			const parentSystemPrompt = ctx.getSystemPrompt();
			// Preserve the exact provider-visible tool names and ordering for prompt-cache
			// reuse. A session marker makes fork_agent reject child calls at execution.
			const childTools = [...activeToolNames];
			const childModel = ctx.model;
			const childThinkingLevel = ctx.thinkingLevel;
			const childScopedModels = ctx.scopedModels.map(({ model, thinkingLevel }) => ({ model, thinkingLevel }));
			const temporaryDirectory = parentSessionFile ? undefined : await mkdtemp(join(tmpdir(), "pi-fork-agent-"));
			const sessionDirectory = parentSessionFile ? dirname(parentSessionFile) : temporaryDirectory!;
			const timestamp = new Date().toISOString();
			const sessionFile = parentSessionFile
				? join(sessionDirectory, `${timestamp.replace(/[:.]/g, "-")}_${childSessionId}.jsonl`)
				: join(sessionDirectory, "session.jsonl");
			const header = {
				...(parentHeader ?? {}),
				type: "session" as const,
				version: parentHeader?.version ?? CURRENT_SESSION_VERSION,
				id: childSessionId,
				timestamp,
				cwd: ctx.cwd,
				...(parentSessionFile ? { parentSession: parentSessionFile } : {}),
			};

			const childTask = [
				"You are a focused subagent launched by a parent Pi session with the parent's exact active conversation context.",
				"Use that inherited context only to understand the background, intent, and reason for this delegation.",
				"Complete only the task delegated below. Do not continue the parent's broader work or delegate the task to another agent.",
				"Do not call fork_agent. It remains visible only to preserve the parent's exact tool schema and will reject calls from this child.",
				"Context compaction is disabled in this child. Complete the focused task within the inherited remaining context.",
				"Use the other tools available to you as needed, then return a self-contained final result for the parent.",
				"",
				"Task from the parent:",
				task,
			].join("\n");
			let ipcDirectory: string | undefined;
			try {
				await writeFile(
					sessionFile,
					[header, ...inheritedEntries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
					{ encoding: "utf8", mode: 0o600 },
				);

				const childSessionManager = SessionManager.open(sessionFile, sessionDirectory, ctx.cwd);
				// Custom entries never enter model context, so this durable recursion marker
				// does not alter the inherited provider prompt or its cacheable prefix.
				childSessionManager.appendCustomEntry(CHILD_MARKER_TYPE, { parentSessionId });
				childSessionManager.appendSessionInfo(`fork_agent: ${task.replace(/\s+/g, " ").trim().slice(0, 80)}`);

				ipcDirectory = await mkdtemp(join(tmpdir(), "pi-fork-agent-run-"));
				const configPath = join(ipcDirectory, "config.json");
				const resultPath = join(ipcDirectory, "result.json");
				const compactionSignalPath = join(ipcDirectory, "compaction.json");
				await writeFile(
					configPath,
					`${JSON.stringify({
						sdkModuleUrl: SDK_MODULE_URL,
						aiModuleUrl: AI_MODULE_URL,
						resultPath,
						compactionSignalPath,
						sessionFile,
						sessionDirectory,
						cwd: ctx.cwd,
						parentSessionId,
						model: childModel,
						thinkingLevel: childThinkingLevel,
						scopedModels: childScopedModels,
						tools: childTools,
						systemPrompt: parentSystemPrompt,
						task: childTask,
					})}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);

				const result = await runChildProcess(
					configPath,
					resultPath,
					ctx.cwd,
					{
						...process.env,
						PI_SESSION_ID: childSessionId,
						PI_SESSION_FILE: sessionFile,
						PI_MODEL: childModel.id,
						PI_PROVIDER: childModel.provider,
						PI_REASONING_LEVEL: childThinkingLevel,
						[COMPACTION_SIGNAL_ENV]: compactionSignalPath,
					},
					signal,
				);
				if (!result.ok) throw new Error(result.text);
				return {
					content: [
						{
							type: "text" as const,
							text: formatChildResult(result.text, sessionFile, Boolean(parentSessionFile)),
						},
					],
					details: undefined,
				};
			} finally {
				if (ipcDirectory) await rm(ipcDirectory, { recursive: true, force: true });
				if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
			}
		},
	});
}
