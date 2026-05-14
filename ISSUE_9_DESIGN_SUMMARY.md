# 🤖 Design Proposal: GitHub Issue ↔ Task-DAG Interaction Model

**Branch**: [`feature/issue-comment-task-sync`](https://github.com/FreshlyBakedNYC/automation/tree/feature/issue-comment-task-sync)  
**Status**: Ready for Review  
**Commit**: f11253b

---

## TL;DR

We can use GitHub Issues as a human-agent collaboration UI, but we need to be realistic about constraints. This is an **async co-pilot system**, not live chat. V1 will work for 10-20 active issues with deliberate humans and rate-limited agents.

---

## What We Designed

A bidirectional system where:
- **Human → Agent**: Issue comments create task-dag message tasks
- **Agent → Human**: Agent message tasks post as issue comments
- **Threading**: Reply chains tracked via metadata
- **Recovery**: Idempotent design with repair tools

---

## Critical Constraints (From Oracle)

Oracle provided a brutally honest assessment of this approach:

### ⚠️ Hard Limits

| Constraint | Reality | Impact |
|------------|---------|--------|
| **GitHub Actions latency** | 10-60 seconds | Not interactive chat, async only |
| **API rate limits** | ~5,000/hour | ~500 conversational turns/hour max |
| **Scale ceiling** | ~20 active issues | Beyond this, rate limits and UX degrade |
| **No threading UI** | Flat comment list | Confusing with 50+ comments |
| **Failure modes** | Actions down, webhooks missed | Need defensive design + recovery |

### ✅ What This IS

- Async work request and status system
- Lightweight Q&A for agents
- Audit trail tied to GitHub issues
- **Bootstrap V1** that will be replaced at scale

### ❌ What This is NOT

- Real-time chat
- High-volume conversational AI
- Production system for 100+ issues
- Replacement for proper PM tools

---

## V1 Design (Constrained & Realistic)

### Hard Limits We'll Enforce

| Limit | Value | Why |
|-------|-------|-----|
| Max agent replies/issue/day | 20 | Prevent notification spam |
| Max comment size | 2KB | Keep UI readable |
| Max active issues | 20/repo | Stay within rate limits |
| Response SLA | None | Actions latency unpredictable |

### Core Architecture

```
Human Comment
     ↓
GitHub Action (10-60s delay)
     ↓
Create Message Task
     ↓
Git DAG Commit + Ref
     
     
Agent Work
     ↓
Create Message Task (flags.post_to_github: true)
     ↓
Batch Sync Job (every 5 min)
     ↓
POST to GitHub Issue
     ↓
Human Sees Reply
```

### Anti-Loop Protection (Defense in Depth)

1. **Primary**: Ignore comments from bot account(s)
2. **Secondary**: Hidden HTML marker in agent comments
3. **Tertiary**: Track processed comment IDs
4. **Quaternary**: Cursor-based processing

### Idempotency (Critical for Recovery)

- Every comment: unique `comment_id` in metadata
- Every agent message: unique `message_id`
- State files: `.github/task-dag-state/processed_comments.txt`
- Can rebuild from either GitHub or DAG

### Recovery Tools (Day 1)

```bash
# Scan issue for inconsistencies
task-dag repair-issue <N>

# Periodic reconciliation
task-dag reconcile

# Rebuild refs from metadata
task-dag rebuild-refs
```

---

## Example Interaction Flow

```
👤 Human (Issue #9 body):
   "Implement search with caching"
   → Epic task created

🤖 Agent:
   $ task-dag ask --issue=9 --body="What's the cache TTL?"
   → Posts: **🤖 Question** What's the cache TTL?
   
👤 Human (comment):
   "Use 1 hour TTL"
   → Message task created, linked to agent question

🤖 Agent:
   $ task-dag message create --intent=status \
       --body="Implemented caching with 1hr TTL"
   → Posts: **🤖 Status Update** Implemented caching...

🤖 Agent:
   $ task-dag complete <work_task>
   $ task-dag message create --intent=completion \
       --body="Search complete, tests passing"
   → Posts completion message

👤 Human:
   Closes issue
   → State-change task created
```

---

## Documentation

Two comprehensive design docs are on the branch:

### 1. Full Interaction Model (Idealized)
**File**: [`docs/task_dag/GITHUB_ISSUE_INTERACTION_MODEL.md`](https://github.com/FreshlyBakedNYC/automation/blob/feature/issue-comment-task-sync/docs/task_dag/GITHUB_ISSUE_INTERACTION_MODEL.md)

- Complete workflow diagrams
- Metadata format specifications
- Message intents and types
- Reference structure
- GitHub Action requirements
- Agent CLI commands
- Implementation phases

### 2. V1 Realistic Design (Constrained)
**File**: [`docs/task_dag/ISSUE_INTERACTION_V1_REALISTIC.md`](https://github.com/FreshlyBakedNYC/automation/blob/feature/issue-comment-task-sync/docs/task_dag/ISSUE_INTERACTION_V1_REALISTIC.md)

- Critical constraints and limits
- Failure modes and mitigations
- Defensive architecture
- Recovery procedures
- Migration path to V2
- Risks accepted

---

## Implementation Phases

### Phase 1: Minimal Viable (1-2 days)
- Comment→Task sync with anti-loop
- Basic metadata format
- Idempotency via comment_id
- Manual agent posting
- `repair-issue` command

**Test on Issue #9**

### Phase 2: Agent→GitHub Sync (2-3 days)
- Task→Comment workflow
- Batched posting with rate limits
- Auto-retry on failure
- `message_id` tracking

### Phase 3: Polish (1-2 days)
- Enforce size/count limits
- Better formatting
- `reconcile` command

### Phase 4: Hardening (3-5 days)
- Health monitoring
- Error logging
- Rate limit dashboards
- Runbooks

---

## When to Upgrade to V2

Trigger upgrade when we see:

- ✅ Issues regularly exceed 50 comments
- ✅ More than 20 active agent issues/repo
- ✅ Rate limits hit weekly
- ✅ Latency complaints
- ✅ Recovery incidents

**V2** will use:
- External webhook service (not Actions)
- Database for canonical state
- Git as audit log only
- Custom UI overlay
- Sub-second response times

---

## Open Questions

1. **Daily limit**: Is 20 agent comments/issue/day OK?
2. **Comment size**: Is 2KB sufficient?
3. **Auto-frontier**: Should human comments auto-create work tasks?
4. **Multiple agents**: Support or forbid for V1?
5. **Private comments**: Any that shouldn't sync?

---

## Next Steps

1. ✅ Review this design
2. ⏳ Approve or request changes
3. ⏳ Test interaction model on this issue (#9)
4. ⏳ Implement Phase 1
5. ⏳ Iterate based on real use

---

## Success Criteria (V1)

- ✅ Human creates issue → epic task created
- ✅ Human comments → message task created
- ✅ Agent posts question → appears on issue <60s
- ✅ Human replies → agent sees it
- ✅ No duplicate comments
- ✅ Recovery from failures works
- ✅ Stays within rate limits for 20 issues

---

**Recommendation**: Approve Phase 1 implementation. Start simple, learn from real use, iterate toward V2 when we hit scale.

cc @virusdave for review
