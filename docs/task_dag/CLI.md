# Task DAG CLI Reference

## Installation

The `task-dag` CLI is located at `scripts/task-dag` in the automation repository.

Add it to your PATH for convenience:
```bash
export PATH="/home/amp-local/src/automation/scripts:$PATH"
```

Or use it directly:
```bash
/home/amp-local/src/automation/scripts/task-dag <command>
```

## Commands

### `task-dag frontier`

List all available leaf tasks ready to be picked up.

**Usage:**
```bash
task-dag frontier [--json] [--issue=N] [--status=STATUS]
```

**Options:**
- `--json` - Output in JSON format
- `--issue=N` - Filter by GitHub issue number
- `--status=STATUS` - Filter by status (pending, in-progress, blocked, done)

**Examples:**
```bash
# List all frontier tasks
task-dag frontier

# Get frontier tasks for issue #23 in JSON
task-dag frontier --issue=23 --json

# Find all blocked tasks
task-dag frontier --status=blocked
```

**Output (human-readable):**
```
SHA          TITLE                                              ISSUE        STATUS  
============ ================================================== ============ ========
abc1234      Implement user authentication                      #5           pending 
def5678      Add database migration script                      #5           pending 
```

**Output (JSON):**
```json
[
  {
    "sha": "abc1234567890...",
    "shortSha": "abc1234",
    "title": "Implement user authentication",
    "issue": 5,
    "status": "pending"
  }
]
```

### `task-dag show`

Show detailed information about a specific task.

**Usage:**
```bash
task-dag show <sha-or-ref> [--json]
```

**Examples:**
```bash
# Show task details
task-dag show abc1234

# Show task with full SHA
task-dag show abc1234567890abcdef1234567890abcdef123456

# Show task by ref
task-dag show refs/heads/tasks/pending/1

# Get JSON output
task-dag show abc1234 --json
```

**Output:**
```
Task: Implement user authentication
SHA:  abc1234567890abcdef1234567890abcdef123456
Issue: #5
Author: dave
Status: pending
Type: task
Refs:
  - tasks/frontier/abc1234
Parent: def5678567890abcdef1234567890abcdef123456
Dependencies:
  ✓ ghi9012 - Set up database schema
  ✗ jkl3456 - Configure auth provider (PENDING)

○ Task pending
```

### `task-dag deps`

Show and verify task dependencies.

**Usage:**
```bash
task-dag deps <sha> [--json] [--check-complete]
```

**Options:**
- `--json` - Output in JSON format
- `--check-complete` - Exit with code 2 if any dependency is not met (useful for agents)

**Exit Codes:**
- `0` - Success (all dependencies met if --check-complete)
- `1` - Error (invalid arguments)
- `2` - Dependencies not met (only with --check-complete)

**Examples:**
```bash
# Show dependencies
task-dag deps abc1234

# Check if ready to start (for agents)
if task-dag deps abc1234 --check-complete; then
  echo "Ready to start!"
else
  echo "Dependencies not met"
fi
```

### `task-dag dag`

Show the task DAG hierarchy for an epic or task.

**Usage:**
```bash
task-dag dag <ref-or-sha> [--json] [--depth=N]
```

**Options:**
- `--json` - Output in JSON format (not yet implemented)
- `--depth=N` - Limit depth of DAG display

**Examples:**
```bash
# Show DAG for GitHub issue #1
task-dag dag refs/heads/tasks/pending/1

# Show DAG for a task
task-dag dag abc1234

# Limit depth
task-dag dag refs/heads/tasks/pending/1 --depth=3
```

### `task-dag complete`

Mark a task as complete by creating a completion commit.

**Usage:**
```bash
task-dag complete <task-sha> [--commit=SHA] [--no-cleanup]
```

**Options:**
- `--commit=SHA` - Use this commit as base (default: HEAD)
- `--no-cleanup` - Don't delete frontier/active refs

**Exit Codes:**
- `0` - Success
- `1` - Error
- `2` - Dependencies not met

**Examples:**
```bash
# Complete a task (current HEAD)
task-dag complete abc1234

# Complete with specific commit
task-dag complete abc1234 --commit=def5678

# Complete but keep refs for inspection
task-dag complete abc1234 --no-cleanup
```

**What it does:**
1. Verifies all dependencies are met
2. Creates a new commit with:
   - Same tree as base commit
   - Primary parent: base commit
   - Secondary parent: task commit (links task to code)
   - Updated message with `Task-Commit: <sha>`
3. Resets HEAD to new commit
4. Deletes `tasks/frontier/<short-sha>` and `tasks/active/<short-sha>` refs

### `task-dag validate`

Validate the integrity of the task DAG structure.

**Usage:**
```bash
task-dag validate [scope] [--json]
```

**Checks:**
- All task commits have empty tree
- Frontier refs point to leaf/task types
- Parent relationships are valid

**Exit Codes:**
- `0` - Validation passed
- `3` - Validation failed

**Examples:**
```bash
# Validate entire DAG
task-dag validate

# Get JSON output for CI
task-dag validate --json
```

**Output:**
```
Validating task DAG structure...

✓ Validation passed (0 warnings)
```

### `task-dag breakdown`

Create subtasks from a JSON specification.

**Usage:**
```bash
task-dag breakdown <parent-sha> [--spec-file=PATH | --stdin-json]
```

**Spec Format:**
```json
[
  {
    "title": "Task title",
    "description": "Detailed description",
    "dependencies": ["<sha1>", "<sha2>"],
    "type": "task|leaf",
    "status": "pending"
  }
]
```

**Examples:**
```bash
# Break down from file
task-dag breakdown abc1234 --spec-file=breakdown.json

# Break down from stdin
echo '[{"title":"First task","type":"leaf"}]' | task-dag breakdown abc1234 --stdin-json
```

**Note:** This command is a placeholder for agent integration. Manual task creation is currently done with `git commit-tree`.

## Agent Integration

### JSON Output Contract

All commands supporting `--json` output stable, versioned JSON schemas:

**Frontier:**
```typescript
Array<{
  sha: string;
  shortSha: string;
  title: string;
  issue?: number;
  status: string;
}>
```

**Show/Task Detail:**
```typescript
{
  sha: string;
  shortSha: string;
  title: string;
  issue?: string;
  author?: string;
  status: string;
  type: string;
  parentTask?: string;
  firstParent?: string;
  dependencies: string[];
  refs: string[];
  completed: boolean;
}
```

**Dependencies:**
```typescript
{
  dependencies: Array<{
    sha: string;
    shortSha: string;
    title: string;
    completed: boolean;
  }>;
  allMet: boolean;
}
```

### Exit Code Contract

Agents MUST check exit codes before parsing JSON:

- `0` - Success
- `1` - User error (bad arguments, missing SHA)
- `2` - Logical error (dependencies unmet)
- `3` - Validation error (DAG invariant broken)
- `>=10` - Internal/tool failure

### Example Agent Workflow

```bash
#!/bin/bash
# Agent picking up a task

# 1. Find available work
TASKS=$(task-dag frontier --json)
TASK_SHA=$(echo "$TASKS" | jq -r '.[0].sha')

if [ -z "$TASK_SHA" ]; then
  echo "No tasks available"
  exit 0
fi

# 2. Check dependencies
if ! task-dag deps "$TASK_SHA" --check-complete >/dev/null 2>&1; then
  echo "Dependencies not met for $TASK_SHA"
  exit 0
fi

# 3. Mark as active
SHORT_SHA=$(git rev-parse --short "$TASK_SHA")
git update-ref "refs/heads/tasks/active/$SHORT_SHA" "$TASK_SHA"
git push origin "refs/heads/tasks/active/$SHORT_SHA"

# 4. Do the work
# ... implement the task on master ...
git add .
git commit -m "Implement feature X"

# 5. Mark complete
task-dag complete "$TASK_SHA"
git push origin master

# 6. Cleanup is automatic (task-dag complete deletes frontier ref)
```

## Tips and Tricks

### Find all tasks for an epic

```bash
# Using git log
git log --graph --oneline --all --ancestry-path <epic-sha>..refs/heads/tasks/frontier/

# Or traverse with show
task-dag show <epic-sha> --json | jq -r '.breakdownChildren[]' | while read child; do
  task-dag show "$child"
done
```

### Check completion status

```bash
# See if a task appears in master history
TASK_SHA=abc1234
git log --all --format='%P' | grep -q "$TASK_SHA" && echo "Complete" || echo "Pending"
```

### List all epics

```bash
git for-each-ref refs/heads/tasks/pending/ --format='%(refname:short) %(objectname:short)'
```

### Find tasks by status

```bash
git for-each-ref refs/heads/tasks/ --format='%(objectname)' | while read sha; do
  STATUS=$(git log -1 "$sha" --format='%B' | grep '^Status:' | cut -d: -f2)
  [ "$STATUS" = " pending" ] && echo "$sha: $(task-dag show "$sha" --json | jq -r '.title')"
done
```

## Troubleshooting

### "Cannot resolve" error

The SHA or ref doesn't exist. Check:
```bash
git rev-parse <sha-or-ref>
```

### Task not showing in frontier

Check if it has a frontier ref:
```bash
git for-each-ref refs/heads/tasks/frontier/ --points-at <sha>
```

### Dependencies always showing as unmet

The dependency task must appear as a non-primary parent in master history. Verify:
```bash
git log --all --format='%H %P' | grep <dependency-sha>
```

If missing, the dependency task was never completed properly.

### Completion commit not working

Ensure you're on master and have committed changes:
```bash
git status
git log -1 --oneline
```

The completion commit amends HEAD with an additional parent.

## See Also

- [Full Task DAG Documentation](./README.md)
- [HOW_TASK_DAG_WORKS.md](../../HOW_TASK_DAG_WORKS.md)
- GitHub Action: [.github/workflows/issue-to-task.yml](../../.github/workflows/issue-to-task.yml)
