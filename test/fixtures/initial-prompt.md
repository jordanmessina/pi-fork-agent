We are conducting a read-only evaluation of the local Pi fork_agent extension.

Do not use fork_agent yet and do not modify any files.

Read these files:
- index.ts
- runner.mjs
- README.md
- test/extension.test.mjs
- test/runner.test.mjs

Treat the following as the authoritative evaluation brief:

- Context canary: MANGO-CIRCUIT-417
- Priority order: correctness, prompt-cache compatibility, simplicity, observability.
- A child must inherit the exact active parent conversation preceding delegation.
- The child must preserve the parent's model, thinking level, effective system prompt, provider cache key, and complete active tool schema in the same order.
- fork_agent must remain declared in the child so its removal cannot bust the cache prefix.
- The child prompt must tell it not to invoke fork_agent.
- A model-invisible persisted marker must make the implementation reject fork_agent when called by a child.
- Child compaction must be cancelled and reported as a failed delegated task without affecting parent compaction.
- Child tool traffic must remain outside the parent branch.
- Only the child's final answer should return to the parent.
- Child sessions should remain inspectable and linked to the parent.
- There should be no timeouts, turn budgets, tool budgets, or Bash interception.
- Make no code changes during this evaluation.

After reading the files, reply only with:
BRIEF_LOADED
followed by one sentence identifying the most important invariant.
