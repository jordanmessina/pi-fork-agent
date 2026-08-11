# Security policy

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories for this repository. Do not include credentials, session transcripts, or other sensitive data in a public issue.

## Trust model

`pi-fork-agent` is a Pi extension and executes with the same operating-system permissions as Pi. Child processes inherit the parent environment, authentication access, working directory, and filesystem access. Only install code and updates you trust.

Persisted child JSONL files contain inherited conversation history, tool inputs and outputs, model responses, and usage data. Protect Pi's session directory accordingly.

The extension does not sandbox child filesystem writes. Concurrent children must be assigned non-overlapping files or isolated worktrees when they can modify the repository.
