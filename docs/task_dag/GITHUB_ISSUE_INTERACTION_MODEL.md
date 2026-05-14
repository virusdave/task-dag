# GitHub Issue ↔ Task-DAG Interaction Model

**Status**: Design Proposal  
**Created**: 2026-05-14  
**Thread**: T-9d941a74-0041-49f6-889f-862d5878c9f4

## Executive Summary

This document proposes a comprehensive bidirectional communication model between GitHub Issues (the human interface) and the Git-DAG task management system (the work tracking backend). The goal is to enable natural human-agent collaboration through issue comments while maintaining rigorous work tracking in the task-dag system.

## Core Principles

1. **GitHub Issues as Primary UI** - All human-agent interaction happens through GitHub issues and comments
2. **Task-DAG as Source of Truth** - All work, messages, and state changes are mirrored as task commits in the Git-DAG
3. **Bidirectional Sync** - Changes flow both directions: Issue→DAG and DAG→Issue
4. **Conversation Threading** - Reply chains are tracked via metadata and refs
5. **Natural Workflow** - Agents can ask questions, humans can respond, work continues seamlessly

## Task Types

All tasks are metadata-only commits (empty tree) differentiated by YAML metadata:

### Task Kinds

| Kind | Purpose | Example |
|------|---------|---------|
| `epic` | Root task for a GitHub issue | Issue #42: "Implement search" |
| `work` | Actual implementation subtasks | "Add Elasticsearch integration" |
| `message` | Human or agent comments | "What's the latency budget?" |
| `state-change` | Issue state updates | Issue closed, labeled, etc. |

### Roles

| Role | Who | When |
|------|-----|------|
| `human` | Human user | Issue creation, comments |
| `agent` | AI agent | Status updates, questions, completion |
| `system` | GitHub Action | State changes, sync operations |

### Message Intents

For `kind: message` tasks:

| Intent | Description | Example |
|--------|-------------|---------|
| `question` | Agent asking for clarification | "Should we cache results?" |
| `answer` | Human responding | "Yes, cache for 1 hour" |
| `status` | Agent progress update | "Completed phase 1 of 3" |
| `blocker` | Agent stuck | "Need API credentials" |
| `completion` | Agent finished | "Task complete, ready for review" |
| `direction` | Human changing direction | "Actually, let's use Redis instead" |
| `clarification` | Human providing details | "Use the /v2 API endpoint" |
| `note` | General comment | "Great work on this!" |

## Metadata Format

Every task commit uses YAML in the commit message:

```yaml
kind: epic | work | message | state-change
role: human | agent | system
intent: <see tables above>

issue:
  repo: owner/repo
  number: 123
  title: "Issue title"           # epics only
  url: "https://github.com/..."

github:
  actor: username
  comment_id: 1234567890          # for mirrored comments
  url: "https://github.com/..."   # comment URL

conversation:
  logical_task: <sha>              # work task this relates to
  reply_to: <sha>                  # previous message task (threading)
  thread_root: <sha>               # first message in this thread

flags:
  post_to_github: true | false     # should this be posted as comment?

body: |
  Free-form text content
  (issue body or comment text)
```

## Reference Structure

Lightweight refs map between GitHub and task-dag:

```
refs/heads/tasks/pending/<N>           # Epic task for issue #N (existing)
refs/gh/issues/<N>                     # → epic task SHA (quick lookup)
refs/gh/comments/<N>/<comment_id>      # → message task SHA (per comment)
refs/task-messages/sent/<sha>          # Marks messages posted to GitHub
```

These enable bidirectional lookups without commit graph traversal.

## Interaction Workflows

### 1. Human Creates Issue

**Trigger**: `issues.opened`

1. GitHub Action detects new issue
2. Creates `epic` task commit:
   - `kind: epic`, `role: human`
   - Body = issue description
   - Primary parent = current master
3. Creates refs:
   - `refs/heads/tasks/pending/<N>` → epic SHA
   - `refs/gh/issues/<N>` → epic SHA
4. Comments on issue with task SHA

**Example Epic Task**:
```yaml
kind: epic
role: human
intent: issue
issue:
  repo: FreshlyBakedNYC/automation
  number: 9
  title: "Test issue-comment interaction model"
  url: "https://github.com/FreshlyBakedNYC/automation/issues/9"
github:
  actor: virusdave
conversation:
  logical_task: null
  reply_to: null
  thread_root: null
flags:
  post_to_github: false
body: |
  Let's test the new interaction model...
```

### 2. Human Adds Comment

**Trigger**: `issue_comment.created`

1. **Anti-loop check**: Skip if comment has `<!-- task-dag: task=<sha> -->` marker (agent-generated)
2. Resolve epic: `epic_sha = refs/gh/issues/<N>`
3. **Detect reply context**:
   - Parse comment for quoted GitHub comment URL
   - If found: `reply_to_sha = refs/gh/comments/<N>/<comment_id>`
   - Else: Find last agent message on this issue
4. Create `message` task commit:
   - `kind: message`, `role: human`
   - Primary parent = epic
   - Optional non-primary parent = `reply_to_sha` (for graph threading)
   - Metadata includes `conversation.reply_to` and `thread_root`
5. Create ref: `refs/gh/comments/<N>/<comment_id>` → message SHA
6. **Mark as frontier**: `refs/heads/tasks/frontier/<sha>` if this is a work request

**Example Human Comment Task**:
```yaml
kind: message
role: human
intent: clarification
issue:
  repo: FreshlyBakedNYC/automation
  number: 9
github:
  actor: virusdave
  comment_id: 2047395821
  url: "https://github.com/.../issues/9#issuecomment-2047395821"
conversation:
  logical_task: <epic_sha>
  reply_to: <previous_agent_question_sha>
  thread_root: <first_message_in_thread_sha>
flags:
  post_to_github: false
body: |
  Use Redis for caching, expire after 1 hour
```

### 3. Agent Posts Update/Question

**Agent Workflow**:

1. Agent creates message task commit via CLI:
   ```bash
   scripts/task-dag message create \
     --issue=9 \
     --intent=question \
     --reply-to=<human_comment_sha> \
     --body="Should we implement rate limiting?"
   ```

2. CLI creates commit with:
   - `kind: message`, `role: agent`
   - `flags.post_to_github: true`
   - Metadata includes conversation threading

3. Pushes to `refs/heads/tasks/messages/<sha>` or similar

**Example Agent Question Task**:
```yaml
kind: message
role: agent
intent: question
issue:
  repo: FreshlyBakedNYC/automation
  number: 9
github:
  actor: amp-agent
  comment_id: null                     # Not posted yet
conversation:
  logical_task: <work_task_sha>
  reply_to: <human_message_sha>
  thread_root: <thread_root_sha>
flags:
  post_to_github: true
body: |
  Should we implement rate limiting on the API endpoint?
  If so, what's the desired requests/minute threshold?
```

### 4. Sync Agent Messages to GitHub

**Trigger**: `push` to `refs/heads/tasks/**`

1. GitHub Action detects new task commits
2. For each commit:
   - Parse metadata
   - If `kind: message`, `role: agent`, `flags.post_to_github: true`:
     - Check if already posted: `refs/task-messages/sent/<sha>` exists?
     - If not:
       - Build comment body with hidden marker
       - Determine reply context from `conversation.reply_to`
       - Post to GitHub via API
       - Record mapping: `refs/gh/comments/<N>/<comment_id>` → SHA
       - Mark sent: `refs/task-messages/sent/<sha>`

**Posted Comment Format**:
```markdown
<!-- task-dag: task=abc123def456 -->

**[Agent Question]**

Should we implement rate limiting on the API endpoint?
If so, what's the desired requests/minute threshold?
```

The hidden HTML comment prevents loop creation when the comment appears.

### 5. Human Replies to Agent

Cycle back to workflow #2 - human comment creates new message task, linked via `conversation.reply_to` to the agent's question.

## Agent CLI Commands

New commands for `scripts/task-dag`:

### Create Message

```bash
task-dag message create \
  --issue=<N> \
  --intent=<question|status|blocker|completion|note> \
  --reply-to=<sha> \              # Optional
  --work-task=<sha> \             # Optional, defaults to epic
  --body="Message text"
```

Creates message task and marks for GitHub posting.

### Update Task Status with Message

```bash
task-dag message post \
  --task=<work_task_sha> \
  --intent=status \
  --body="Completed phase 1, starting phase 2"
```

Updates work task and posts status to issue.

### Ask Question (Shorthand)

```bash
task-dag ask \
  --issue=<N> \
  --body="What's the API key for production?"
```

Creates question message, posts to GitHub, and marks work task as blocked.

## GitHub Actions Required

### New Workflows

1. **`.github/workflows/sync-comments-to-tasks.yml`**
   - Trigger: `issue_comment.created`
   - Creates message tasks from human comments
   - Handles reply threading

2. **`.github/workflows/sync-tasks-to-comments.yml`**
   - Trigger: `push` to `refs/heads/tasks/**`
   - Posts agent message tasks to GitHub
   - Tracks sent messages

3. **`.github/workflows/sync-issue-state.yml`**
   - Trigger: `issues.closed`, `issues.reopened`, `issues.labeled`
   - Creates state-change tasks

### Scripts

1. **`scripts/sync-comment-to-tasks.sh`**
   - Core logic for comment→task conversion
   - Reply detection and threading

2. **`scripts/sync-tasks-to-github.sh`**
   - Core logic for task→comment posting
   - Idempotency via sent refs

3. **`scripts/task-dag message`**
   - CLI subcommand for message operations

## Example Interaction Flow

```
Human (Issue #9 body):
  "Implement search with caching"
  
  → Epic task created at refs/heads/tasks/pending/9

Agent (starts work):
  $ task-dag ask --issue=9 --body="What's the cache TTL?"
  
  → Message task created, posted to issue
  → "**[Agent Question]** What's the cache TTL?"

Human (comment reply):
  "Use 1 hour TTL"
  
  → Message task created, refs/gh/comments/9/123 → task SHA
  → conversation.reply_to points to agent's question

Agent (continues work):
  $ task-dag message post --intent=status \
      --body="Implemented caching with 1hr TTL"
  
  → Message task posted to issue
  → "**[Agent Status]** Implemented caching with 1hr TTL"

Agent (completes):
  $ task-dag complete <work_task_sha>
  $ task-dag message post --intent=completion \
      --body="Search implementation complete, tests passing"
  
  → Completion message posted
  → Work task linked to epic

Human (verifies and closes):
  Closes issue #9
  
  → State-change task created: kind=state-change, intent=closed
```

## Implementation Phases

### Phase 1: Comment→Task Sync (This PR)
- ✅ GitHub Action for `issue_comment.created`
- ✅ Create message tasks from comments
- ✅ Basic reply detection (quoted URLs)
- ✅ Ref mapping: `refs/gh/comments/<N>/<id>`

### Phase 2: Task→Comment Sync
- GitHub Action for push to task refs
- Post agent messages to GitHub
- Idempotency tracking
- Comment formatting with intent prefixes

### Phase 3: Agent CLI
- `task-dag message` subcommand
- `task-dag ask` shorthand
- Integration with work tasks

### Phase 4: Advanced Features
- State-change tasks for labels, assignees
- Automatic frontier marking for work-request comments
- Conversation threading in UI
- Rich message formatting (code blocks, tables, etc.)

## Security & Anti-Loop Measures

1. **Hidden Marker**: Agent comments include `<!-- task-dag: task=<sha> -->` to prevent re-ingestion
2. **Sent Refs**: `refs/task-messages/sent/<sha>` prevents duplicate posting
3. **Comment ID Mapping**: `refs/gh/comments/<N>/<id>` prevents duplicate task creation
4. **Role Validation**: Only `role: agent` + `flags.post_to_github: true` are posted

## Benefits

1. **Natural Communication**: Humans use familiar GitHub interface
2. **Full Traceability**: Every interaction tracked in task-dag
3. **Async Collaboration**: Agents can pause and ask questions
4. **Conversation History**: Reply chains preserved in metadata
5. **Work Continuity**: Human responses automatically create tasks for agents
6. **Audit Trail**: Complete log of who said what, when
7. **Git-Native**: All data in commits and refs, no external DB

## Open Questions

1. **Automatic Frontier**: Should every human comment auto-create a frontier task, or require explicit "this is work" detection?
2. **Subtask Creation**: How should agents break down epics vs. having humans do it via comments?
3. **Privacy**: Should some comments be marked as "internal" and not synced?
4. **Rate Limiting**: GitHub API limits on comment creation?
5. **Large Comments**: How to handle very long issue descriptions or comments?

## Next Steps

1. Review this design (you're reading it now!)
2. Test interaction model on Issue #9
3. Implement Phase 1 (Comment→Task sync)
4. Test with real agent workflow
5. Iterate based on learnings
6. Implement remaining phases

---

**Ready for Review**: Please comment on [Issue #9](https://github.com/FreshlyBakedNYC/automation/issues/9) with feedback, questions, or approval to proceed with implementation.
