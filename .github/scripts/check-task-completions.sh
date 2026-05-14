#!/bin/bash
set -e

# Check pushed commits for task completions and update GitHub issues

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

# Get the range of commits pushed
if [ -n "$GITHUB_BEFORE" ] && [ "$GITHUB_BEFORE" != "0000000000000000000000000000000000000000" ]; then
    COMMIT_RANGE="${GITHUB_BEFORE}..${GITHUB_SHA}"
else
    # First push or force push - check just the latest commit
    COMMIT_RANGE="${GITHUB_SHA}^..${GITHUB_SHA}"
fi

echo "Checking commits: $COMMIT_RANGE"

# Function to check if a commit has task parents
get_task_parents() {
    local commit="$1"
    git rev-list --parents -1 "$commit" | awk '{for(i=3;i<=NF;i++) print $i}'
}

# Function to extract issue number from task commit
get_issue_number() {
    local task_sha="$1"
    git log -1 --format='%B' "$task_sha" | grep "^Issue:" | sed 's/^Issue: *#//' | head -1
}

# Function to get task title
get_task_title() {
    local task_sha="$1"
    git log -1 --format='%s' "$task_sha" | sed 's/^Task: *//'
}

# Function to extract issue URL
get_issue_url() {
    local task_sha="$1"
    git log -1 --format='%B' "$task_sha" | grep "^URL:" | sed 's/^URL: *//' | head -1
}

# Check each commit in the range
git rev-list "$COMMIT_RANGE" | while read commit; do
    echo "Checking commit: $commit"
    
    # Get task parents (2nd+ parents)
    task_parents=$(get_task_parents "$commit")
    
    if [ -z "$task_parents" ]; then
        echo "  No task parents found"
        continue
    fi
    
    # Process each task parent
    echo "$task_parents" | while read task_sha; do
        echo "  Found task completion: $task_sha"
        
        issue_num=$(get_issue_number "$task_sha")
        task_title=$(get_task_title "$task_sha")
        issue_url=$(get_issue_url "$task_sha")
        
        if [ -z "$issue_num" ]; then
            echo "  No issue number found in task commit"
            continue
        fi
        
        echo "  Task: $task_title"
        echo "  Issue: #$issue_num"
        
        # Create completion comment
        commit_short=$(git rev-parse --short "$commit")
        task_short=$(git rev-parse --short "$task_sha")
        
        cat > /tmp/comment.md <<EOF
✅ Task completed in commit $commit_short

**Task:** $task_title  
**Task SHA:** \`$task_short\`  
**Completion commit:** $commit_short

View commit: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/commit/$commit
EOF
        
        # Post comment to issue
        if command -v gh &> /dev/null; then
            gh issue comment "$issue_num" --body-file /tmp/comment.md && \
                echo "  ✓ Posted completion comment to issue #$issue_num"
        else
            echo "  Warning: gh CLI not available"
        fi
        
        # Check if all tasks for this issue are complete
        # Find all task refs for this issue number
        pending_tasks=$(git for-each-ref "refs/heads/tasks/pending/${issue_num}" --format='%(objectname)' 2>/dev/null || true)
        frontier_tasks=$(git for-each-ref "refs/heads/tasks/frontier/" --format='%(objectname)' 2>/dev/null | while read sha; do
            issue=$(get_issue_number "$sha")
            if [ "$issue" = "$issue_num" ]; then
                echo "$sha"
            fi
        done)
        
        all_tasks="${pending_tasks}${frontier_tasks:+ }${frontier_tasks}"
        
        if [ -z "$all_tasks" ]; then
            echo "  All tasks complete for issue #$issue_num - closing issue"
            
            if command -v gh &> /dev/null; then
                gh issue close "$issue_num" --comment "All tasks completed. Epic is complete." && \
                    echo "  ✓ Closed issue #$issue_num"
            fi
        else
            echo "  Still pending tasks for issue #$issue_num"
        fi
    done
done

echo "Task completion check complete"
