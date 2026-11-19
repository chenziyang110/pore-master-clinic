#!/usr/bin/env bash
set -e
REMOTE_URL="${1:-git@github.com:chenziyang110/pore-master-clinic.git}"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi
git branch -M main
git push -u origin main --force
echo "✅ 已推送至 $REMOTE_URL (main)"
