# pi-fork-agent

`pi-fork-agent` adds one focused `fork_agent` tool to the [Pi coding agent](https://github.com/earendil-works/pi-mono). It forks the exact active conversation branch into an isolated, inspectable child session instead of starting from a summary or reformatted context block.

## Install

From npm after the package is published:

```bash
pi install npm:pi-fork-agent
```

Directly from GitHub:

```bash
pi install git:github.com/jordanmessina/pi-fork-agent
```

Restart Pi after installing or updating the package.

## Behavior

1. Find the assistant message containing the current `fork_agent` call.
2. Copy the active branch only through that message's parent. This reproduces the provider input that produced the delegation without leaving a dangling tool call.
3. Create a unique child JSONL beside a persisted parent and link it with `parentSession`.
4. Launch a dedicated Node process using Pi's SDK with the parent's model, thinking level, effective system prompt, scoped models, working directory, provider cache identity, and active tool-name ordering.
5. Append one focused child task after the inherited prefix.
6. Return only the child's final assistant text. Child messages and tool traffic remain in the child session.

Each runner has independent Pi module, WebSocket, and continuation state. Authentication, provider cache identity, working directory, and filesystem are intentionally shared. Parallel children therefore still require file ownership boundaries or separate worktrees when they may write overlapping files.

## Cache compatibility

The child uses a unique persisted session ID but sets the runtime provider session ID to the parent's session ID. The inherited conversation and system prompt remain unchanged before the appended child task, and `fork_agent` remains in the active tool list.

The extension preserves active tool names and ordering. Child processes reconstruct tool definitions through Pi's normal extension loading pipeline, so exact schema identity depends on deterministic extensions. Provider routing, cache thresholds, transport behavior, and other extensions can still prevent cache reuse. Cache compatibility is an optimization, not a guarantee.

## Safety properties

### No recursive delegation

A model-invisible `fork-agent-child` custom session entry marks children. Child prompts tell the model not to delegate, and `fork_agent` throws an error if a marked child calls it. Keeping the tool declared preserves the parent tool-list prefix while preventing grandchild execution.

### No child compaction

Pi's `session_before_compact` hook rejects manual, threshold, and overflow-recovery compaction for marked children. The isolated runner persists a `fork-agent-compaction-blocked` marker and fails the task with guidance to delegate less work or reduce the parent context before forking. Parent-session compaction is unaffected.

### Bounded parent result

The final child answer returned through the tool is limited to Pi's standard 50KB or 2,000-line tool-output boundary. A persisted child retains the full answer in its transcript.

There are no Bash restrictions, timeouts, turn limits, or tool budgets.

## Session behavior

Persisted parents receive linked children beside the parent JSONL. Ephemeral parents currently use temporary children that are deleted after execution because there is no parent file to link.

Custom marker entries are ignored by `buildSessionContext`, so recursion and compaction state do not enter the provider prompt.

## Development

Requirements:

- Node.js 22.19 or newer
- Pi 0.84.x

```bash
npm install
npm run check
npm run pack:check
pi -e ./index.ts
```

The package is intentionally pinned to Pi 0.84.x because cache identity currently requires SDK properties that are not yet separate public runtime/cache identity APIs.

A credentialed regression evaluation is available at `scripts/poor-mans-eval.sh`. It launches four children concurrently, checks inherited context and recursion blocking, and reports provider cache reads from the persisted JSONLs.

## Security

Pi extensions execute with the user's full permissions. Review this package before installation. See [SECURITY.md](SECURITY.md).

## License

MIT
