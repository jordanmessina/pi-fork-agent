#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROVIDER="${PI_FORK_EVAL_PROVIDER:-openai-codex}"
MODEL="${PI_FORK_EVAL_MODEL:-gpt-5.6-sol}"
THINKING="${PI_FORK_EVAL_THINKING:-high}"
EVAL_DIR="${1:-$(mktemp -d /tmp/pi-fork-agent-eval.XXXXXX)}"

mkdir -p "$EVAL_DIR"
cp "$ROOT/test/fixtures/initial-prompt.md" "$EVAL_DIR/initial-prompt.md"
cp "$ROOT/test/fixtures/fork-prompt.md" "$EVAL_DIR/fork-prompt.md"

cd "$ROOT"
pi --provider "$PROVIDER" --model "$MODEL" --thinking "$THINKING" \
  --session-dir "$EVAL_DIR" --print "$(cat "$EVAL_DIR/initial-prompt.md")" \
  >"$EVAL_DIR/initial-output.txt" 2>"$EVAL_DIR/initial-stderr.txt"

parent="$(python3 - "$EVAL_DIR" <<'PY'
import glob, json, sys
for path in glob.glob(sys.argv[1] + "/*.jsonl"):
    with open(path) as stream:
        header = json.loads(stream.readline())
    if not header.get("parentSession"):
        print(path)
        break
PY
)"

if [[ -z "$parent" ]]; then
  echo "Could not locate the parent session." >&2
  exit 1
fi

pi --session-dir "$EVAL_DIR" --session "$parent" \
  --print "$(cat "$EVAL_DIR/fork-prompt.md")" \
  >"$EVAL_DIR/final-output.txt" 2>"$EVAL_DIR/final-stderr.txt"

python3 - "$EVAL_DIR" "$parent" <<'PY'
import glob, json, os, sys

directory, parent_file = sys.argv[1:]
children = []
for path in glob.glob(directory + "/*.jsonl"):
    with open(path) as stream:
        entries = [json.loads(line) for line in stream]
    if entries[0].get("parentSession") == parent_file:
        children.append((path, entries))

rows = []
grandchildren = []
compactions = []
for path, entries in children:
    marker_index = next(
        index for index, entry in enumerate(entries)
        if entry.get("type") == "custom" and entry.get("customType") == "fork-agent-child"
    )
    task = next(
        "".join(part.get("text", "") for part in entry["message"].get("content", []))
        for entry in entries[marker_index + 1:]
        if entry.get("type") == "message" and entry.get("message", {}).get("role") == "user"
    ).split("Task from the parent:\n", 1)[-1]
    if task.startswith("Audit"):
        child_number = 1
    elif task.startswith("Analyze"):
        child_number = 2
    elif task.startswith("Check"):
        child_number = 3
    else:
        child_number = 4
    reads = []
    for entry in entries[marker_index + 1:]:
        message = entry.get("message", {})
        if entry.get("type") == "message" and message.get("role") == "assistant":
            reads.append(message.get("usage", {}).get("cacheRead", 0))
        if entry.get("type") == "compaction" or (
            entry.get("type") == "custom"
            and entry.get("customType") == "fork-agent-compaction-blocked"
        ):
            compactions.append(os.path.basename(path))
    rows.append({
        "child": child_number,
        "session": os.path.basename(path),
        "cacheReads": reads,
        "allRequestsHit": bool(reads) and all(value > 0 for value in reads),
    })

for path in glob.glob(directory + "/*.jsonl"):
    with open(path) as stream:
        header = json.loads(stream.readline())
    linked = header.get("parentSession")
    if linked and linked != parent_file:
        grandchildren.append(os.path.basename(path))

rows.sort(key=lambda row: row["child"])
initial_hits = sum(bool(row["cacheReads"] and row["cacheReads"][0] > 0) for row in rows)
followups = [value for row in rows for value in row["cacheReads"][1:]]
summary = {
    "directory": directory,
    "children": len(children),
    "initialCacheHits": f"{initial_hits}/{len(rows)}",
    "followupCacheHits": f"{sum(value > 0 for value in followups)}/{len(followups)}",
    "totalCacheHits": f"{sum(value > 0 for row in rows for value in row['cacheReads'])}/{sum(len(row['cacheReads']) for row in rows)}",
    "grandchildren": grandchildren,
    "compactions": compactions,
    "requests": rows,
}
print(json.dumps(summary, indent=2))
if len(children) != 4 or grandchildren or compactions:
    raise SystemExit(1)
PY

printf '\nInitial output:\n'
cat "$EVAL_DIR/initial-output.txt"
printf '\nFinal output:\n'
cat "$EVAL_DIR/final-output.txt"
printf '\nEval directory: %s\n' "$EVAL_DIR"
