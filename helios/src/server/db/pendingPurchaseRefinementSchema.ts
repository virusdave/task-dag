import type { Queryable } from './pool.js'

interface SchemaAppliedRow {
  schema_applied: boolean
}

/** One canonical, cache-free readiness probe for migration 102 consumers. */
export async function pendingPurchaseRefinementSchemaApplied(db: Queryable): Promise<boolean> {
  const result = await db.query<SchemaAppliedRow>(`
    with expected_columns(table_name, column_name) as (values
      ('pending_purchase_packet_roots', 'id'),
      ('pending_purchase_packet_roots', 'root_key'),
      ('pending_purchase_packet_roots', 'source_packet_id'),
      ('pending_purchase_packet_roots', 'current_packet_id'),
      ('pending_purchase_packet_roots', 'current_revision_number'),
      ('pending_purchase_packet_roots', 'root_status'),
      ('pending_purchase_packet_roots', 'version'),
      ('pending_purchase_packet_roots', 'created_by_user_id'),
      ('pending_purchase_packet_roots', 'current_updated_by_user_id'),
      ('pending_purchase_packet_roots', 'current_updated_at'),
      ('pending_purchase_packet_roots', 'created_at'),
      ('pending_purchase_packet_roots', 'updated_at'),
      ('pending_purchase_packets', 'packet_root_id'),
      ('pending_purchase_packets', 'revision_number'),
      ('pending_purchase_packets', 'revision_status'),
      ('pending_purchase_packets', 'is_applyable'),
      ('pending_purchase_packets', 'parent_packet_id'),
      ('pending_purchase_packets', 'source_refinement_turn_id'),
      ('pending_purchase_packets', 'revision_created_reason'),
      ('pending_purchase_packets', 'accepted_at'),
      ('pending_purchase_packets', 'accepted_by_user_id'),
      ('pending_purchase_refinement_turns', 'id'),
      ('pending_purchase_refinement_turns', 'packet_root_id'),
      ('pending_purchase_refinement_turns', 'target_packet_id'),
      ('pending_purchase_refinement_turns', 'target_revision_number'),
      ('pending_purchase_refinement_turns', 'target_root_version'),
      ('pending_purchase_refinement_turns', 'status'),
      ('pending_purchase_refinement_turns', 'job_id'),
      ('pending_purchase_refinement_turns', 'requested_by_user_id'),
      ('pending_purchase_refinement_turns', 'feedback_text'),
      ('pending_purchase_refinement_turns', 'feedback_sha256'),
      ('pending_purchase_refinement_turns', 'row_snapshot_sha256'),
      ('pending_purchase_refinement_turns', 'row_snapshot_json'),
      ('pending_purchase_refinement_turns', 'prompt_context_json'),
      ('pending_purchase_refinement_turns', 'model'),
      ('pending_purchase_refinement_turns', 'prompt_version'),
      ('pending_purchase_refinement_turns', 'candidate_packet_id'),
      ('pending_purchase_refinement_turns', 'error_message'),
      ('pending_purchase_refinement_turns', 'created_at'),
      ('pending_purchase_refinement_turns', 'started_at'),
      ('pending_purchase_refinement_turns', 'finished_at'),
      ('pending_purchase_refinement_turns', 'updated_at'),
      ('pending_purchase_rows', 'row_lineage_id'),
      ('pending_purchase_rows', 'parent_row_id'),
      ('pending_purchase_rows', 'parent_packet_id'),
      ('pending_purchase_rows', 'source_refinement_turn_id'),
      ('pending_purchase_rows', 'lineage_revision_number'),
      ('pending_purchase_rows', 'row_snapshot_sha256'),
      ('pending_purchase_rows', 'refinement_provenance_json')
    ),
    expected_constraints(table_name, constraint_name) as (values
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_pkey'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_root_key_key'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_source_packet_id_key'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_root_key_check'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_status_check'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_version_positive_check'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_current_pair_check'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_active_has_current_check'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_current_revision_positive_check'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_source_packet_id_fkey'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_current_packet_id_fkey'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_created_by_user_id_fkey'),
      ('pending_purchase_packet_roots', 'pending_purchase_packet_roots_current_updated_by_user_id_fkey'),
      ('pending_purchase_packets', 'pending_purchase_packets_revision_status_check'),
      ('pending_purchase_packets', 'pending_purchase_packets_revision_number_positive_check'),
      ('pending_purchase_packets', 'pending_purchase_packets_root_revision_pair_check'),
      ('pending_purchase_packets', 'pending_purchase_packets_applyable_revision_check'),
      ('pending_purchase_packets', 'pending_purchase_packets_packet_root_id_fkey'),
      ('pending_purchase_packets', 'pending_purchase_packets_parent_packet_id_fkey'),
      ('pending_purchase_packets', 'pending_purchase_packets_accepted_by_user_id_fkey'),
      ('pending_purchase_packets', 'pending_purchase_packets_source_refinement_turn_id_fkey'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_pkey'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_status_check'),
      ('pending_purchase_refinement_turns', 'pp_refinement_turns_target_revision_positive_check'),
      ('pending_purchase_refinement_turns', 'pp_refinement_turns_target_root_version_positive_check'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_feedback_nonempty_check'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_feedback_size_check'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_feedback_sha256_check'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_row_snapshot_sha256_check'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_row_snapshot_size_check'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_prompt_context_size_check'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_packet_root_id_fkey'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_target_packet_id_fkey'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_candidate_packet_id_fkey'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_job_id_fkey'),
      ('pending_purchase_refinement_turns', 'pending_purchase_refinement_turns_requested_by_user_id_fkey'),
      ('pending_purchase_rows', 'pending_purchase_rows_row_lineage_id_check'),
      ('pending_purchase_rows', 'pending_purchase_rows_lineage_revision_positive_check'),
      ('pending_purchase_rows', 'pending_purchase_rows_row_snapshot_sha256_check'),
      ('pending_purchase_rows', 'pending_purchase_rows_refinement_provenance_size_check'),
      ('pending_purchase_rows', 'pending_purchase_rows_parent_row_id_fkey'),
      ('pending_purchase_rows', 'pending_purchase_rows_parent_packet_id_fkey'),
      ('pending_purchase_rows', 'pending_purchase_rows_source_refinement_turn_id_fkey')
    ),
    expected_indexes(index_name) as (values
      ('pending_purchase_packets_root_revision_unique'),
      ('pending_purchase_packets_one_current_per_root_idx'),
      ('pending_purchase_packets_root_created_idx'),
      ('pending_purchase_packet_roots_current_packet_idx'),
      ('pending_purchase_refinement_turns_root_created_idx'),
      ('pending_purchase_refinement_turns_one_active_idx'),
      ('pending_purchase_rows_lineage_packet_idx'),
      ('pending_purchase_rows_parent_row_idx')
    )
    select
      not exists (
        select 1
        from expected_columns expected
        left join information_schema.columns actual
          on actual.table_schema = current_schema()
         and actual.table_name = expected.table_name
         and actual.column_name = expected.column_name
        where actual.column_name is null
      )
      and not exists (
        select 1
        from expected_constraints expected
        left join pg_namespace namespace_row
          on namespace_row.nspname = current_schema()
        left join pg_class table_row
          on table_row.relnamespace = namespace_row.oid
         and table_row.relname = expected.table_name
        left join pg_constraint constraint_row
          on constraint_row.conrelid = table_row.oid
         and constraint_row.conname = expected.constraint_name
        where constraint_row.oid is null
      )
      and not exists (
        select 1
        from expected_indexes expected
        left join pg_namespace namespace_row
          on namespace_row.nspname = current_schema()
        left join pg_class index_row
          on index_row.relnamespace = namespace_row.oid
         and index_row.relname = expected.index_name
        left join pg_index index_state
          on index_state.indexrelid = index_row.oid
         and index_state.indisvalid
         and index_state.indisready
        where namespace_row.oid is null or index_state.indexrelid is null
      ) as schema_applied
  `)
  return result.rows[0]?.schema_applied === true
}
