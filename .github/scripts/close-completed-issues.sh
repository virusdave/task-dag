#!/bin/bash
set -e

# For each commit in the push, check if it completes a task epic
for commit in $(git rev-list ${{ github.event.before }}..${{ github.sha }} 2>/dev/null || git rev-list HEAD~1..HEAD); do
  # Get all parents of this commit
  parents=($(git rev-list --parents -n 1 "$commit" | cut -d' ' -f2-))
  
  # If this is a merge commit (2+ parents), check if any parent is a task epic
  if [ ${#parents[@]} -ge 2 ]; then
    for parent in "${parents[@]:1}"; do
      # Check if this parent is a task commit at refs/heads/tasks/pending/*
      issue_num=$(git for-each-ref --points-at="$parent" 'refs/heads/tasks/pending/*' --format='%(refname:short)' | sed 's|tasks/pending/||')
      
      if [ -n "$issue_num" ]; then
        echo "Found completion of task epic for issue #$issue_num in commit $commit"
        
        # Close the issue
        gh issue close "$issue_num" --comment "Task epic completed in commit $commit" || true
        
        # Delete the remote task/pending ref
        git push origin --delete "refs/heads/tasks/pending/$issue_num" 2>/dev/null || true
      fi
    done
  fi
done
