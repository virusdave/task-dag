import type { QueryResultRow } from 'pg'

import type { JsonValue } from '../../../shared/contracts/common/json.js'
import type { FieldPath } from '../../../shared/domain/fieldPaths.js'
import type { Queryable } from '../pool.js'

export interface ActiveDesiredStateFieldRow {
  desiredValue: JsonValue
  fieldPath: FieldPath
  paused: boolean
  revisionId: number
  targetEntityId: number
  targetEntityType: 'catalog_group' | 'catalog_product'
}

interface DesiredStateFieldQueryRow extends QueryResultRow {
  desired_value_json: JsonValue
  field_path: FieldPath
  id: number
  paused: boolean
  target_entity_id: number
  target_entity_type: 'catalog_group' | 'catalog_product'
}

export async function listActiveDesiredStateFields(
  db: Queryable,
  catalogGroupId: number,
): Promise<ActiveDesiredStateFieldRow[]> {
  const result = await db.query<DesiredStateFieldQueryRow>(
    `
      select
        id,
        target_entity_type,
        target_entity_id,
        field_path,
        desired_value_json,
        paused
      from desired_state_revisions
      where catalog_group_id = $1
        and active = true
      order by target_entity_type asc, target_entity_id asc, field_path asc, id asc
    `,
    [catalogGroupId],
  )

  return result.rows.map((row) => ({
    desiredValue: row.desired_value_json,
    fieldPath: row.field_path,
    paused: row.paused,
    revisionId: row.id,
    targetEntityId: row.target_entity_id,
    targetEntityType: row.target_entity_type,
  }))
}
