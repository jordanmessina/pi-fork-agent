# Changelog

## Unreleased

- Resolve child runtime module URLs from Pi's host package instead of using `import.meta.resolve()`, which bypasses Pi's extension aliases in production installs.
- Make the smoke test exercise normal extension startup from a production-style package copy without `node_modules`, rather than the metadata-only model-list path.

## 0.1.1

- Bind child extensions before prompting so `session_start` initializes stateful extensions such as `pi-mcp-adapter`.
- Emit `session_shutdown` before disposing child sessions so extension-owned processes and connections are cleaned up.

## 0.1.0

- Initial standalone Pi package.
- Fork the exact active parent branch into process-isolated Pi SDK children.
- Preserve provider cache identity, model configuration, system prompt, and active tool ordering.
- Persist and link child sessions for persisted parents.
- Reject recursive delegation through a model-invisible child marker.
- Reject child compaction and report it as a failed delegated task.
- Truncate parent-facing results at Pi's standard tool-output boundary.
