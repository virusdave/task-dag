// =====================================================================
// Customer-Sentiment Capture (issue #13, A4 phase) — Sweed segment
// add/remove orchestrator.
//
// Pure-ish helpers that decide which per-site segments to attempt
// against Sweed for a given drawing entry, perform the actual Sweed
// RPCs inside one withSweedSession block, and return a result record
// that the route layer persists.
//
// The orchestrator is the ONLY caller of withSweedSession in this
// area. The route handlers and admin actions stay free of Sweed
// transport concerns.
// =====================================================================

import {
  addSegmentMember,
  findOrCreateSweedClientForContacts,
  removeSegmentMember,
  type FoundSweedClient,
} from '../../worker/sweed/customers.js'
import { withSweedSession } from '../../worker/sweed/session.js'

export type SegmentStatus = 'skipped' | 'failed' | 'added' | 'removed'

export interface PerSegmentOutcome {
  status: SegmentStatus
  error: string | null
  segmentId: number | null
  attemptedAt: Date | null
}

const SKIPPED: PerSegmentOutcome = {
  status: 'skipped',
  error: null,
  segmentId: null,
  attemptedAt: null,
}

interface DrawingSegmentInputs {
  dealerId: number
  drawingSegmentId: number | null
  freePrerollSegmentId: number | null
  // Whether the LLM-gate path made the customer eligible for the
  // free-preroll segment (strong-with-text OR degraded-pass).
  freePrerollEligibleByVerdict: boolean
  acceptedPasteOffer: boolean
  contacts: ReadonlyArray<{ kind: 'phone' | 'email' | 'name' | 'other'; value: string }>
}

export interface DrawingSegmentResult {
  customer: FoundSweedClient | null
  drawing: PerSegmentOutcome
  freePreroll: PerSegmentOutcome
}

/**
 * Decide whether the free-preroll segment SHOULD be attempted for
 * this drawing entry. Returns true iff:
 *
 *   - the per-site `sweed_free_preroll_segment_id` is non-null AND
 *   - the LLM verdict made the customer eligible (strong-with-text
 *     or degraded-pass) AND
 *   - the customer accepted the paste-text offer on the drawing form
 */
export function shouldAttemptFreePreroll(args: {
  freePrerollSegmentId: number | null
  freePrerollEligibleByVerdict: boolean
  acceptedPasteOffer: boolean
}): boolean {
  if (args.freePrerollSegmentId === null) return false
  if (!args.freePrerollEligibleByVerdict) return false
  if (!args.acceptedPasteOffer) return false
  return true
}

export async function performDrawingSegmentAdd(
  input: DrawingSegmentInputs,
): Promise<DrawingSegmentResult> {
  const attemptDrawing = input.drawingSegmentId !== null
  const attemptFreePreroll = shouldAttemptFreePreroll({
    freePrerollSegmentId: input.freePrerollSegmentId,
    freePrerollEligibleByVerdict: input.freePrerollEligibleByVerdict,
    acceptedPasteOffer: input.acceptedPasteOffer,
  })

  if (!attemptDrawing && !attemptFreePreroll) {
    return { customer: null, drawing: SKIPPED, freePreroll: SKIPPED }
  }

  return withSweedSession(async () => {
    let customer: FoundSweedClient | null = null
    try {
      customer = await findOrCreateSweedClientForContacts({
        dealerId: input.dealerId,
        contacts: input.contacts,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        customer: null,
        drawing: attemptDrawing
          ? {
              status: 'failed' as const,
              error: `find/create client failed: ${reason}`,
              segmentId: input.drawingSegmentId,
              attemptedAt: new Date(),
            }
          : SKIPPED,
        freePreroll: attemptFreePreroll
          ? {
              status: 'failed' as const,
              error: `find/create client failed: ${reason}`,
              segmentId: input.freePrerollSegmentId,
              attemptedAt: new Date(),
            }
          : SKIPPED,
      }
    }

    if (customer === null) {
      // No phone/email captured -> nothing to add to a segment.
      return {
        customer: null,
        drawing: attemptDrawing
          ? {
              status: 'skipped' as const,
              error: 'no phone or email contact captured',
              segmentId: input.drawingSegmentId,
              attemptedAt: new Date(),
            }
          : SKIPPED,
        freePreroll: attemptFreePreroll
          ? {
              status: 'skipped' as const,
              error: 'no phone or email contact captured',
              segmentId: input.freePrerollSegmentId,
              attemptedAt: new Date(),
            }
          : SKIPPED,
      }
    }

    const drawingOutcome: PerSegmentOutcome = attemptDrawing
      ? await callAdd(input.dealerId, input.drawingSegmentId!, customer.customerId)
      : SKIPPED
    const freePrerollOutcome: PerSegmentOutcome = attemptFreePreroll
      ? await callAdd(input.dealerId, input.freePrerollSegmentId!, customer.customerId)
      : SKIPPED
    return {
      customer,
      drawing: drawingOutcome,
      freePreroll: freePrerollOutcome,
    }
  })
}

async function callAdd(
  dealerId: number,
  segmentId: number,
  customerId: number,
): Promise<PerSegmentOutcome> {
  try {
    await addSegmentMember({ dealerId, segmentId, customerId })
    return { status: 'added', error: null, segmentId, attemptedAt: new Date() }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: 'failed', error: reason, segmentId, attemptedAt: new Date() }
  }
}

/**
 * Operator-driven force-add (per /reviews/<id> action). Reuses the
 * same find-or-create + addSegmentMember path so a previously-failed
 * row can be retried without first hand-creating the Sweed client.
 */
export async function performForceSegmentAdd(input: {
  dealerId: number
  segmentId: number
  contacts: ReadonlyArray<{ kind: 'phone' | 'email' | 'name' | 'other'; value: string }>
  existingCustomerId: number | null
}): Promise<{ customer: FoundSweedClient | null; outcome: PerSegmentOutcome }> {
  return withSweedSession(async () => {
    let customerId = input.existingCustomerId
    let customer: FoundSweedClient | null = null
    if (customerId === null) {
      try {
        customer = await findOrCreateSweedClientForContacts({
          dealerId: input.dealerId,
          contacts: input.contacts,
        })
        customerId = customer?.customerId ?? null
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          customer: null,
          outcome: {
            status: 'failed',
            error: `find/create client failed: ${reason}`,
            segmentId: input.segmentId,
            attemptedAt: new Date(),
          },
        }
      }
    }
    if (customerId === null) {
      return {
        customer: null,
        outcome: {
          status: 'skipped',
          error: 'no phone or email contact captured',
          segmentId: input.segmentId,
          attemptedAt: new Date(),
        },
      }
    }
    return {
      customer,
      outcome: await callAdd(input.dealerId, input.segmentId, customerId),
    }
  })
}

export async function performForceSegmentRemove(input: {
  dealerId: number
  segmentId: number
  customerId: number
}): Promise<PerSegmentOutcome> {
  return withSweedSession(async () => {
    try {
      await removeSegmentMember({
        dealerId: input.dealerId,
        segmentId: input.segmentId,
        customerId: input.customerId,
      })
      return {
        status: 'removed',
        error: null,
        segmentId: input.segmentId,
        attemptedAt: new Date(),
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        status: 'failed',
        error: reason,
        segmentId: input.segmentId,
        attemptedAt: new Date(),
      }
    }
  })
}
