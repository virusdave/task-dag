import type { JsonValue } from '../../shared/contracts/common/json.js'
import type { DesiredProjectionField } from '../../server/domain/desiredProjection.js'
import { stableJsonStringify } from '../../shared/util/hash.js'
import {
  getLiveStateFieldValue,
  normalizeDescriptionText,
  type NormalizedCatalogGroupLiveState,
} from '../catalog/liveState.js'

export interface DesiredProjectionAssessment {
  driftedFields: DesiredProjectionField[]
  unsupportedReadFields: DesiredProjectionField[]
  unsupportedWriteFields: DesiredProjectionField[]
}

export function assessDesiredProjectionAgainstLiveState(
  liveState: NormalizedCatalogGroupLiveState,
  fields: DesiredProjectionField[],
): DesiredProjectionAssessment {
  const driftedFields: DesiredProjectionField[] = []
  const unsupportedReadFields: DesiredProjectionField[] = []
  const unsupportedWriteFields: DesiredProjectionField[] = []

  for (const field of fields) {
    if (!canReadField(field)) {
      unsupportedReadFields.push(field)
      unsupportedWriteFields.push(field)
      continue
    }

    if (!fieldMatchesLiveState(liveState, field)) {
      driftedFields.push(field)
      if (!canWriteField(field)) {
        unsupportedWriteFields.push(field)
      }
    }
  }

  return {
    driftedFields,
    unsupportedReadFields,
    unsupportedWriteFields,
  }
}

export function formatProjectionFieldLabel(field: DesiredProjectionField): string {
  return `${field.targetEntityType}:${field.targetEntityId}:${field.fieldPath}`
}

export function getDescriptionField(fields: DesiredProjectionField[]): DesiredProjectionField | null {
  return fields.find((field) => field.targetEntityType === 'catalog_group' && field.fieldPath === 'description') ?? null
}

function canReadField(field: DesiredProjectionField): boolean {
  return (
    (field.targetEntityType === 'catalog_group' && field.fieldPath === 'description') ||
    (field.targetEntityType === 'catalog_product' && field.fieldPath === 'products.price')
  )
}

function canWriteField(field: DesiredProjectionField): boolean {
  return (
    (field.targetEntityType === 'catalog_group' && field.fieldPath === 'description') ||
    (field.targetEntityType === 'catalog_product' && field.fieldPath === 'products.price')
  )
}

function fieldMatchesLiveState(liveState: NormalizedCatalogGroupLiveState, field: DesiredProjectionField): boolean {
  const liveValue = getLiveStateFieldValue(liveState, field.targetEntityType, field.targetEntityId, field.fieldPath)
  const desiredValue = normalizeDesiredFieldValue(field)
  return stableJsonStringify(liveValue) === stableJsonStringify(desiredValue)
}

function normalizeDesiredFieldValue(field: DesiredProjectionField): JsonValue {
  if (field.fieldPath === 'description') {
    return normalizeDescriptionText(typeof field.desiredValue === 'string' ? field.desiredValue : String(field.desiredValue ?? ''))
  }

  if (field.fieldPath === 'products.price') {
    return typeof field.desiredValue === 'number' ? field.desiredValue : null
  }

  return field.desiredValue
}
