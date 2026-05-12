#!/bin/bash
set -e

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

CURRENT_HEAD=$(git rev-parse HEAD)
EMPTY_TREE=$(git hash-object -t tree /dev/null)

cat > /tmp/msg.txt <<EOF
Task: ${ISSUE_TITLE}

Issue: #${ISSUE_NUMBER}
Author: ${ISSUE_AUTHOR}
URL: ${ISSUE_URL}
Status: pending
Type: epic

${ISSUE_BODY}
EOF

TASK_COMMIT=$(git commit-tree ${EMPTY_TREE} -p ${CURRENT_HEAD} -F /tmp/msg.txt)
echo "Created task commit: ${TASK_COMMIT}"

git update-ref refs/heads/tasks/pending/${ISSUE_NUMBER} ${TASK_COMMIT}
git push origin refs/heads/tasks/pending/${ISSUE_NUMBER}

gh issue comment ${ISSUE_NUMBER} --body "Task metadata commit: ${TASK_COMMIT} | Branch: tasks/pending/${ISSUE_NUMBER}"
