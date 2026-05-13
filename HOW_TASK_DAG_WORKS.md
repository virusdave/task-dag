# HOW_TASK_DAG_WORKS

## TL;DR

Tasks are metadata-only Git commits beyond the implementation frontier. GitHub issues → epic commits → recursive breakdown → leaf tasks. Agents pick up leaves, complete work on master, link back via non-primary parent. All tracked in Git DAG with named refs as GC roots.

## Quick Reference

**Full docs**: [`docs/task_dag/README.md`](./docs/task_dag/README.md)

**GitHub Action**: `.github/workflows/issue-to-task.yml` creates task commits from issues

**Task refs**:
- `refs/heads/tasks/pending/<N>` - Epic from GitHub issue #N
- `refs/heads/tasks/frontier/<sha>` - Leaf task ready to work
- `refs/heads/tasks/active/<sha>` - Task currently being worked

**Empty tree hash**: `4b825dc642cb6eb9a060e54bf8d69288fbee4904`

## Parent Ordering Convention

1st parent = breakdown (parent task or master HEAD)  
2nd+ parents = dependencies (tasks that must complete first)

## Task Lifecycle

1. **GitHub issue created** → Action creates epic commit at `tasks/pending/<N>`
2. **Agent breaks down epic** → Creates task commits with 1st parent = epic
3. **Agent breaks down tasks** → Creates subtask/leaf commits
4. **Leaf identified** → Tagged as `tasks/frontier/<sha>`
5. **Agent picks leaf** → Verifies dependencies, does work on master
6. **Work committed** → Completion commit references task via non-primary parent
7. **Frontier ref deleted** → Task marked complete

## Critical Commands

### Query available leaf tasks
```bash
git for-each-ref refs/heads/tasks/frontier/ --format='%(objectname:short) %(refname:short)'
```

### Create metadata commit
```bash
EMPTY=$(git hash-object -t tree /dev/null)
PARENT=$(git rev-parse HEAD)  # or parent task SHA
git commit-tree $EMPTY -p $PARENT -m "Task: Title

Status: pending
Type: task

Description"
```

### Check task dependencies
```bash
git rev-list --parents <task-sha> -1 | awk '{for(i=3;i<=NF;i++) print $i}'
```

### Complete task (link from master commit)
```bash
# After committing work to master
TASK_SHA=<task-commit>
FINAL=$(git commit-tree $(git rev-parse HEAD^{tree}) \
  -p HEAD \
  -p $TASK_SHA \
  -m "$(git log -1 --format=%B HEAD)

Task-Commit: $TASK_SHA")
git reset --hard $FINAL
git push origin master
git push origin --delete refs/heads/tasks/frontier/$(git rev-parse --short $TASK_SHA)
```

## When to Use

- Multi-agent parallel development with dependency tracking
- Breaking down large GitHub issues into executable work
- Maintaining auditable lineage of what commits addressed which tasks
- Distributed task management without external PM tools

## When NOT to Use

- Simple single-agent linear work (just commit to master)
- Tasks with no dependencies or breakdown needed
- Rapid prototyping where task tracking overhead isn't worth it

## Agent Workflow Templates

### High-capability: Break down GitHub issue epic
1. Fetch epic: `git rev-parse refs/heads/tasks/pending/<N>`
2. Read it: `git log -1 <epic-sha> --format='%B'`
3. Plan major tasks/components
4. Create task commits (1st parent = epic, 2nd+ = dependencies between tasks)
5. For each task, recurse or mark as leaf
6. Push: `git push origin 'refs/heads/tasks/**'`

### Medium-capability: Break down task into subtasks
1. Fetch task: `git rev-parse refs/heads/tasks/epic/<name>`
2. Read it: `git log -1 <task-sha> --format='%B'`
3. Plan 2-10 concrete subtasks
4. Create subtask commits (1st parent = this task, 2nd+ = dependencies)
5. Tag leaves as `tasks/frontier/<sha>`
6. Push refs

### Low-capability: Execute leaf task
1. Query frontier: `git for-each-ref refs/heads/tasks/frontier/`
2. Pick task, verify dependencies met
3. Mark active: `git update-ref refs/heads/tasks/active/<sha> <task-sha>`
4. Do work on master (code changes, commits)
5. Link completion: amend last commit to include task SHA as non-primary parent
6. Push master
7. Delete frontier ref

## Metadata Commit Message Format

```
Task: <human-readable title>

Issue: #<N>
Author: <who-created>
URL: <github-url>
Status: pending|in-progress|blocked|done
Type: epic|task|leaf
Parent-Task: <sha>
Dependencies: <sha1>,<sha2>,...

<detailed description>
```

## Integration with Existing Workflow

- **Commits**: This doesn't change how you commit code to master
- **Branches**: Master remains linear; task refs live in `refs/heads/tasks/**`
- **Helios**: Can visualize task DAG, show frontier, track progress
- **AGENTS.md rules**: Task breakdown and completion still follow commit authority rules
- **Handoff**: `AGENT_TODO.md` can reference task SHAs for context

## Cleanup

**Completed tasks**: Delete frontier ref, task commit stays in DAG for lineage

**Abandoned tasks**: `git push origin --delete refs/heads/tasks/frontier/<sha>`

**GC**: Unreferenced task commits are pruned by Git after refs deleted (~30 days)

## Troubleshooting

**Workflow not triggering**: Ensure `.github/workflows/issue-to-task.yml` is on master branch

**Task disappeared**: Check `git reflog`, ensure named refs exist

**Dependencies wrong**: Verify parent order with `git rev-list --parents <sha> -1`

**Empty tree issues**: Use `git hash-object -t tree /dev/null`

## See Also

- Full documentation: [`docs/task_dag/README.md`](./docs/task_dag/README.md)
- GitHub Action: [`.github/workflows/issue-to-task.yml`](./.github/workflows/issue-to-task.yml)
- Task creation script: [`.github/scripts/create-task-commit.sh`](./.github/scripts/create-task-commit.sh)
