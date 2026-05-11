#!/bin/bash
# stop hook: runs `tsc --noEmit` and, if it fails, reports the errors back to the agent
# via the `additional_context` JSON field so it self-corrects before finishing.
set -u
cd "$(dirname "$0")/../.."

if ! command -v npx >/dev/null 2>&1; then
  echo '{}'
  exit 0
fi

OUTPUT=$(npx --no-install tsc --noEmit 2>&1)
STATUS=$?

if [ $STATUS -eq 0 ]; then
  echo '{}'
  exit 0
fi

TRIMMED=$(printf '%s\n' "$OUTPUT" | head -n 60)
export ERRS="$TRIMMED"

if command -v python3 >/dev/null 2>&1; then
  python3 -c '
import json, os
errs = os.environ.get("ERRS", "")
msg = (
    "TypeScript typecheck failed for Play4CashGateway. Resolve before finishing this turn:\n\n"
    "```\n" + errs + "\n```"
)
print(json.dumps({"additional_context": msg}))
'
else
  printf '{"additional_context":"TypeScript typecheck failed for Play4CashGateway. See terminal output."}\n'
fi
exit 0
