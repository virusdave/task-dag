-- Inverse of 102: remove pending-purchase refinement lineage / REPL schema.
--
-- Safe only before any production refinement behavior depends on these fields.
-- Destructive: drops refinement turn history, packet-root metadata, packet
-- revision metadata, and row-lineage/provenance columns introduced by 102.
-- Existing legacy packet/row/apply tables otherwise remain intact.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop index if exists pending_purchase_rows_parent_row_idx;
drop index if exists pending_purchase_rows_lineage_packet_idx;
drop index if exists pending_purchase_refinement_turns_one_active_idx;
drop index if exists pending_purchase_refinement_turns_root_created_idx;
drop index if exists pending_purchase_packet_roots_current_packet_idx;
drop index if exists pending_purchase_packets_root_created_idx;
drop index if exists pending_purchase_packets_one_current_per_root_idx;
drop index if exists pending_purchase_packets_root_revision_unique;

alter table pending_purchase_rows
  drop constraint if exists pending_purchase_rows_source_refinement_turn_id_fkey,
  drop constraint if exists pending_purchase_rows_parent_packet_id_fkey,
  drop constraint if exists pending_purchase_rows_parent_row_id_fkey,
  drop constraint if exists pending_purchase_rows_refinement_provenance_size_check,
  drop constraint if exists pending_purchase_rows_row_snapshot_sha256_check,
  drop constraint if exists pending_purchase_rows_lineage_revision_positive_check,
  drop constraint if exists pending_purchase_rows_row_lineage_id_check;

alter table pending_purchase_packets
  drop constraint if exists pending_purchase_packets_source_refinement_turn_id_fkey,
  drop constraint if exists pending_purchase_packets_accepted_by_user_id_fkey,
  drop constraint if exists pending_purchase_packets_parent_packet_id_fkey,
  drop constraint if exists pending_purchase_packets_packet_root_id_fkey,
  drop constraint if exists pending_purchase_packets_applyable_revision_check,
  drop constraint if exists pending_purchase_packets_root_revision_pair_check,
  drop constraint if exists pending_purchase_packets_revision_number_positive_check,
  drop constraint if exists pending_purchase_packets_revision_status_check;

drop table if exists pending_purchase_refinement_turns;

alter table pending_purchase_rows
  drop column if exists refinement_provenance_json,
  drop column if exists row_snapshot_sha256,
  drop column if exists lineage_revision_number,
  drop column if exists source_refinement_turn_id,
  drop column if exists parent_packet_id,
  drop column if exists parent_row_id,
  drop column if exists row_lineage_id;

alter table pending_purchase_packets
  drop column if exists accepted_by_user_id,
  drop column if exists accepted_at,
  drop column if exists revision_created_reason,
  drop column if exists source_refinement_turn_id,
  drop column if exists parent_packet_id,
  drop column if exists is_applyable,
  drop column if exists revision_status,
  drop column if exists revision_number,
  drop column if exists packet_root_id;

drop table if exists pending_purchase_packet_roots;

commit;

\echo 'Migration 102 down complete.'
