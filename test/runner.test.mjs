import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const runnerPath = new URL("../runner.mjs", import.meta.url);

async function runRunner({ compaction, toolMismatch } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-fork-runner-test-"));
  const resultPath = join(directory, "result.json");
  const tracePath = join(directory, "trace.jsonl");
  const compactionSignalPath = join(directory, "compaction.json");
  const sdkPath = join(directory, "fake-sdk.mjs");
  const aiPath = join(directory, "fake-ai.mjs");
  const configPath = join(directory, "config.json");
  const toolDefinitions = [
    {
      name: "fork_agent",
      description: "Fork a focused child",
      parameters: { type: "object", properties: { task: { type: "string" } } },
    },
  ];

  await writeFile(
    sdkPath,
    `import { appendFileSync } from "node:fs";
const trace = (value) => appendFileSync(process.env.FORK_AGENT_TEST_TRACE, JSON.stringify(value) + "\\n");
const manager = {
  appendCustomEntry(customType, data) { trace({ customType, data }); },
};
export const SessionManager = { open() { return manager; } };
export async function createAgentSession() {
  const agent = {
    sessionId: "persisted-child-id",
    state: { messages: [{ role: "user", content: [{ type: "text", text: "inherited" }] }], systemPrompt: "initial", tools: ${JSON.stringify(toolDefinitions)} },
    prepareNextTurnWithContext: async (turn) => ({ context: turn.context }),
    abort() {},
    async prompt(message) {
      trace({ sessionId: this.sessionId, systemPrompt: this.state.systemPrompt });
      this.state.messages.push(message, {
        role: "assistant",
        content: [{ type: "text", text: "RUNNER_OK" }],
        stopReason: "stop"
      });
    },
  };
  return {
    session: {
      agent,
      extensionRunner: {
        async emit(event) { trace({ extensionEvent: event.type, reason: event.reason }); },
      },
      async bindExtensions(bindings) { trace({ boundMode: bindings.mode }); },
      dispose() { trace({ disposed: true }); },
    },
  };
}
`,
  );
  await writeFile(
    aiPath,
    `import { appendFileSync } from "node:fs";
export function cleanupSessionResources(id) {
  appendFileSync(process.env.FORK_AGENT_TEST_TRACE, JSON.stringify({ cleanup: id }) + "\\n");
}
`,
  );
  if (compaction) {
    await writeFile(
      compactionSignalPath,
      `${JSON.stringify({ reason: "threshold", willRetry: false })}\n`,
    );
  }
  await writeFile(
    configPath,
    `${JSON.stringify({
      sdkModuleUrl: pathToFileURL(sdkPath).href,
      aiModuleUrl: pathToFileURL(aiPath).href,
      resultPath,
      compactionSignalPath,
      sessionFile: join(directory, "session.jsonl"),
      sessionDirectory: directory,
      cwd: directory,
      parentSessionId: "parent-cache-id",
      model: { provider: "fake", id: "fake" },
      thinkingLevel: "off",
      scopedModels: [],
      tools: ["fork_agent"],
      toolDefinitions: toolMismatch
        ? [{ ...toolDefinitions[0], description: "different parent definition" }]
        : toolDefinitions,
      systemPrompt: "PINNED_SYSTEM_PROMPT",
      task: "focused task",
    })}\n`,
  );

  const child = spawn(process.execPath, [runnerPath.pathname, configPath], {
    env: { ...process.env, FORK_AGENT_TEST_TRACE: tracePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  const trace = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  return { directory, code, result, trace, stderr };
}

test("runner shares cache identity while pinning prompt and cleaning resources", async () => {
  const run = await runRunner();
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.result, { ok: true, text: "RUNNER_OK", stopReason: "stop" });
    assert.ok(run.trace.some((entry) => entry.boundMode === "print"));
    assert.ok(
      run.trace.some(
        (entry) =>
          entry.sessionId === "parent-cache-id" &&
          entry.systemPrompt === "PINNED_SYSTEM_PROMPT",
      ),
    );
    assert.ok(
      run.trace.some(
        (entry) => entry.extensionEvent === "session_shutdown" && entry.reason === "quit",
      ),
    );
    assert.ok(run.trace.some((entry) => entry.disposed));
    assert.ok(run.trace.some((entry) => entry.cleanup === "parent-cache-id"));
  } finally {
    await rm(run.directory, { recursive: true, force: true });
  }
});

test("runner rejects reconstructed tool definitions that differ from the parent", async () => {
  const run = await runRunner({ toolMismatch: true });
  try {
    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.result.ok, false);
    assert.match(run.result.text, /tool definitions differ from the parent/);
  } finally {
    await rm(run.directory, { recursive: true, force: true });
  }
});

test("runner persists and reports blocked compaction", async () => {
  const run = await runRunner({ compaction: true });
  try {
    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.result.ok, false);
    assert.equal(run.result.stopReason, "compaction-blocked");
    assert.match(run.result.text, /compaction was blocked \(threshold\)/);
    assert.ok(
      run.trace.some(
        (entry) =>
          entry.customType === "fork-agent-compaction-blocked" &&
          entry.data.reason === "threshold",
      ),
    );
  } finally {
    await rm(run.directory, { recursive: true, force: true });
  }
});
