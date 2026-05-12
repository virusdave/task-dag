# Policy Review & Compliance Architecture Summary

**Generated**: 2026-05-12  
**Purpose**: Comprehensive documentation of policy-review-compliance optimization, live tooling, and LLM-assisted design conventions

---

## Executive Summary

The workspace maintains a **reviewer-first, packet-based** architecture for policy-review and compliance workflows, with strong LLM governance and clear separation between review surfaces and live system mutations. All work follows strict conventions documented in `AGENTS_MUST_KNOW.md` and organized through a structured knowledgebase (`HOW_*_WORKS.md` → `docs/<domain>/`).

**Key architectural principles:**
1. **Reviewer-first workflows**: Review UIs never mutate external systems (Google Ads, Sweed); all changes flow through explicit approval → worker job → apply pipeline
2. **Packet-based review**: Static HTML+JSON packets with server-side draft persistence for all complex review workflows
3. **LLM governance**: Registry-based approval (`config/llm_use/registry.yaml`) for all model/backend/use-case combinations
4. **Helios consolidation**: Migration from scattered webapps into a single modular operational surface (`automation/helios/`)
5. **Live infrastructure**: All external service mutations (Sweed, Google Ads, screens) happen only in workers with concurrency control

---

## 1. Policy-Limited Asset Replacement Review Workflow

### Architecture

**Primary Use Case**: Google Ads policy-limited asset replacement review and approval

**Flow**:
1. **Planning** → Google Ads UI exports processed into static packet
2. **Review** → Helios `/communications/policy-replacements/:packetId` (or legacy fallback service)
3. **Approval** → Reviewer decisions persisted to TigerData with audit trail
4. **Apply** → Separate worker job reads approved items, resolves live assets, applies via validate-only → live → readback

### Implementation

**Helios Communications Module** (`automation/helios/`)
- Routes: `src/server/routes/communications.ts`
- Client: `src/client/routes/communications/PolicyReplacementReviewPage.tsx`
- Contracts: `src/shared/contracts/domain/communications.ts`
- Database: `communications_policy_replacement_drafts`, `communications_policy_replacement_audit`

**Endpoints**:
- `GET /api/communications/policy-replacements/:packetId/summary` - Item counts by category
- `GET /api/communications/policy-replacements/:packetId/detail` - Full packet detail
- `GET /api/communications/policy-replacements/:packetId/draft` - Persisted review state (404 with typed empty response if none)
- `POST /api/communications/policy-replacements/:packetId/draft` - Save/submit review decisions

**Legacy Fallback**: `ads/google/serve_asset_policy_limited_replacement_review.py`
- Marked "SUPERSEDED on 2026-05-05"
- Retained only for offline/emergency use when Helios unavailable
- Does NOT sync with Helios persisted state

### Packet Structure

**Reviewable Items**:
- `visualReplacementPlans[]` - Limited logos/images requiring replacement
- `llmCopy.headlines[]` - LLM-generated safer headlines
- `llmCopy.longHeadlines[]` - Long headline alternatives
- `llmCopy.descriptions[]` - Safer description text
- `llmCopy.templateFamilies[]` - Reusable text templates with placeholders (e.g., `{brand}`)
- `textReplacementMappings[]` - Mappings from limited current text to replacement category + source asset

**Stable IDs**: `visual-N`, `headline-N`, `long-headline-N`, `description-N`, `template-family-N`, `text-map-N`

**Review Decisions**: `unreviewed | accepted | rejected | hold`

**Editable Fields**:
- `text` - Edited replacement text
- `note` - Reviewer notes
- `replacementCategory` - One of: `location | price | pickup | payment | ''`
- `sourceId` - Reference to source asset for mappings

### Critical Constraints

1. **Never mutates Google Ads from review UI** - Only persists reviewer decisions
2. **Apply is always separate** - Downstream worker must:
   - Re-read persisted draft
   - Filter to `decision === 'accepted'`
   - Resolve current text/URLs to live Google Ads asset owners
   - Run validate-only
   - Live apply
   - Narrow readback
3. **Server-side validation** - All IDs, decisions, categories, field keys range-checked; never trust client
4. **Audit trail** - Every save/submit emits `communications.policy_replacement_review.{draft_saved,submitted}` events

---

## 2. LLM Integration & Governance

### Registry-Based Governance

**Required reading before any LLM use**:
- `HOW_PRIVATE_LLM_ACCESS_WORKS.md`
- `config/llm_use/registry.yaml`

**Rules** (from `AGENTS_MUST_KNOW.md` lines 27-28, `AGENTS.md` line 9):
1. Every `(backend, model, use-case)` combination must be recorded in registry
2. New combinations must be added BEFORE first use
3. Mark as either **approved** or **explicit limited trial** with named scope
4. Keep trial uses bounded to documented scope

**Example trial**: 
```yaml
backend: bedrock-mantle
model: google.gemma-3-27b-it
use-case: pending-purchase-taxonomy-classification
status: limited-trial
scope: Midtown pending purchase packet generation only
```

### Bedrock Mantle Integration

**Canonical private content-generation backend**

**Endpoint**: `https://bedrock-mantle.us-east-2.api.aws/v1` (OpenAI-compatible)

**Authentication**:
- Bearer token stored in `~/.secret/bedrock/mantle-bearer-token`
- Optional env helper: `~/.secret/bedrock/mantle-bearer-token.env`
- **NEVER** commit tokens to repo or artifacts
- Tokens may rotate - refresh local secret if getting `401 Unauthorized`

**Access Pattern**:
- Worker-only (never direct from UI)
- Via `requestMantleJson` helper
- POST `/chat/completions` with ChatML messages
- `response_format: { type: 'json_object' }` for structured outputs
- Short timeout via `AbortSignal.timeout`
- Retry loop with JSON repair for invalid responses (up to 3 attempts)

**Use Cases**:
1. **Catalog description generation** (`descriptionDebugRerun.ts`)
2. **Pricing market context** (`litAlertsMarket.ts`)
3. **Scheduling constraint extraction** (`scheduling/extractConstraints.ts`)
4. **Pending purchase taxonomy classification** (`generatePendingPurchasePacketJob.ts`)

**Observability**:
- All runs persisted to `llm_runs` table
- Includes: `catalog_group_id`, `purpose`, `model`, `prompt_version`, `input_json`, `raw_output_text`, `parsed_output_json`, `validation_issues_json`
- API: `GET /api/llm/runs/:llmRunId`, `POST /api/catalog-groups/:catalogGroupId/llm-reruns`

### LLM Roles

**Oracle** (this assistant):
- Architecture/copy/design review
- High-level workflow design
- Policy and safety reviews
- Used through Amp tooling layer

**Painter**:
- Approved image-generation LLM
- Reviewer-ready banner/ad/promo imagery
- Must clearly include provided brand assets
- Only use when user explicitly authorizes
- No SVG/HTML/CSS mockups as final creative

**Mantle**:
- Structured workhorse for high-volume tasks
- Always JSON contracts
- Worker-invoked only
- Registry-governed

**Shared Pattern**:
- Approval & registry first
- No inline UI → LLM calls
- Reviewer-first (human approval required before apply)
- Structured logging and audit

---

## 3. Live Infrastructure & Services

### Helios Backend Architecture

**Location**: `automation/helios/`
**Stack**: Node/Fastify + TigerData (Timescale Postgres)

**Modules**:
- `catalog` - Product catalog management, approval queue
- `pendingPurchases` - Purchase order mapping and review
- `pricing` - Pricing packets, Lit Alerts integration
- `screens` - In-store TV banner management
- `config` - Background workers and schedules
- `communications` - Google Ads policy review
- `scheduling` - Employee scheduling with constraint extraction
- Global: `jobs`, `history`, `comments`

**Workers**:
- Concurrency lanes: `sweed-session`, `ads`, default
- Serialize Sweed-backed jobs to avoid dealer-context races
- All jobs tracked in `job_queue` with module/scope metadata
- Audit events in `audit_events` table

### External Services

**Sweed API**:
- All catalog, inventory, purchase order, screen work
- Critical rules (from `AGENTS_MUST_KNOW.md`):
  - Always reset dealer context with `store.auth.dealer.set` before operations
  - Verify `currentDealerId` before reads/writes
  - Disabled subcategories are invalid for new writes
  - Some RPCs ignore pagination (e.g., `store.product.brand.list`)
  - Session can drift between calls - explicit resets required
  - Force IPv4 if getting Cloudflare challenges

**Lit Alerts API**:
- Competitor pricing context
- `GET /Manufacturers/real?state=NY`
- `POST /Products/menulistings`
- Critical rules:
  - Do NOT trust `total` field - page until empty/short
  - Use rare contiguous substrings for `filters.Name` (exact substring match)
  - Maintain strict same-brand/same-format semantics

**Google Ads**:
- Only touched from narrow apply workers
- Never from review UIs
- Always: validate-only → live apply → readback

### Image Safety & Creative Infrastructure

**Image Safety Rules** (`AGENTS_MUST_KNOW.md` line 63):
- **Forbidden**: Images with visible text "stock photo" or "stock image"
- Treat as generic placeholders, never apply live

**Creative Generation** (`AGENTS_MUST_KNOW.md` lines 57-59):
- For reviewer-ready banner/ad/promo imagery: use **Painter** (when explicitly authorized)
- Must be actual generated images, not SVG/HTML/CSS mocks
- Provided brand assets (logos, storefronts, pack shots) must appear in final output
- If Painter unavailable: stop at concept discussion or labeled mockups

**Image Upload (Sweed)**:
- `store.blob.add { type: "banner" }`
- `PUT /api/blobs/upload/{blobId}`
- Reference by `mediaId` in `store.screen.carousel.banner.add/edit`

**Helios Screen Workflows** (all worker jobs):
- `screens.banner_refresh`
- `screens.banner_health_maintenance`
- `screens.bronx_midtown_image_clone`
- `screens.midtown_priced_to_move_promo_rebind`
- `screens.midtown_fresh_and_intense_promo_rebind`
- `screens.image_banner_sync`

**Note**: No separate dedicated "live image transformer service" exists. Image handling is:
- Generation: Painter (LLM)
- Upload/serving: Sweed blobs + banners
- Safety: Workspace rules + review gates

---

## 4. Reviewer-First Workflow Pattern

### Standard Flow

1. **Planning / Analysis**
   - Live exports (Google Ads, Sweed, Lit Alerts)
   - Build static review packet (HTML + JSON) or snapshot tables
   - Include LLM-generated proposals, policy rationales, status counts

2. **Reviewer-First Packet Review**
   - Packets are local-first (work offline with localStorage)
   - Server-side draft persistence optional but recommended
   - Deep tree nav with stable anchors
   - Persistent state separate from review decisions
   - **Never mutates external systems during review**

3. **Server-Persisted Draft State**
   - Generic pattern (`docs/google-ads/review-packets.md`):
     - `GET /api/<review-name>/draft/latest`
     - `POST /api/<review-name>/draft`
   - Normalized schema: `{ version, packetId, savedAt, items }` (or `assets, templateFamilies`)
   - Communications module adds: `submittedAt`, audit events, summary counts

4. **Apply Pipeline**
   - **Never implicit from "submit"** - always separate step
   - Read server-persisted draft
   - Filter to `decision == accepted`
   - Narrow resolver for live entities
   - Validate-only → live apply → readback
   - Explicit blockers if minimum requirements not met

### Packet Conventions

**Stable IDs**:
- Packet: `packetId` (e.g., `asset_policy_limited_replacement_plan_2026-05-05_110134`)
- Entries: Deterministic from packet structure (e.g., `visual-1`, `headline-3`, `text-map-42`)

**Section Taxonomy**:
- Defined in single source of truth (e.g., `NAV_SECTION_SPECS`)
- Deep links from IDs, not labels
- Regenerated packets preserve URLs

**State Persistence**:
- LocalStorage: Nav state (sidebar open/closed), offline draft fallback
- Server: Review decisions, audit trail, submission timestamps

---

## 5. Knowledgebase Organization

### Structure

**Entry Points** (from `AGENTS_MUST_KNOW.md` line 23-24):
- `docs/README.md` - Full map
- `HOW_KNOWLEDGEBASE_WORKS.md` - Canonical organization and maintenance rules
- `HOW_<DOMAIN>_WORKS.md` - Short domain index → `docs/<domain>/README.md` or task doc

**Maintenance Rules**:
- Keep findings in smallest correct canonical doc
- Update nearest index immediately after doc update
- Optimize for fast agent lookup and low-context reads
- Shallow hierarchy: index → subsystem doc → task doc
- Put rules near workflows they govern
- Avoid burying guidance in large narrative files or stale handoff logs

**Active Domains**:
- `HOW_HELIOS_WORKS.md` → `docs/helios/`
- `HOW_SWEED_WORKS.md` → `docs/sweed/`
- `HOW_LITALERTS_PRODUCT_MATCHING_WORKS.md` → `docs/litalerts/`
- `HOW_PRIVATE_LLM_ACCESS_WORKS.md` → (referenced but not yet created; rules in `AGENTS_MUST_KNOW.md`)
- `HOW_KNOWLEDGEBASE_WORKS.md` → `docs/knowledgebase/`
- `HOW_GIT_COMMIT_WORKS.md` → workspace commit conventions
- `HOW_MANTIS_WORKS.md` → `docs/mantis/`

### Example: Sweed Knowledge

From `AGENTS_MUST_KNOW.md` line 95:
> For the accumulated Sweed knowledge base, start with `HOW_SWEED_WORKS.md` and then load only the relevant task doc from `docs/sweed/`.

Task docs include:
- `docs/sweed/catalog/creation-and-editing.md`
- `docs/sweed/marketing/screens-and-banners.md`

---

## 6. Thread References & Historical Context

### Referenced Prior Thread

**Thread ID**: `T-019dd467-40c8-717a-bb03-61a46cde11d6`
- Referenced in: `docs/helios/pricing-repricing-module-proposal.md` line 9
- Context: "Oracle architecture review from the repricing planning pass"

### Recent Git History (Last 30 Commits)

Key policy/LLM-related commits:
- `de994ff` - helios: cascade live source edits into bound mapping text in the policy replacement reviewer
- `9c80335` - helios: switch global theme to warm cream/orange palette and reproduce policy replacement reviewer surface
- `ff9eefe` - helios: drop leftover imports from PolicyReplacementReviewPage
- Earlier migrations: Communications module, config workers, scheduling, pricing

### AGENT_TODO.md Handoffs

**Location**: `helios/AGENT_TODO.md`

**Active Handoff (2026-05-05, fourth pass)**: Live verification found/fixed two worker bugs
- Catalog refresh worker pagination issue
- Stock refresh worker inventory quantity field mismatch
- Both fixed and verified against live TigerData + Sweed

**Config Module** (lines 153-214):
- Background task scheduling for: Stock, Catalog, Lit Alerts refresh
- Worker jobs: `config.workers.{stock,catalog,litalerts}_refresh.*`
- Scheduler implementation with weekday masks + interval windows
- Per-task editor pages in Helios

**Communications Policy Replacement** (lines 145-161):
- Migrated from standalone service to Helios module on 2026-05-05
- Live in Helios at `/communications/policy-replacements/:packetId`
- Legacy service retained as offline fallback only

---

## 7. Adherence Checklist

Use this checklist to verify alignment with established conventions:

### LLM Usage
- [ ] New model/backend/use-case recorded in `config/llm_use/registry.yaml`
- [ ] Mantle bearer token stored only in `~/.secret/bedrock/`
- [ ] No tokens in repo files or artifacts
- [ ] Worker-only access (no direct UI → Mantle calls)
- [ ] JSON contracts with validation
- [ ] Structured logging to `llm_runs` or job artifacts
- [ ] Retry loops with repair for invalid JSON

### Review Workflows
- [ ] Review UI never mutates external systems
- [ ] Static packet (HTML + JSON) for offline capability
- [ ] Server-side draft persistence with audit events
- [ ] Stable packet and item IDs
- [ ] Apply is separate explicit worker job
- [ ] Filter to `decision == accepted` before apply
- [ ] Validate-only → live apply → readback pattern

### Sweed Integration
- [ ] Explicit `store.auth.dealer.set` before operations
- [ ] Verify `currentDealerId` before reads/writes
- [ ] Disabled subcategories excluded from new writes
- [ ] Handle non-paginating RPCs (e.g., `store.product.brand.list`)
- [ ] Session context reset between site/state operations
- [ ] Concurrency control via `sweed-session` lane

### Image & Creative
- [ ] No images with visible "stock photo"/"stock image" text
- [ ] Reviewer-ready imagery from Painter (when authorized)
- [ ] Provided brand assets clearly included in output
- [ ] No SVG/HTML/CSS mocks as final creative (unless explicitly approved as concept-only)

### Knowledgebase
- [ ] Findings documented in smallest correct canonical doc
- [ ] Nearest index updated immediately
- [ ] Important rules in `AGENTS_MUST_KNOW.md` when applicable
- [ ] Domain-specific rules in `docs/<domain>/` task docs

### Helios Module Integration
- [ ] Module registered in `src/shared/contracts/domain/modules.ts`
- [ ] Routes under `/api/<module>/` and `/<module>/`
- [ ] Worker jobs with `module` field for audit/filtering
- [ ] Audit events with `module` + `entityType` + `entityId`
- [ ] Single global primary sidebar (no per-page nav rails)
- [ ] Typed contracts in `src/shared/contracts/`

---

## 8. Key References

### Documentation
- `AGENTS_MUST_KNOW.md` - Critical rules (READ BEFORE SWEED WORK)
- `AGENTS.md` - Workspace conventions
- `docs/google-ads/review-packets.md` - Review packet patterns
- `docs/helios/` - Helios module documentation
- `docs/sweed/` - Sweed API patterns and task docs
- `config/llm_use/registry.yaml` - LLM usage governance

### Code
- `helios/src/server/routes/communications.ts` - Policy replacement endpoints
- `helios/src/client/routes/communications/PolicyReplacementReviewPage.tsx` - Reviewer UI
- `helios/src/worker/llm/` - Mantle integration helpers
- `helios/src/worker/jobs/` - Worker job implementations
- `ads/google/serve_asset_policy_limited_replacement_review.py` - Legacy fallback service

### Infrastructure
- TigerData credentials: `~amp-local/.secret/tigerdata/`
- Bedrock Mantle token: `~/.secret/bedrock/mantle-bearer-token`
- Lit Alerts token: `/Users/amp-local/.secret/litalerts/bearer-token`
- Sweed session: Extracted from HAR files

---

## 9. Architecture Diagrams

### Policy Replacement Review Flow

```
┌─────────────────────┐
│ Google Ads UI       │
│ Asset Report Export │
└──────────┬──────────┘
           │
           v
┌─────────────────────┐
│ Python Builder      │
│ Generate Packet     │
│ (HTML + JSON)       │
└──────────┬──────────┘
           │
           v
┌─────────────────────────────────────────┐
│ Helios /communications/policy-          │
│   replacements/:packetId                │
│                                         │
│ - View limited assets                  │
│ - Review LLM-generated replacements    │
│ - Edit text, map to categories         │
│ - Accept/Reject/Hold decisions         │
│ - Auto-save to TigerData              │
└──────────┬──────────────────────────────┘
           │
           v (Submit)
┌─────────────────────────────────────────┐
│ TigerData                               │
│ communications_policy_replacement_      │
│   drafts                                │
│ - Normalized items                      │
│ - Timestamps                            │
│ - Audit events                          │
└──────────┬──────────────────────────────┘
           │
           v (Separate Apply Step)
┌─────────────────────────────────────────┐
│ Apply Worker                            │
│ 1. Read persisted draft                 │
│ 2. Filter to accepted items             │
│ 3. Resolve live Google Ads assets       │
│ 4. Validate-only                        │
│ 5. Live apply                           │
│ 6. Readback verification                │
└─────────────────────────────────────────┘
```

### LLM Integration Architecture

```
┌─────────────────────────────────────────┐
│ config/llm_use/registry.yaml            │
│ - Approved models                        │
│ - Use-case registry                      │
│ - Trial scopes                           │
└──────────┬──────────────────────────────┘
           │ (Governance)
           v
┌─────────────────────────────────────────┐
│ Bedrock Mantle                          │
│ https://bedrock-mantle...aws/v1         │
│                                         │
│ Token: ~/.secret/bedrock/               │
└──────────┬──────────────────────────────┘
           │
           v (Worker-only access)
┌─────────────────────────────────────────┐
│ Helios Workers                          │
│                                         │
│ - descriptionDebugRerun.ts              │
│ - litAlertsMarket.ts                    │
│ - extractConstraints.ts                 │
│ - generatePendingPurchasePacketJob.ts   │
└──────────┬──────────────────────────────┘
           │
           v
┌─────────────────────────────────────────┐
│ TigerData llm_runs                      │
│ - Full audit trail                      │
│ - Input/output JSON                     │
│ - Validation issues                     │
│ - Prompt versions                       │
└─────────────────────────────────────────┘
           │
           v
┌─────────────────────────────────────────┐
│ Helios UI                               │
│ /api/llm/runs/:llmRunId                 │
│ /api/catalog-groups/:id/llm-reruns      │
└─────────────────────────────────────────┘
```

### Reviewer-First Workflow Pattern

```
┌─────────────────┐
│ External System │
│ (Ads/Sweed/etc) │
└────────┬────────┘
         │ (Read-only exports)
         v
┌──────────────────┐
│ Packet Builder   │
│ - Static HTML+JSON│
│ - LLM proposals  │
└────────┬─────────┘
         │
         v
┌────────────────────────────────┐
│ Helios Review UI               │
│ - Offline-capable              │
│ - LocalStorage fallback        │
│ - Server draft persistence     │
│ *** NO LIVE MUTATIONS ***      │
└────────┬───────────────────────┘
         │
         v (Save/Submit)
┌────────────────────────────────┐
│ TigerData                      │
│ - Normalized items             │
│ - Audit events                 │
│ - Timestamps                   │
└────────┬───────────────────────┘
         │
         v (Separate Explicit Apply)
┌────────────────────────────────┐
│ Worker Job                     │
│ 1. Filter accepted only        │
│ 2. Resolve live entities       │
│ 3. Validate-only               │
│ 4. Live apply                  │
│ 5. Readback                    │
└────────┬───────────────────────┘
         │
         v
┌─────────────────┐
│ External System │
│ (MUTATED)       │
└─────────────────┘
```

---

## 10. Summary

The workspace maintains exceptionally tight adherence to:

1. **Reviewer-first principles** - All mutations through explicit approval pipelines
2. **LLM governance** - Registry-based, secret-backed, worker-only access
3. **Live infrastructure** - Sweed/Ads/screens touched only via workers with concurrency control
4. **Packet conventions** - Static, offline-capable, server-persisted, stable IDs
5. **Knowledgebase discipline** - Structured docs, immediate updates, fast lookup
6. **Helios consolidation** - Single operational surface replacing scattered apps

The policy-limited asset replacement review exemplifies all these principles:
- Migrated from standalone service to Helios communications module (2026-05-05)
- Maintains packet-first review with LLM-generated safer text
- Server-persisted drafts with full audit trail
- Never touches Google Ads from review UI
- Apply is separate explicit worker with validate-only → live → readback

All live services (Mantle, Sweed, Google Ads, Lit Alerts, screens) follow the same guardrails:
- Worker-only access
- Typed contracts
- Strong validation
- Audit logging
- Graceful degradation with explicit error messages

For any new work touching these systems: consult the knowledgebase first (`HOW_*_WORKS.md`), check the registry for LLM usage, and preserve the reviewer-first / packet-based patterns.
