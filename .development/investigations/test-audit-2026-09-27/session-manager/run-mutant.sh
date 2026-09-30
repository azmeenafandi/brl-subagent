#!/bin/bash
# usage: run-mutant.sh <name>
set -u
cd /home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-wt-234
N="$1"
git status --porcelain --untracked-files=no | grep -q . && { echo "DIRTY BEFORE"; exit 3; }
python3 /tmp/mutate.py "$N" check || exit 2
python3 /tmp/mutate.py "$N" || { git checkout -- src/session-manager.ts; exit 2; }
git diff --unified=0 src/session-manager.ts > /tmp/sm-$N-diff.txt
timeout 900 npx vitest run src/__tests__/session-manager.test.ts > /tmp/sm-$N-out.txt 2>&1
echo "EXIT=$?" >> /tmp/sm-$N-out.txt
git checkout -- src/session-manager.ts
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then echo "DIRTY AFTER: $DIRTY"; fi
tail -40 /tmp/sm-$N-out.txt
