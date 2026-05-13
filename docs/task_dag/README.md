# Git-DAG Task Management System - Full Documentation

## Overview

This system uses Git's commit DAG (directed acyclic graph) as a persistent, distributed, versioned task management system. Tasks are represented as metadata-only commits that extend beyond the "implementation frontier" (the actual code commits on master). This enables massively parallel agentic development with rich dependency tracking and automatic lineage preservation.

## Core Concepts

### Implementation Frontier

The **implementation frontier** is the current HEAD of master containing actual code (blobs, trees, and normal commits). This is where real development happens and where all traditional Git operations apply.

### Task Frontier

The **task frontier** consists of metadata-only commits that extend beyond the implementation frontier. These commits:
- Have empty tree hash: `4b825dc642cb6eb9a060e54bf8d69288fbee4904`
- Contain task metadata in the commit message
- Use parent relationships to encode task hierarchy and dependencies
- Are tracked by named refs (branches/tags) to serve as GC roots

### Metadata Commit Structure

Each task is represented as a Git commit with:

**Tree**: Always the empty tree (no blobs)

**Parents**:
- **First parent**: The "breakdown parent" - either:
  - The implementation frontier (for root tasks)
  - The parent task that this task is a subtask of
  - The root commit (special marker for grouping/epic commits)
  
- **Second+ parents**: Dependency parents - tasks that must be completed before this task can begin

**Commit Message Format**:
```
Task: <human-readable title>

Issue: #<github-issue-number>
Author: <creator>
URL: <github-issue-url>
Status: pending|in-progress|blocked|done
Type: epic|task|leaf
Parent-Task: <commit-sha-of-parent-task>
Dependencies: <comma-separated-commit-shas>

<detailed description>
```

**Named Refs**:
- `refs/heads/tasks/pending/<issue-number>` - Pending epic-level tasks from GitHub issues
- `refs/heads/tasks/epic/<epic-name>` - Named epic groupings
- `refs/heads/tasks/active/<task-id>` - Tasks currently being worked on
- `refs/heads/tasks/frontier/<task-sha-short>` - Leaf-level tasks ready to be picked up

## Parent Ordering Convention

The order of parents in a metadata commit has semantic meaning:

1. **First parent (index 0)**: Breakdown relationship
   - For epic/grouping commits: points to root commit (00000...) to distinguish them
   - For task commits: points to the parent task this breaks down
   - For leaf commits: points to the immediate parent task
   
2. **Second+ parents (index 1+)**: Dependencies
   - Each additional parent is a task that must complete before this one can start
   - Dependencies can be in any order (no semantic ordering among them)

### Example DAG Structure

```
master (implementation frontier)
    ↓
[Epic: Build Task DAG System] ← refs/heads/tasks/pending/1
    ↓ (1st parent = breakdown)
    ├─ [Task: Create GitHub Action] ← refs/heads/tasks/epic/task-dag/gh-action
    │   ↓
    │   └─ [Leaf: Write workflow YAML] ← refs/heads/tasks/frontier/abc1234
    │
    ├─ [Task: Build task tooling] ← refs/heads/tasks/epic/task-dag/tooling
    │   ↓ (depends on GitHub Action via 2nd parent)
    │   ├─ 1st parent: [Task: Build task tooling]
    │   └─ 2nd parent: [Task: Create GitHub Action]
    │   ↓
    │   └─ [Leaf: Write task query script] ← refs/heads/tasks/frontier/def5678
    │
    └─ [Task: Write documentation] ← refs/heads/tasks/epic/task-dag/docs
        ↓
        └─ [Leaf: Write HOW_TASK_DAG_WORKS.md] ← refs/heads/tasks/frontier/ghi9012
```

## Task Lifecycle

### 1. Task Creation (from GitHub Issue)

When a GitHub issue is created/edited:
1. GitHub Action triggers (`.github/workflows/issue-to-task.yml`)
2. Script creates metadata commit with issue details
3. Branch created at `refs/heads/tasks/pending/<issue-number>`
4. Comment posted to issue with commit SHA and branch

### 2. Task Breakdown (Recursive Subdivision)

An agent picks up an epic/task and breaks it down:

```bash
# 1. Find the pending task
EPIC_SHA=$(git rev-parse refs/heads/tasks/pending/1)

# 2. Create subtasks as metadata commits
# First subtask (no dependencies)
SUBTASK1=$(git commit-tree $(git hash-object -t tree /dev/null) \
  -p $EPIC_SHA \
  -m "Task: Create GitHub Action

Parent-Task: $EPIC_SHA
Status: pending
Type: task

Implement workflow to convert issues to task commits")

# Second subtask (depends on first)
SUBTASK2=$(git commit-tree $(git hash-object -t tree /dev/null) \
  -p $EPIC_SHA \
  -p $SUBTASK1 \
  -m "Task: Build task tooling

Parent-Task: $EPIC_SHA
Dependencies: $SUBTASK1
Status: pending
Type: task

Create CLI/scripts for querying and managing task frontier")

# 3. Create named refs for subtasks
git update-ref refs/heads/tasks/epic/task-dag/gh-action $SUBTASK1
git update-ref refs/heads/tasks/epic/task-dag/tooling $SUBTASK2

# 4. Mark epic as broken down (update status in new commit or tag)
```

Continue breaking down tasks until reaching **leaf-level tasks** - tasks simple enough for a limited-capability agent to complete in one session (~30 min to 2 hours of work).

### 3. Leaf Task Identification

A task is a **leaf** when:
- It can be completed by reviewing the ancestry chain for context
- It requires no further planning or architecture decisions
- It can be implemented with straightforward code changes
- Estimated effort < 2 hours for a basic agent

Leaf tasks get tagged as `refs/heads/tasks/frontier/<short-sha>`.

### 4. Task Assignment and Execution

An agent picks up a leaf task:

```bash
# 1. Query the frontier
git for-each-ref refs/heads/tasks/frontier/ --format='%(objectname) %(refname:short)'

# 2. Pick a task (check dependencies are met)
TASK_SHA=<chosen-task-sha>

# 3. Walk ancestry to understand context
git log --graph --oneline $TASK_SHA

# 4. Check dependencies via parent commits
git rev-list --parents $TASK_SHA -1 | awk '{for(i=3;i<=NF;i++) print $i}'

# 5. Verify all dependencies are complete (have completion commits on master)
# (Check if dependency task SHA appears as non-primary parent of any commit on master)

# 6. Mark task as in-progress
git update-ref refs/heads/tasks/active/$(git rev-parse --short $TASK_SHA) $TASK_SHA
git push origin refs/heads/tasks/active/$(git rev-parse --short $TASK_SHA)

# 7. Do the work on master branch
# ... make code changes ...
# ... commit to master ...

# 8. Create completion commit linking back to task
COMPLETION_SHA=$(git rev-parse HEAD)
git commit --allow-empty -m "Complete task: <task-title>

Task-Commit: $TASK_SHA
" --amend --allow-empty-message

# Actually, better: Make the completion commit reference the task as 2nd parent
# This requires creating a new commit that merges the task metadata:
FINAL_COMMIT=$(git commit-tree $(git rev-parse HEAD^{tree}) \
  -p HEAD \
  -p $TASK_SHA \
  -m "$(git log -1 --format=%B HEAD)

Task-Commit: $TASK_SHA")

git reset --hard $FINAL_COMMIT

# 9. Push to master
git push origin master

# 10. Clean up frontier ref
git push origin --delete refs/heads/tasks/frontier/$(git rev-parse --short $TASK_SHA)
git push origin --delete refs/heads/tasks/active/$(git rev-parse --short $TASK_SHA)
```

### 5. Completion and Lineage

When a task is completed:
1. The completion commit on master includes the task metadata commit as a non-primary parent
2. This creates auditable lineage: `git log --graph --all` shows which commits addressed which tasks
3. The task frontier ref is deleted (task is no longer pending)
4. Parent tasks can be checked: when all subtasks complete, parent task completes

## Task Queries

### Find all pending leaf tasks

```bash
git for-each-ref refs/heads/tasks/frontier/ --format='%(objectname:short) %(refname:short)'
```

### Find task details

```bash
TASK_SHA=<sha>
git log -1 $TASK_SHA --format=full
```

### Find task dependencies

```bash
TASK_SHA=<sha>
git rev-list --parents $TASK_SHA -1 | awk '{for(i=3;i<=NF;i++) print $i}' | while read dep; do
  echo "Dependency: $dep"
  git log -1 $dep --oneline
done
```

### Check if task dependencies are met

```bash
TASK_SHA=<sha>
git rev-list --parents $TASK_SHA -1 | awk '{for(i=3;i<=NF;i++) print $i}' | while read dep; do
  # Check if dependency appears as non-primary parent in master history
  if git log --all --format='%P' | grep -q $dep; then
    echo "✓ Dependency $dep completed"
  else
    echo "✗ Dependency $dep still pending"
  fi
done
```

### Reconstruct task hierarchy for an epic

```bash
EPIC_SHA=<epic-commit-sha>
git log --graph --oneline --all --ancestry-path $EPIC_SHA..refs/heads/tasks/frontier/*
```

### Find completion commit for a task

```bash
TASK_SHA=<sha>
# Find commits on master that have this task as a non-primary parent
git log --all --format='%H %P' | grep $TASK_SHA | awk '{print $1}' | while read commit; do
  git log -1 $commit --oneline
done
```

## Recursive Breakdown Workflow

When an agent is tasked with breaking down a GitHub issue:

### Step 1: Fetch the epic task commit

```bash
ISSUE_NUM=<github-issue-number>
EPIC_SHA=$(git rev-parse refs/heads/tasks/pending/$ISSUE_NUM)
```

### Step 2: Read the task description

```bash
git log -1 $EPIC_SHA --format='%B'
```

### Step 3: Plan the breakdown

- Identify major components/phases (these become task-level commits)
- Identify dependencies between components
- For each component, identify concrete steps (these may become leaf tasks or need further breakdown)

### Step 4: Create task commits

For each identified task:

```bash
PARENT_SHA=<parent-task-or-epic>
DEPS=<space-separated-dependency-shas>

# Build parent args
PARENT_ARGS="-p $PARENT_SHA"
for dep in $DEPS; do
  PARENT_ARGS="$PARENT_ARGS -p $dep"
done

TASK_SHA=$(git commit-tree $(git hash-object -t tree /dev/null) \
  $PARENT_ARGS \
  -m "Task: <title>

Parent-Task: $PARENT_SHA
Dependencies: $(echo $DEPS | tr ' ' ',')
Status: pending
Type: task

<description>")

# Create named ref if it's a significant task
git update-ref refs/heads/tasks/epic/<epic-name>/<task-name> $TASK_SHA
```

### Step 5: Determine if further breakdown needed

For each task created, evaluate:
- **Is this a leaf?** (Can be completed in < 2 hrs by basic agent)
  - YES → Tag as `refs/heads/tasks/frontier/<short-sha>` and push
  - NO → Recurse: break this task down further

### Step 6: Push all refs

```bash
git push origin 'refs/heads/tasks/**'
```

### Example Breakdown Script Structure

```bash
#!/bin/bash
# break-down-task.sh <task-sha> <max-depth>

TASK_SHA=$1
MAX_DEPTH=${2:-5}
CURRENT_DEPTH=${3:-0}

if [ $CURRENT_DEPTH -ge $MAX_DEPTH ]; then
  echo "Max depth reached for $TASK_SHA - marking as leaf"
  git update-ref refs/heads/tasks/frontier/$(git rev-parse --short $TASK_SHA) $TASK_SHA
  exit 0
fi

# Get task details
TASK_MSG=$(git log -1 $TASK_SHA --format='%B')

# Use LLM to break down task into subtasks
# (This would call an LLM with the task description and ask for breakdown)

# For each subtask returned by LLM:
#   - Create metadata commit
#   - Recursively call break-down-task.sh on new commit
#   - If LLM says it's a leaf, tag as frontier
```

## Agent Integration Points

### Low-capability agents (leaf task workers)

These agents:
- Query `refs/heads/tasks/frontier/` for available work
- Pick a task (optionally filtered by tag/area)
- Verify dependencies are met
- Execute the task (code changes on master)
- Create completion commit with task reference as non-primary parent
- Clean up frontier ref

### Medium-capability agents (task planners)

These agents:
- Take a task-level commit
- Break it down into 2-10 subtasks
- Create metadata commits for subtasks
- Determine if subtasks are leaves or need further breakdown
- Create appropriate refs

### High-capability agents (epic planners)

These agents:
- Take an epic from GitHub issue
- Perform architecture and design
- Break epic into major tasks/components
- Create dependency relationships
- Delegate to medium-capability agents for further breakdown

## Garbage Collection and Cleanup

### Completed Tasks

Once a task is referenced as a non-primary parent in a commit on master, its frontier ref is deleted. The task commit remains in the DAG but is no longer "active."

### Abandoned Tasks

Tasks that are no longer relevant:
- Delete the named ref: `git push origin --delete refs/heads/tasks/frontier/<sha>`
- The commit becomes unreachable and will be garbage collected by Git after ~30 days

### Pruning Old Task Commits

Periodically:
```bash
# Find task commits with no refs and not referenced by master
git for-each-ref --format='%(refname)' refs/heads/tasks/ | while read ref; do
  SHA=$(git rev-parse $ref)
  # Check if this task is completed (appears in master history)
  if git log --all --format='%P' | grep -q $SHA; then
    echo "Task $ref completed - can delete ref"
    # git push origin --delete $ref
  fi
done
```

## Helios Integration

The task DAG can be visualized in Helios UI:

- **Epic View**: Show all epics from GitHub issues with breakdown progress
- **Task Frontier View**: Show all available leaf tasks with dependency status
- **Progress View**: Show completed vs pending tasks for an epic
- **DAG Visualization**: Render the task graph with D3.js or similar

Helios can serve as the primary UI for:
- Viewing task status
- Triggering task breakdown
- Assigning tasks to agents
- Monitoring progress
- Paging humans when review/feedback needed

## Advanced Patterns

### Octopus Dependencies

A task can depend on many other tasks:

```bash
# Task with 5 dependencies
TASK_SHA=$(git commit-tree $(git hash-object -t tree /dev/null) \
  -p $PARENT \
  -p $DEP1 -p $DEP2 -p $DEP3 -p $DEP4 -p $DEP5 \
  -m "Task: Integration task requiring all subsystems")
```

### Cross-Epic Dependencies

Tasks from different epics can depend on each other:

```bash
# Epic 1: Frontend feature
FRONTEND_TASK=<sha>

# Epic 2: Backend API
BACKEND_TASK=<sha>

# Epic 1's subtask depends on Epic 2's task
INTEGRATION_TASK=$(git commit-tree $(git hash-object -t tree /dev/null) \
  -p $FRONTEND_TASK \
  -p $BACKEND_TASK \
  -m "Task: Wire frontend to new backend API")
```

### Rebasing Task Frontiers

When master advances significantly, task commits can be rebased forward:

```bash
# Current implementation frontier
NEW_HEAD=$(git rev-parse master)

# Rebase a task chain onto new HEAD
TASK_SHA=<old-task-sha>

# Note: Since task commits have empty trees, rebase should be safe
git rebase --onto $NEW_HEAD $(git merge-base $TASK_SHA master) $TASK_SHA --empty=keep
```

**Warning**: Rebasing octopus commits requires care. Test thoroughly.

## Troubleshooting

### Task commit got garbage collected

- Ensure named refs exist for all active tasks
- Check `git reflog` to recover lost commits
- Re-create task commit if needed

### Dependencies not recognized

- Verify parent ordering (1st = breakdown, 2nd+ = dependencies)
- Check that dependency commits haven't been rebased (SHAs changed)
- Use `git rev-list --parents` to inspect parent relationships

### Workflow not triggering

- Ensure workflow file is on default branch (master)
- Check GitHub Actions is enabled for repo
- Add `workflow_dispatch` trigger for manual testing
- Check Actions tab for errors

### Empty tree hash not working

The empty tree hash should be: `4b825dc642cb6eb9a060e54bf8d69288fbee4904`

You can always generate it:
```bash
git hash-object -t tree /dev/null
```

## Reference Commands

### Create empty tree metadata commit

```bash
EMPTY_TREE=$(git hash-object -t tree /dev/null)
PARENT=$(git rev-parse HEAD)
COMMIT_SHA=$(git commit-tree $EMPTY_TREE -p $PARENT -m "Task: Example task")
```

### Query all task refs

```bash
git for-each-ref refs/heads/tasks/ --format='%(refname:short) %(objectname:short)'
```

### Show task commit details

```bash
git show --no-patch --format=fuller <task-sha>
```

### Find tasks by status

```bash
git for-each-ref refs/heads/tasks/ --format='%(objectname)' | while read sha; do
  if git log -1 $sha --format='%B' | grep -q "Status: pending"; then
    echo "$sha: $(git log -1 $sha --oneline)"
  fi
done
```

## Next Steps

1. Create tooling for common operations (query, breakdown, complete)
2. Integrate with Helios for visualization
3. Build agent orchestration to automatically pick up and execute leaf tasks
4. Implement automatic breakdown using progressively less-capable LLMs
5. Add metrics and monitoring (task velocity, agent utilization, etc.)
