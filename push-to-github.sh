#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
REMOTE_URL="${1:-https://github.com/chenziyang110/pore-master-clinic.git}"
if git remote get-url origin >/dev/null 2>&1; then
  if [[ $# -gt 0 ]]; then
    git remote set-url origin "$REMOTE_URL"
  fi
else
  git remote add origin "$REMOTE_URL"
fi
git push -u origin HEAD
echo "已推送当前分支。"
