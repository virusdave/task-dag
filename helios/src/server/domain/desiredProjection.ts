import type { JsonValue } from '../../shared/contracts/common/json.js'
import type { FieldPath } from '../../shared/domain/fieldPaths.js'
import { sha256, stableJsonStringify } from '../../shared/util/hash.js'

export interface DesiredProjectionField {
  desiredValue: JsonValue
  fieldPath: FieldPath
  revisionId: number
  targetEntityId: number
  targetEntityType: 'catalog_group' | 'catalog_product'
}

export interface DesiredProjection {
  catalogGroupId: number
  fields: DesiredProjectionField[]
}

export function buildDesiredProjection(catalogGroupId: number, fields: DesiredProjectionField[]): DesiredProjection {
  return {
    catalogGroupId,
    fields: [...fields].sort(compareDesiredProjectionField),
  }
}

export function getDesiredProjectionHash(projection: DesiredProjection): string {
  return sha256(stableJsonStringify(projection))
}

function compareDesiredProjectionField(left: DesiredProjectionField, right: DesiredProjectionField): number {
  if (left.targetEntityType !== right.targetEntityType) {
    return left.targetEntityType.localeCompare(right.targetEntityType)
  }
  if (left.targetEntityId !== right.targetEntityId) {
    return left.targetEntityId - right.targetEntityId
  }
  if (left.fieldPath !== right.fieldPath) {
    return left.fieldPath.localeCompare(right.fieldPath)
  }
  return left.revisionId - right.revisionId
}
