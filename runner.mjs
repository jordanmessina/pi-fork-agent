import { readFile, writeFile } from "node:fs/promises";

const configPath = process.argv[2];
if (!configPath) throw new Error("fork-agent runner requires a config path");

const COMPACTION_BLOCKED_MARKER_TYPE = "fork-agent-compaction-blocked";

let child;
let cleanupSessionResources;
let parentSessionId;
let abortRequested = false;

function finalAssistantMessage(messages) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function textContent(message) {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function requestAbort() {
	abortRequested = true;
	child?.agent.abort();
}

process.on("SIGINT", requestAbort);
process.on("SIGTERM", requestAbort);

async function saveResult(resultPath, result) {
	await writeFile(resultPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
}

let resultPath;
try {
	const config = JSON.parse(await readFile(configPath, "utf8"));
	resultPath = config.resultPath;
	parentSessionId = config.parentSessionId;

	const sdk = await import(config.sdkModuleUrl);
	({ cleanupSessionResources } = await import(config.aiModuleUrl));

	const childSessionManager = sdk.SessionManager.open(
		config.sessionFile,
		config.sessionDirectory,
		config.cwd,
	);
	({ session: child } = await sdk.createAgentSession({
		cwd: config.cwd,
		model: config.model,
		thinkingLevel: config.thinkingLevel,
		scopedModels: config.scopedModels,
		tools: config.tools,
		sessionManager: childSessionManager,
	}));

	const reconstructedToolDefinitions = child.agent.state.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	if (
		JSON.stringify(reconstructedToolDefinitions) !==
		JSON.stringify(config.toolDefinitions)
	) {
		throw new Error(
			"Forked child tool definitions differ from the parent; refusing to change the provider-cache prefix.",
		);
	}

	// The persisted child ID remains unique, while every child process uses the
	// parent's provider cache identity. Each process has its own Pi module state
	// and therefore its own reusable WebSocket and continuation chain.
	child.agent.sessionId = parentSessionId;
	child.agent.state.systemPrompt = config.systemPrompt;

	const prepareNextTurn = child.agent.prepareNextTurnWithContext;
	child.agent.prepareNextTurnWithContext = async (turn, signal) => {
		const update = await prepareNextTurn?.(turn, signal);
		return {
			...update,
			context: {
				...(update?.context ?? turn.context),
				systemPrompt: config.systemPrompt,
			},
		};
	};

	const inheritedMessageCount = child.agent.state.messages.length;
	if (abortRequested) child.agent.abort();
	await child.agent.prompt({
		role: "user",
		content: [{ type: "text", text: config.task }],
		timestamp: Date.now(),
	});

	let compactionBlocked;
	try {
		compactionBlocked = JSON.parse(
			await readFile(config.compactionSignalPath, "utf8"),
		);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (compactionBlocked) {
		childSessionManager.appendCustomEntry(
			COMPACTION_BLOCKED_MARKER_TYPE,
			compactionBlocked,
		);
		const reason = compactionBlocked.reason ?? "unknown";
		await saveResult(resultPath, {
			ok: false,
			text:
				`Forked subagent compaction was blocked (${reason}). ` +
				"Delegate a smaller task or reduce the parent context before forking.",
			stopReason: "compaction-blocked",
		});
		process.exitCode = 1;
	} else {
		const finalMessage = finalAssistantMessage(
			child.agent.state.messages.slice(inheritedMessageCount),
		);
		const output = finalMessage ? textContent(finalMessage) : "";
		const failed =
			!finalMessage ||
			finalMessage.stopReason === "error" ||
			finalMessage.stopReason === "aborted";
		await saveResult(resultPath, {
			ok: !failed,
			text:
				output ||
				finalMessage?.errorMessage ||
				(failed ? "Forked task did not produce a final answer." : "(no final text)"),
			stopReason: finalMessage?.stopReason,
		});
		if (failed) process.exitCode = 1;
	}
} catch (error) {
	if (resultPath) {
		await saveResult(resultPath, {
			ok: false,
			text: error instanceof Error ? error.message : String(error),
		});
	} else {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	}
	process.exitCode = 1;
} finally {
	child?.dispose();
	// AgentSession.dispose() cleans up by the persisted child ID. Provider
	// resources use the inherited parent ID, so close them explicitly before the
	// runner exits instead of leaving the WebSocket idle timer alive.
	cleanupSessionResources?.(parentSessionId);
}
