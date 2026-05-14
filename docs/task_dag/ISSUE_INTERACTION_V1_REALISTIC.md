# GitHub Issue ↔ Task-DAG Interaction Model (Realistic V1)

**Status**: Design Proposal (Critically Evaluated)  
**Created**: 2026-05-14  
**Thread**: T-9d941a74-0041-49f6-889f-862d5878c9f4

## Executive Summary

This document proposes a **constrained, realistic V1** for using GitHub Issues as a human-agent collaboration interface. Unlike the initial idealized design, this version acknowledges hard limits and builds defensively around them.

**Position**: This is an **async co-pilot for issues**, not live chat. Treat it as bootstrap infrastructure that will be replaced with a proper backend when we hit scale.

## Critical Constraints (What We Learned)

Oracle's critical assessment identified these hard limits:

### 1. **GitHub API Rate Limits**
- Free tier: ~5,000 requests/hour per token
- Budget ~10 API calls per conversational turn
- **Realistic capacity: ~500 turns/hour across all repos**
- **Will hit limits with 50 active issues or chatty conversations**

### 2. **Actions Latency**
- Typical: 10-60 seconds cold start
- Degraded: minutes
- **This is NOT interactive chat**
- Acceptable only for async "ticket assistant" workflow

### 3. **Failure Modes Are Real**
- Actions can be down (silent stall)
- Webhooks can be missed (lost comments)
- API calls can fail mid-transaction (orphaned state)
- Refs can get out of sync with comments

### 4. **Scale Ceilings**
- 100+ comments per issue → scroll-fest, no threading
- Multiple parallel agents → race conditions
- Large logs/code → hit comment size limits (64KB)
- 1000s of refs → performance degradation

### 5. **UX Will Degrade**
- Bot comments feel like spam at volume
- No native threading → confusion
- Lag makes it feel broken for interactive use
- Notification fatigue

## V1 Design: Constrained & Defensive

### Positioning

**What this IS:**
- Async work request and status update system
- Lightweight agent question/answer via issues
- Audit trail for agent work tied to human issues

**What this is NOT:**
- Real-time chat with agents
- High-volume conversational AI
- Production-grade system for 100s of issues
- Replacement for proper project management

### Hard Limits (V1)

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max agent replies per issue per day | 20 | Prevent notification spam |
| Max comment size | 2KB | Keep UI readable; link to artifacts for details |
| Max active issues with agents | 20 per repo | Stay within rate limits |
| Response SLA | None | Actions latency is unpredictable |
| Max conversation depth | 10 turns | Force summarization or new issue |

When limits are hit, agent posts single comment: "Exceeded daily limit, see full logs at [link]"

### Simplified Architecture

#### Core Components

1. **GitHub Actions** (only for bootstrapping)
   - `issue_comment.created` → triggers sync
   - `push` to task refs → posts agent messages
   - Explicitly NOT the main event loop

2. **Task-DAG Commits** (audit trail, not primary state)
   - Metadata-only commits with YAML
   - Refs for mapping: `refs/gh/comments/<N>/<comment_id>`
   - Git is the durable log, not the query layer

3. **Idempotency Keys** (critical for recovery)
   - Every comment: stored `comment_id` in DAG metadata
   - Every agent message: unique `message_id` in metadata
   - Enables full rebuild from either GitHub or DAG

#### Metadata Format (Simplified)

```yaml
kind: epic | work | message
role: human | agent
intent: question | answer | status | blocker | completion | clarification

issue:
  number: 9
  repo: owner/repo

github:
  comment_id: 123456        # null until posted
  actor: username

conversation:
  reply_to_comment_id: 78910  # GitHub comment ID (not task SHA)
  thread_root_comment_id: 12345

flags:
  post_to_github: true | false

message_id: msg_abc123def456  # Unique agent message ID

body: |
  Message text (max 2KB)
```

**Key simplifications**:
- Reply tracking uses `comment_id` not task SHAs (simpler lookups)
- Single `message_id` for idempotency
- Removed complex threading beyond simple reply-to

### Anti-Loop Protection (Defense in Depth)

1. **Primary: Author identity**
   - Ignore all comments from bot account(s)
   - Only process comments from humans

2. **Secondary: Hidden marker**
   - Agent comments include `<!-- task-dag: msg=<message_id> -->`
   - Prevents re-processing if marker somehow survives edit

3. **Tertiary: Comment ID tracking**
   - Store processed comment_ids in lightweight file: `.github/task-dag-state/processed_comments.txt`
   - Check before creating task

4. **Cursor-based processing**
   - Track last_processed_comment_id per issue
   - Only process newer comments

### Workflow (V1 Constrained)

#### 1. Human Creates Issue
- `issues.opened` Action
- Creates epic task at `refs/heads/tasks/pending/<N>`
- Creates mapping ref `refs/gh/issues/<N>`
- **One-time operation, low API cost**

#### 2. Human Adds Comment
- `issue_comment.created` Action (10-60s latency)
- **Anti-loop checks** (author, marker, processed list)
- Creates message task with metadata
- Creates ref `refs/gh/comments/<N>/<comment_id>`
- Marks as frontier if work request (heuristic: no reply_to)
- **Cost: ~5-10 API calls**

#### 3. Agent Processes Work (Off-GitHub)
- Agent picks frontier task via `task-dag frontier`
- Does work locally (code, analysis, etc.)
- Commits implementation to master
- Links via `task-dag complete <task_sha>`

#### 4. Agent Posts Update (Constrained)
- Agent creates message task via CLI:
  ```bash
  task-dag message create \
    --issue=9 \
    --intent=status \
    --body="Phase 1 complete. See details: [link]" \
    --max-length=2048
  ```
- **Enforces 2KB limit** at creation time
- Sets `flags.post_to_github: true`
- **Does NOT immediately post** (decoupled)

#### 5. Sync Agent Messages (Batch)
- Cron job or push trigger (every 5 min max)
- Scans for unsent messages (`post_to_github: true`, no `comment_id`)
- **Batches to respect rate limits** (max 10 per run)
- For each message:
  - Check `refs/task-messages/sent/<message_id>` (already posted?)
  - Build comment with marker + prefix
  - POST to GitHub
  - Store `comment_id` in DAG metadata (amend or new commit)
  - Create mapping ref
  - Mark sent: `refs/task-messages/sent/<message_id>`
- **Idempotent**: retries safe, no duplicates

### Recovery & Repair (First-Class)

Ship these tools from day 1:

#### `task-dag repair-issue <N>`
```bash
# Scans issue #N on GitHub and in DAG
# Reports inconsistencies:
# - Comments without DAG tasks
# - Tasks without comments
# - Orphaned refs
# - Offers to rebuild
```

#### `task-dag reconcile`
```bash
# Periodic job (daily/weekly)
# Scans all active issues
# Rebuilds refs from DAG metadata
# Posts summary to dedicated issue
```

#### State files for recovery
```
.github/task-dag-state/
├── processed_comments.txt    # comment_ids we've seen
├── sent_messages.txt          # message_ids we've posted
└── last_sync.json             # cursor positions
```

These files are **committed to repo** for auditability and recovery.

### Failure Modes & Mitigations

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Actions down | External health check pings repo API | Manual notice to humans |
| Webhook missed | Reconcile job finds unprocessed comments | Create missing tasks |
| API rate limit | HTTP 403 response | Queue, retry with backoff |
| Comment POST fails | No comment_id in response | Retry on next sync |
| Ref out of sync | Repair tool comparison | Rebuild from comment_id in metadata |
| Duplicate comment | message_id already has comment_id | Skip, log warning |

### Human UX Guidelines

#### Comment Formatting (Agent)
```markdown
**🤖 Status Update**

Phase 1 implementation complete:
- ✅ Core engine
- ✅ Input adapters
- ⏳ Output adapters (in progress)

[View detailed logs](link to gist/artifact)

---
<sub>Reply to this comment to ask questions or provide feedback.</sub>
```

**Rules**:
- Emoji prefix for scannability
- Bullet points, not walls of text
- External links for details
- Explicit call-to-action

#### Notification Management
- Agents use single bot account
- Humans can unsubscribe from individual issues if too noisy
- Agent won't post more than N times per day per issue

#### Threading (Manual)
- Agent includes explicit reply links:
  ```
  **🤖 Answer**
  
  Replying to [your question about caching](link):
  
  Use Redis with 1 hour TTL...
  ```

### CLI Commands (Agent)

```bash
# Create message (queued for posting)
task-dag message create \
  --issue=<N> \
  --intent=<question|status|blocker|completion> \
  --reply-to=<comment_id> \              # Optional
  --body="Message text" \
  --max-length=2048

# Immediate question (sugar for create + mark urgent)
task-dag ask --issue=<N> --body="What's the API key?"

# Mark work task complete + post completion message
task-dag complete <work_sha> --message="Implementation done, tests passing"

# Repair/recovery
task-dag repair-issue <N>
task-dag reconcile
```

## Implementation Phases

### Phase 1: Minimal Viable (1-2 days)
- ✅ Comment→Task sync (with anti-loop)
- ✅ Basic metadata format
- ✅ Idempotency via comment_id
- ✅ Manual agent message posting (no auto-sync yet)
- ✅ Recovery: repair-issue command

**Test**: Post comments on Issue #9, verify tasks created, no loops

### Phase 2: Agent→GitHub Sync (2-3 days)
- Task→Comment sync workflow
- Batched posting with rate limit handling
- message_id tracking
- Auto-retry on failure

**Test**: Agent posts status, appears on issue, retry doesn't duplicate

### Phase 3: Polish & Limits (1-2 days)
- Enforce size limits
- Daily comment caps
- Better formatting templates
- Reconcile command

**Test**: Hit a limit, see graceful degradation

### Phase 4: Production Hardening (3-5 days)
- External health monitoring
- Comprehensive error logging
- Rate limit dashboards
- Runbook for common failures

**Test**: Simulate failures, verify recovery

## Migration Path Beyond V1

When we hit these thresholds, plan upgrade:

- ✅ **50+ comments** on issues regularly
- ✅ **20+ active** agent-involved issues per repo
- ✅ **Rate limits** hit weekly
- ✅ **Latency complaints** from humans
- ✅ **Recovery incidents** requiring manual intervention

### V2 Architecture (Future)
- External webhook service (not Actions-based)
- Database for canonical state (Postgres/SQLite)
- Git commits as periodic audit snapshots
- Custom UI overlay for threading
- Sub-second response times
- Proper SLA and monitoring

**Effort**: 1-2 weeks for V2 migration

## Open Questions for Review

1. **Daily comment limit**: 20 per issue OK? Too low? Too high?
2. **Comment size limit**: 2KB sufficient? Should we allow more for code examples?
3. **Auto-frontier**: Should human comments auto-create frontier tasks or need explicit marker (e.g., "/task")?
4. **Multiple agents**: Should we support or explicitly forbid for V1?
5. **Private vs public**: Any comments that shouldn't sync (e.g., internal notes)?

## Success Criteria (V1)

- ✅ Human can create issue → epic task created
- ✅ Human can comment → message task created
- ✅ Agent can post question → appears on issue within 60s
- ✅ Human can reply → agent sees it
- ✅ No duplicate comments
- ✅ Recovery from missed webhook works
- ✅ System stays within rate limits for 20 active issues

## Risks Accepted (V1)

- ❌ No guaranteed response time (Actions latency)
- ❌ Silent failures possible if Actions down
- ❌ Will feel slow compared to chat
- ❌ Threading UI is manual, not automatic
- ❌ High-volume use will hit limits

We build knowing these constraints and plan upgrade path.

---

**Next Step**: Review on [Issue #9](https://github.com/FreshlyBakedNYC/automation/issues/9) and approve for trial implementation.
