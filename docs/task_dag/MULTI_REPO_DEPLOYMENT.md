# Multi-Repo Deployment Strategy for Issue ↔ Task-DAG System

**Status**: Design Proposal  
**Created**: 2026-05-14

## Problem

The GitHub Issue ↔ Task-DAG interaction system needs to work identically across multiple repositories:
- `automation`
- `mostly-static-sites`
- `nixos-sbc`
- Future repos

Changes must persist identically across all implementations without manual syncing.

## Recommended Approach: Reusable Workflows

GitHub Actions supports [reusable workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows) - workflows in one repo that can be called by others.

### Architecture

```
FreshlyBakedNYC/
├── shared-workflows/              # New central repo
│   └── .github/workflows/
│       ├── sync-comment-to-task.yml    # Reusable
│       ├── sync-task-to-comment.yml    # Reusable
│       └── sync-issue-state.yml        # Reusable
│
├── automation/                    # Uses shared workflows
│   └── .github/workflows/
│       ├── issue-comment-sync.yml      # Calls shared
│       └── .task-dag-config.yml        # Repo-specific settings
│
├── mostly-static-sites/           # Uses shared workflows
│   └── .github/workflows/
│       └── issue-comment-sync.yml      # Same, calls shared
│
└── nixos-sbc/                     # Uses shared workflows
    └── .github/workflows/
        └── issue-comment-sync.yml      # Same, calls shared
```

### Shared Workflow Repo

**Repository**: `FreshlyBakedNYC/shared-workflows` (or `.github` by convention)

**File**: `.github/workflows/sync-comment-to-task.yml`
```yaml
name: Sync Comment to Task-DAG (Reusable)

on:
  workflow_call:
    inputs:
      max_comment_size:
        type: number
        default: 2048
      max_daily_comments:
        type: number
        default: 20
    secrets:
      token:
        required: true

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Sync comment to task
        env:
          GITHUB_TOKEN: ${{ secrets.token }}
        run: |
          # Shared sync logic here
          # Uses bash script from shared repo
```

### Calling Workflows (Per Repo)

**File**: `automation/.github/workflows/issue-comment-sync.yml`
```yaml
name: Issue Comment Sync

on:
  issue_comment:
    types: [created]

jobs:
  sync-comment:
    uses: FreshlyBakedNYC/shared-workflows/.github/workflows/sync-comment-to-task.yml@main
    with:
      max_comment_size: 2048
      max_daily_comments: 20
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

### Repo-Specific Configuration

**File**: `.task-dag-config.yml` (in each repo)
```yaml
# Task-DAG Configuration for this repository

# Comment limits
max_comment_size: 2048
max_daily_comments: 20

# Rate limits
max_active_issues: 20

# Feature flags
enable_auto_frontier: true
enable_state_change_tasks: true

# Repo-specific refs namespace (optional)
refs_namespace: "refs/gh"
```

## Benefits

| Benefit | Description |
|---------|-------------|
| **Single source of truth** | All logic in one repo |
| **Instant updates** | Push to shared-workflows → all repos use new version |
| **No manual sync** | GitHub handles calling latest version |
| **Repo customization** | Each repo controls config via inputs |
| **Version pinning** | Can pin to `@v1` instead of `@main` for stability |
| **Centralized testing** | Test changes in one place before rollout |

## Implementation Plan

### Phase 1: Extract to Shared Repo
1. Create `FreshlyBakedNYC/shared-workflows` repo
2. Move reusable workflow logic there
3. Create reusable workflow files
4. Extract scripts to `scripts/` in shared repo

### Phase 2: Convert Automation Repo
1. Replace local workflows with caller workflows
2. Add `.task-dag-config.yml`
3. Test end-to-end
4. Verify no functionality lost

### Phase 3: Roll Out to Other Repos
1. Add caller workflows to `mostly-static-sites`
2. Add caller workflows to `nixos-sbc`
3. Add config files
4. Test on real issues

### Phase 4: Shared Script Distribution
**Problem**: Scripts like `task-dag` CLI need to be available in each repo

**Solutions**:

#### Option A: NPM Package (if Node.js available)
```bash
npm install -g @freshlybaked/task-dag-cli
task-dag message create --issue=9
```

#### Option B: Install Script
```bash
# In each repo's setup
curl -fsSL https://raw.githubusercontent.com/FreshlyBakedNYC/shared-workflows/main/install.sh | bash
# Installs scripts to /usr/local/bin or repo .bin/
```

#### Option C: Git Submodule
```bash
# In each repo
git submodule add https://github.com/FreshlyBakedNYC/shared-workflows .task-dag
# Scripts available at .task-dag/scripts/task-dag
```

#### Option D: Copy on Workflow Run
```yaml
# In shared workflow
- name: Setup task-dag CLI
  run: |
    curl -fsSL https://raw.githubusercontent.com/FreshlyBakedNYC/shared-workflows/main/scripts/task-dag -o /tmp/task-dag
    chmod +x /tmp/task-dag
    sudo mv /tmp/task-dag /usr/local/bin/
```

**Recommendation**: Option D for workflows, Option B for local development

## Alternative: GitHub Organization .github Repository

GitHub has a special convention: a repository named `.github` at the org level provides:
- Shared workflows automatically
- Shared issue templates
- Org-level documentation

**Repository**: `FreshlyBakedNYC/.github`

Same structure as above, but automatically available to all repos in the org.

## Migration Checklist

Per repo that adopts this system:

- [ ] Add caller workflow files
- [ ] Add `.task-dag-config.yml`
- [ ] Create initial `refs/heads/tasks/pending/` structure
- [ ] Test issue creation → epic task
- [ ] Test comment → message task
- [ ] Test agent message → issue comment
- [ ] Verify anti-loop protection
- [ ] Run `task-dag reconcile` to validate
- [ ] Document repo-specific quirks in `AGENTS.md`

## Version Management

### Stable Versions
```yaml
# Pin to major version
uses: FreshlyBakedNYC/shared-workflows/.github/workflows/sync-comment-to-task.yml@v1

# Pin to exact version
uses: FreshlyBakedNYC/shared-workflows/.github/workflows/sync-comment-to-task.yml@v1.2.3

# Always latest (rolling updates)
uses: FreshlyBakedNYC/shared-workflows/.github/workflows/sync-comment-to-task.yml@main
```

### Release Process
1. Develop changes on branch in shared-workflows
2. Test in one repo (automation) using `@feature-branch`
3. Merge to main
4. Tag release: `git tag v1.1.0 && git push --tags`
5. Update repos to `@v1` or `@v1.1.0`

## Monitoring Across Repos

Centralized dashboard showing:
- Active issues per repo
- Comment volume per repo
- Rate limit usage per repo
- Failed syncs per repo
- Recovery operations needed

**Implementation**: 
- Shared workflow reports metrics to central endpoint
- Or: GitHub Actions logs aggregated via API
- Or: Simple cron job queries all repos

## Security Considerations

### Secrets
- Each repo uses its own `GITHUB_TOKEN` (scoped to that repo)
- Shared workflows receive secrets as inputs
- No secrets stored in shared repo

### Permissions
```yaml
# In caller workflow
permissions:
  issues: write
  contents: write
```

### Validation
- Shared workflows validate inputs
- Sanitize comment bodies to prevent injection
- Rate limit enforcement prevents abuse

## Open Questions

1. **Namespace collision**: If multiple repos use same issue numbers, how to distinguish tasks?
   - Option: Include repo slug in task refs: `refs/gh/automation/issues/9`
   
2. **Cross-repo tasks**: Should task-dag support tasks that span multiple repos?
   - V1: No, each repo independent
   - V2: Possible via external state store

3. **Monorepo vs multi-repo**: Does the org structure stay as multiple repos or consolidate?
   - Keep as-is for now, design supports both

## Next Steps

1. ✅ Complete V1 in automation repo
2. ⏳ Create `FreshlyBakedNYC/shared-workflows` repo
3. ⏳ Extract reusable workflows
4. ⏳ Test with automation repo calling shared workflows
5. ⏳ Roll out to other repos
6. ⏳ Document per-repo setup process

---

**Recommendation**: Start with reusable workflows approach. It's GitHub-native, requires no custom infrastructure, and provides instant consistency across repos with optional version pinning for stability.
