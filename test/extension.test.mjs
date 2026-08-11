import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import extension, { formatChildResult } from "../index.ts";

function loadExtension() {
  const handlers = new Map();
  let tool;
  extension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(definition) {
      tool = definition;
    },
  });
  return { handlers, tool };
}

test("marked children reject recursive delegation by throwing", async () => {
  const { tool } = loadExtension();
  const context = {
    sessionManager: {
      getEntries: () => [
        { type: "custom", customType: "fork-agent-child", data: {} },
      ],
    },
  };

  await assert.rejects(
    tool.execute("call-1", { task: "nested" }, undefined, undefined, context),
    /fork_agent cannot be used from a forked subagent/,
  );
});

test("child compaction is cancelled and signaled for every reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-fork-agent-test-"));
  const signalPath = join(directory, "compaction.json");
  const previous = process.env.PI_FORK_AGENT_COMPACTION_SIGNAL;
  process.env.PI_FORK_AGENT_COMPACTION_SIGNAL = signalPath;

  try {
    const { handlers } = loadExtension();
    const handler = handlers.get("session_before_compact");
    const context = {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "fork-agent-child", data: {} },
        ],
      },
    };

    for (const reason of ["manual", "threshold", "overflow"]) {
      assert.deepEqual(
        handler({ reason, willRetry: reason === "overflow" }, context),
        { cancel: true },
      );
      assert.deepEqual(JSON.parse(await readFile(signalPath, "utf8")), {
        reason,
        willRetry: reason === "overflow",
      });
    }
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_AGENT_COMPACTION_SIGNAL;
    else process.env.PI_FORK_AGENT_COMPACTION_SIGNAL = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("parent results use Pi's standard output boundary", () => {
  const short = "short result";
  assert.equal(formatChildResult(short, "/sessions/child.jsonl", true), short);

  const long = Array.from({ length: 2100 }, (_, index) => `line ${index}`).join("\n");
  const formatted = formatChildResult(long, "/sessions/child.jsonl", true);
  assert.match(formatted, /\[Output truncated:/);
  assert.match(formatted, /Full answer retained in child session: \/sessions\/child\.jsonl/);
  assert.ok(formatted.split("\n").length <= 2002);
});
