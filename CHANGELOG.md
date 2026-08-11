# Changelog

## 0.1.0

- Initial standalone Pi package.
- Fork the exact active parent branch into process-isolated Pi SDK children.
- Preserve provider cache identity, model configuration, system prompt, and active tool ordering.
- Persist and link child sessions for persisted parents.
- Reject recursive delegation through a model-invisible child marker.
- Reject child compaction and report it as a failed delegated task.
- Truncate parent-facing results at Pi's standard tool-output boundary.
