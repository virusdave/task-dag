# Pending-purchase packet REPL runbook

Operator runbook for the pending-purchase refinement workflow introduced for
[automation#70](https://github.com/FreshlyBakedNYC/automation/issues/70). The
design record is
[`docs/helios/pending-purchase-repl-design.md`](./pending-purchase-repl-design.md).

## Quick links

- Reviewer UI: <https://helios.freshlybaked.us/catalog/pending-purchases>

<details>
<summary>Implementation references</summary>

- Design: [`pending-purchase-repl-design.md`](./pending-purchase-repl-design.md)
- Migration: [`102_pending_purchase_refinement_lineage.sql`](../../helios/src/server/db/migrations/102_pending_purchase_refinement_lineage.sql)
- Down migration: [`102_pending_purchase_refinement_lineage.down.sql`](../../helios/src/server/db/migrations/102_pending_purchase_refinement_lineage.down.sql)
- API routes: [`pendingPurchases.ts`](../../helios/src/server/routes/pendingPurchases.ts)
- Revision queries: [`pendingPurchaseRefinementQueries.ts`](../../helios/src/server/db/queries/pendingPurchaseRefinementQueries.ts)
- Refinement worker: [`refinePendingPurchasePacketJob.ts`](../../helios/src/worker/jobs/refinePendingPurchasePacketJob.ts)
- Reviewer page: [`PendingPurchasesPage.tsx`](../../helios/src/client/routes/catalog/PendingPurchasesPage.tsx)

</details>

## Normal operator flow

1. Open **Catalog → Pending purchases** and open the packet rows view.
2. In **Ask the packet analyst**, describe the packet-wide correction. Keep row
   ids/product names in the feedback when possible.
3. Submit. The UI keeps the feedback text in place while the job runs so a
   failed or stale turn can be edited and retried without retyping.
4. When a candidate appears, inspect the changed-field chips and row cards.
   Timestamps shown in the turn history use New York time via the shared
   `nyLongDateTime` helper.
5. Click **Accept candidate** only after the candidate row review looks right.
   The previous current revision becomes non-applyable and the candidate becomes
   current/applyable.
6. Approve the candidate rows that should be applied. Candidate rows begin
   pending; accepting the packet revision does not approve its rows.
7. Queue apply only from the current revision. The server rejects candidate,
   superseded, failed, or otherwise non-current packets even if the UI is stale.
8. If the accepted revision is wrong, open the older revision and use
   **Rollback**. Review apply history first; rollback changes the packet review
   pointer, not any Sweed writes that have already happened.

## What is live

- A current packet revision may receive feedback from the "Ask the packet
  analyst" box.
- Submission stores the exact feedback text, row snapshot hash, root version,
  target revision, requester, and queued job id in
  `pending_purchase_refinement_turns`.
- The reviewer history response exposes the feedback hash, status, error, model,
  prompt version, and timestamps. It does not return the stored feedback text;
  the browser preserves the submitted text locally for an immediate retry.
- The worker verifies the target revision is still current and the row snapshot
  still matches before creating a candidate revision.
- Successful refinement creates a candidate packet revision. Candidate revisions
  are visible for review and diffing but are not applyable.
- The operator must accept a candidate before apply. Rollback uses the same
  revision-switch operation pointed at an earlier safe revision.
- Failed refinement turns keep their status/error and never supersede the
  current packet.

## Migration verification

Migration 102 is an explicit pending migration. Do not apply it without the
normal Oracle/operator approval path. After an approved apply, verify the
schema shape read-only:

```sql
select to_regclass('pending_purchase_packet_roots') is not null as has_roots,
       to_regclass('pending_purchase_refinement_turns') is not null as has_turns;

select column_name
  from information_schema.columns
 where table_schema = current_schema()
   and table_name = 'pending_purchase_packets'
   and column_name in ('packet_root_id', 'revision_number', 'revision_status', 'is_applyable')
 order by column_name;

select column_name
  from information_schema.columns
 where table_schema = current_schema()
   and table_name = 'pending_purchase_rows'
   and column_name in ('row_lineage_id', 'lineage_revision_number', 'row_snapshot_sha256', 'refinement_provenance_json')
 order by column_name;

select p.id, p.packet_root_id, p.revision_number, p.revision_status, p.is_applyable
  from pending_purchase_packets p
 order by p.id desc
 limit 20;
```

Expected: ready legacy packets are backfilled as revision 1/current/applyable;
superseded archive packets are non-current/non-applyable.

## Deployment verification

After a normal `self-deploy-helios`, verify:

```sh
systemctl is-active helios-server.service helios-worker.service
test "$(systemctl show helios-prep.service -p Result --value)" = success
journalctl -u helios-worker.service -n 80 --no-pager
curl -sSI https://helios.freshlybaked.us/healthzz
```

`helios-prep` is a oneshot and may correctly be inactive after success; its
`Result` must be `success`. The worker journal need not contain a recent
refinement entry when no refinement has run.

### Safe verification without credentials

The production workflow cannot be exercised end to end anonymously because
feedback submission requires an editor session and acceptance requires an
editor session. Do not create a production turn merely to prove a deployment.
Use the deterministic in-process integration test for the mutation path, then
verify only health, route registration/authentication, and worker startup in
production:

```sh
cd helios
npm run test -- src/server/routes/pendingPurchases.refinement.test.ts

test "$(curl -sS -o /dev/null -w '%{http_code}' \
  https://helios.freshlybaked.us/api/catalog/pending-purchases/1/refinement-history)" = 401
curl -fsS https://helios.freshlybaked.us/healthzz
```

The test uses `Fastify.inject`, stateful query fakes, a deterministic model
response, and no network, database, Sweed session, or production credential. It
exercises route/worker orchestration across submission, worker refinement,
candidate history/diff, pre-acceptance apply rejection, acceptance, row
approval, post-acceptance apply eligibility, stale worker rejection, and
failed-model preservation. The focused query tests separately cover the SQL
persistence transitions.

An authenticated functional check is optional and creates durable production
turn/history records plus a model request. Only perform it when there is a real
packet correction to review, not as a deployment smoke. In that case:

- Open a current packet; the refinement panel should show the current revision
  and root version.
- Submit the real correction against the intended packet.
- Confirm a queued turn appears in history, then either a candidate revision or
  a failed turn with an error message appears.
- Confirm candidate apply is blocked until accepted.

## Read-only production diagnostics

Recent turns:

```sql
select t.id,
       t.status,
       t.target_packet_id,
       t.candidate_packet_id,
       t.job_id,
       t.created_at,
       t.started_at,
       t.finished_at,
       t.error_message
  from pending_purchase_refinement_turns t
 order by t.created_at desc
 limit 20;
```

Revision tree for one packet root:

```sql
select r.id as root_id,
       r.current_packet_id,
       r.current_revision_number,
       r.version as root_version,
       p.id as packet_id,
       p.revision_number,
       p.revision_status,
       p.is_applyable,
       p.parent_packet_id,
       p.source_refinement_turn_id
  from pending_purchase_packet_roots r
  join pending_purchase_packets p on p.packet_root_id = r.id
 where r.id = $1
 order by p.revision_number asc, p.id asc;
```

Lineage diff for a candidate packet:

```sql
select c.row_lineage_id,
       c.parent_row_id,
       p.packet_id as parent_packet_id,
       c.packet_id as candidate_packet_id,
       p.target_brand as before_brand,
       c.target_brand as after_brand,
       p.proposed_price as before_price,
       c.proposed_price as after_price
  from pending_purchase_rows c
  join pending_purchase_rows p on p.id = c.parent_row_id
 where c.packet_id = $1
 order by c.id asc;
```

## Rollback

### Bad candidate not accepted

Do not accept it. Leave the failed/bad candidate for audit, submit clearer
feedback, or continue with manual row overrides on the current revision.

### Bad candidate accepted but not applied

Use the UI rollback button to switch the root current pointer back to the prior
revision. This is transactional and increments the root version. Verify the
prior revision is current/applyable in the revision tree query above.

### Bad revision already applied to Sweed

Rollback only changes Helios packet review state. It does not undo live Sweed
catalog writes. Use the normal catalog/audit repair path for the specific Sweed
products, then record the incident context on the refinement turn or follow-up
issue.

### Code rollback

If the feature itself must be reverted before production refinements matter,
revert the application commit and deploy normally. Migration 102 has a down
file, but it drops refinement history and lineage columns; do not run it in
production unless the operator explicitly approves that data loss and Oracle has
reviewed the rollback plan.

## Page Dave when

- A turn is stuck `queued`/`running` after the worker has cycled and the job is
  terminal or missing.
- The apply route accepts a non-current/candidate packet (this is a stop-the-line
  safety bug).
- A failed turn supersedes or mutates the current packet.
- Migration 102 verification disagrees with the pending-migrations banner.
- You need to run the destructive down migration in production.
