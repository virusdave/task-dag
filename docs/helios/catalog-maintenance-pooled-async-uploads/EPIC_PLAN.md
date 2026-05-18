# Catalog Maintenance — Pooled Sweed Sessions Everywhere + Resilient Queued Image Upload

Epic plan for two coupled fixes that have been blocking the
`/catalog/maintenance` ("Images & Barcodes") page in production:

1. **Pool everywhere.** Every server-side Sweed RPC must lease a token
   from the `sweed_session_tokens` pool via `withSweedSession()`. Today
   two Fastify-side modules — `src/server/catalog/maintenance.ts` and
   `src/server/catalog/liveRecentSales.ts` — bypass the pool and use a
   stale `SWEED_AUTH_TOKEN` env var. That env token is currently dead,
   and as a result group-image upload, variant-barcode edit, and the
   recent-sales velocity probe all fail with `auth expired` despite a
   half-dozen healthy pool tokens sitting idle.
2. **Resilient queued image upload.** Even with a live pool token, the
   "click upload → wait synchronously for Sweed blob.add + blob PUT +
   group.edit + verify" pattern is brittle: any transport hiccup loses
   the operator's bytes. Catalog-maintenance image uploads must instead
   stash bytes durably, enqueue a worker job, return immediately, and
   let the UI poll job status. A failed job can retry without the
   operator re-selecting the file.

## Motivation (verbatim from operator)

> the images don't seem to be being successfully uploaded to the
> variants, at least. The barcode seems to update though, which is a
> plus. … i see no errors or anything, and you definitely historically
> have python scripts capable of uploading images to product groups
> and variants successfully.
>
> The UI page needs immediate feedback on whether uploads succeed, btw.
>
> ok, so let's just stick to worrying about missing product group
> images, not individual variants. We'll come back to those later.
>
> similar to other cases (in fact, in ALL cases) wherever we need a
> live session, if we don't already have one leased, we need to block
> on grabbing a lease, initialize (dealer set, etc) then use the
> session, then return it to the pool. Right now, attempting to upload
> images fails because of a dead auth token, when there are literally a
> half dozen or more sitting in the pool ready for use should we need
> them. Perhaps the right thing to do here is to enqueue the "image
> upload to sweed" as a pending worker job, with the image having been
> stashed in S3 (we have a bucket we could use for this purpose). This
> would add some resiliance to the image upload process and not result
> in wasted work when we encounter something stupid like this.

## Settled requirements

1. **No more `getServerEnv().sweedAuthToken` fetches from server code.**
   All Sweed RPCs from `src/server/**` must go through the pool-leased
   transport (`src/worker/sweed/transport.ts`) inside an active
   `withSweedSession()` block.
2. **Group-image upload only (for now).** Variant-image upload is
   parked because `store.product.edit { imagesIds }` silently no-ops
   in Sweed; we'll revisit when we figure out the right RPC. The
   maintenance UI no longer shows variant-image cards.
3. **Pending uploads survive process restarts.** The bytes posted by
   the operator must be persisted to durable storage *before* the
   HTTP response returns. Subsequent retries reload bytes from there,
   not from the original multipart request.
4. **Immediate UI feedback.** The card switches from "uploading…" →
   "queued (job #N)" → "✓ uploaded" or "✗ failed: <reason>" with a
   "Retry" affordance that re-enqueues against the same staged bytes.
5. **Retries are automatic.** A pool-exhausted or transport-failed
   run leaves the job queued; the worker's existing retry/backoff
   handles re-runs without operator action.
6. **Pool-exhaustion is not a user-visible failure.** When every pool
   token is leased, the worker defers the job
   (`DependencyUnavailableWorkerError`) and the UI shows "waiting for
   Sweed session pool".

## Architecture

```diagram
   Operator
      │
      │  multipart POST /api/catalog/maintenance/images
      ▼
╭──────────────────────────────────────────────────╮
│ Fastify route                                    │
│   1. validate bytes / mime                       │
│   2. PendingMaintenanceImageStore.put(bytes)     │──────────┐
│      → stagedRef = "{uuid}.{ext}"                │          │
│   3. enqueueJob('catalog.maintenance.upload_     │          │
│                  group_image', { stagedRef, …},  │          │
│                  priority = HIGH)                │          ▼
│   4. respond { status: 'queued', jobId,          │   ╭──────────────╮
│                stagedRef }                       │   │ Durable      │
╰────────────────┬─────────────────────────────────╯   │ staging dir  │
                 │                                     │ (filesystem; │
                 │                                     │  S3 plug-in  │
                 │                                     │  follow-on)  │
                 ▼                                     ╰──────┬───────╯
   ╭──────────────────────────────────────────────╮          │
   │ Worker, SWEED_BACKED_JOB_TYPES includes      │          │
   │ 'catalog.maintenance.upload_group_image' →   │◀─────────╯ (read)
   │ runs handler inside withSweedSession():      │
   │   - claim pool token (block until one free)  │
   │   - dealer.set state-dealer                  │
   │   - blob.add  → blobId                       │
   │   - PUT bytes to blob URL                    │
   │   - group.get → existing imagesIds           │
   │   - group.edit → imagesIds ++ blobId         │
   │   - group.get → verify blobId attached       │
   │   - flagSweedGroupForReanalysis()            │
   │   - invalidateCatalogMaintenanceSurvey()     │
   │   - PendingMaintenanceImageStore.delete()    │
   ╰────────────────┬─────────────────────────────╯
                    │ progress / status
                    ▼
   ╭──────────────────────────────────────────────╮
   │ /api/jobs/:id                                │
   │   payload_json -> progress / progressLog /   │
   │   error                                      │
   ╰────────────────┬─────────────────────────────╯
                    │ poll
                    ▼
                 Operator UI
```

## Current state vs target

| Concern                    | Today                                        | Target                                                |
|----------------------------|----------------------------------------------|-------------------------------------------------------|
| `maintenance.ts` Sweed RPC | private `callSweedRpcRaw` with env token     | `withSweedSession()` + worker `callSweedRpc`          |
| `liveRecentSales.ts` RPC   | private `callSweedRpcRaw` with env token     | `withSweedSession()` + worker `callSweedRpc`          |
| Image upload path          | synchronous Fastify handler hits Sweed       | stash bytes → enqueue worker job → return job id      |
| UI feedback                | only "✓ uploaded" / "✗ <error>" on response | "queued #N → polling → ✓ / ✗ with Retry"              |
| Failure recovery           | operator re-selects file, re-clicks upload   | worker auto-retries against staged bytes              |
| Staging storage            | (none — bytes lost on any failure)           | local-filesystem store today; S3 plug-in as follow-on |

## Phase / task breakdown

The phases below map 1:1 onto the JSON breakdown in
[`task-dag-breakdown.json`](./task-dag-breakdown.json).

### Phase 1 — Pool every server-side Sweed RPC

Migrate `src/server/catalog/maintenance.ts` and
`src/server/catalog/liveRecentSales.ts` off their bespoke
`callSweedRpcRaw` + `getServerEnv().sweedAuthToken` paths and onto
the worker's pooled client (`src/worker/sweed/{session,client,rpc}.ts`).

After this phase:

- Every Sweed call originating from `src/server/**` runs inside a
  `withSweedSession()` block.
- `getServerEnv().sweedAuthToken` references in those modules are
  deleted (env var becomes worker-only legacy fallback).
- `runInSweedWriteBatch` (maintenance.ts) and `withSweedSessionLock`
  (liveRecentSales.ts) are removed; the per-token dealer cache in
  `session.ts` plus the empty-pool deferral handle both serialisation
  concerns.
- Synchronous image upload + barcode edit start working again
  immediately (this is the user's *today* pain).

This phase is shippable on its own without any of the queue work
below — it's the smallest correct change that fixes the dead-token
failure.

### Phase 2 — Pending-maintenance-image staging store

- Add `src/server/catalog/pendingImageUploadStore.ts` exporting:
  - `interface PendingImageUploadStore { put(bytes, mime, meta): Promise<{ stagedRef }>; read(stagedRef): Promise<{ bytes, mime, meta }>; delete(stagedRef): Promise<void>; listOlderThan(date): Promise<string[]> }`
  - `LocalFsPendingImageUploadStore` writing to
    `${HELIOS_STATE_DIR}/pending-image-uploads/{uuid}.{ext}` plus a
    sibling `.meta.json` (groupId, sweedGroupId, requestedByUserId,
    targetType, originalFilename, createdAt).
- New env var `HELIOS_STATE_DIR` (or reuse existing helios-prep state
  dir if one already exists); default `/var/lib/helios`.
- `S3PendingImageUploadStore` is *not* implemented in this phase —
  operator has mentioned a bucket exists but the exact name + creds
  are not yet wired. Backend selection happens via env var so adding
  the S3 impl later is a drop-in. See follow-on Phase 7.

### Phase 3 — Worker job type `catalog.maintenance.upload_group_image`

- Add the job type + payload schema to
  `src/shared/contracts/domain/jobs.ts`:
  ```
  CatalogMaintenanceUploadGroupImageJobPayload = {
    stagedRef: string,
    groupId: number,           // helios catalog_groups.id
    sweedGroupId: number,
    requestedByUserId: number | null,
    trigger: 'catalog_maintenance_group_image_upload',
  }
  ```
- Add handler `src/worker/jobs/catalogMaintenanceUploadGroupImageJob.ts`
  that mirrors today's `uploadCatalogMaintenanceImage` group-path:
  blob.add → PUT bytes → group.get → group.edit → verify → flag for
  reanalysis → invalidate maintenance survey cache → delete staged
  bytes.
- Register in `src/worker/runtime/jobRegistry.ts` handlers map AND
  add to `SWEED_BACKED_JOB_TYPES` so the runner wraps the handler in
  `withSweedSession()`.
- Add to `src/worker/runtime/jobPools.ts` mapping (likely `sweed`
  pool).
- Progress reporting via `payload_json.progress` (steps: `staged`,
  `blob-created`, `bytes-uploaded`, `attached`, `verified`,
  `survey-invalidated`, `done`) so the UI can show meaningful state.

### Phase 4 — Refactor `POST /api/catalog/maintenance/images`

- Replace the synchronous call to `uploadCatalogMaintenanceImage()` in
  `src/server/routes/catalogMaintenance.ts` with: stash via
  `PendingImageUploadStore` → `enqueueJob('catalog.maintenance.upload_
  group_image', payload, { priority: JOB_PRIORITY_HIGH })`.
- Response contract becomes:
  ```
  CatalogMaintenanceUploadResult = {
    status: 'queued',
    jobId: number,
    stagedRef: string,
    groupId: number,
    targetType: 'group',
  }
  ```
- Reject `targetType === 'variants'` with `HTTP 410 Gone` and an
  explanation pointing at the parked variant work.
- Delete the synchronous `uploadCatalogMaintenanceImage()` function
  (it has no other callers) along with its supporting code in
  `maintenance.ts` (`createBlob`, `putBlobBytes`,
  `fetchGroupImagesWithinLock`, `runInSweedWriteBatch`,
  `sweedWriteDealerId`, etc).

### Phase 5 — UI: queued + polling status per card

- Each per-card upload action now POSTs and receives
  `{ status: 'queued', jobId, stagedRef }`.
- The card banner moves through:
  - `queued (job #N) — waiting for Sweed pool`
  - `running step N/M`
  - `✓ uploaded` (then re-fetch the maintenance survey to clear the
    card)
  - `✗ failed: <reason>` with a **Retry** button. Retry POSTs to a
    new endpoint `/api/catalog/maintenance/images/:stagedRef/retry`
    that re-enqueues the same payload (no re-upload required).
- Status polling uses the existing `/api/jobs/:id` endpoint.

### Phase 6 — Staging GC

- Add a tiny periodic worker job `catalog.maintenance.upload_gc` (run
  every hour from `configWorkersScheduler.ts`) that:
  - lists staged refs older than 7 days
  - drops any whose job is in terminal state (`succeeded` |
    `failed_permanent`) OR whose job row no longer exists
- Surfaces orphan counts in worker metrics so we notice if the GC
  ever stops running.

### Phase 7 — S3 backend (follow-on; needs operator input)

Open question: which S3 bucket + which credential path?

Once the operator confirms:

- Add `@aws-sdk/client-s3` (current `package.json` does not have it).
- Add `S3PendingImageUploadStore` reading bucket name + region from
  env (`HELIOS_PENDING_UPLOAD_S3_BUCKET`, `…_REGION`,
  `…_KEY_PREFIX`) and creds from agenix.
- Switch backend via env var `HELIOS_PENDING_UPLOAD_BACKEND={fs|s3}`.

### Phase 8 — Runbook + cleanup

- `docs/helios/catalog-maintenance-pooled-async-uploads/RUNBOOK.md`
  covering: how to inspect staged uploads on disk, how to manually
  re-enqueue a stalled job, how to drain the pending dir after a
  hardware swap, how to read the per-card status banner.
- Drop `SWEED_AUTH_TOKEN` from the server's `getServerEnv()` zod
  schema (worker keeps it as a legacy fallback for now).

## Verification

- **Phase 1**: deploy + smoke test on `/catalog/maintenance`: a
  barcode edit on any in-stock variant returns 200 within 5s using a
  pool token (verifiable via `sweed_auth_events` rows tagged with the
  pool row id, *not* the env token). The image upload step still uses
  the old synchronous path post-phase-1 but now also goes through the
  pool — the immediate "dead env token" failure mode is gone.
- **Phase 3/4**: smoke test a real group-image upload end-to-end;
  confirm the staged file appears on disk, the job runs, the file is
  deleted, the image appears in the Sweed UI, and the maintenance
  survey hides the group from the "missing image" list.
- **Phase 5**: kill the worker mid-upload and confirm the card shows
  "queued — waiting" and self-heals on worker restart without losing
  bytes.
- **Phase 6**: artificially age a staged ref by `touch -d -8d` and
  confirm GC removes it on next cycle.

## Out of scope (today)

- Variant-image uploads (still parked until we identify the correct
  Sweed RPC for variant-level images).
- "Invalid barcode" classification (operator has not yet defined what
  invalid means; we surface only *missing* barcodes).
- Migrating worker-side direct env-token paths — the worker already
  uses `withSweedSession()` everywhere via the job-runner wrap.
