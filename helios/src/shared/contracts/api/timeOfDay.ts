import { z } from 'zod'

// Time-of-day analytics: a weekday × hour grid of order economics, used
// to reason about staffing / hours-of-operation / delivery economics by
// time of day. ADMIN-ONLY surface (see /api/time-of-day-analytics).
//
// Conventions (mirror the rest of /metrics):
//   * Weekday is the BUSINESS weekday: the business day rolls at 08:00 ET
//     (HELIOS_BUSINESS_DAY_START_HOUR), so an order at 01:30 ET Tuesday
//     belongs to the MONDAY business-weekday row. `weekday` is Postgres
//     `dow`: 0 = Sunday … 6 = Saturday.
//   * Hour is the LOCAL wall-clock hour (America/New_York), 0–23, of the
//     actual sale instant — so that 01:30 ET sale lands in the `1` column
//     of the Monday row.
//   * Money is reported as FIVE bases per cell (the client picks which to
//     show without a refetch); definitions match the rest of helios
//     (see sweedOrdersQueries.ts). NB: the Sweed header `subtotal` is
//     ex-tax POST-discount and `grand_total` is incl-tax POST-discount;
//     the header discount column is ~always 0, so GROSS (pre-discount) is
//     reconstructed by adding the per-line discount.
//       grossSales    = subtotal + ex-tax line discount (ex-tax, PRE-discount)
//       netSales      = subtotal                        (ex-tax, post-discount)
//       grossReceipts = grand total + OTD line discount (incl. tax, PRE-discount)
//       netReceipts   = grand total                     (incl. tax, post-discount)
//       margin        = Σ line (revenue − qty×package cost), invoice grain
//   * `orders` is the count of distinct non-cancelled invoices in the cell.
//   * `occurrencesByWeekday[dow]` is the number of business-days of that
//     weekday inside the window — the denominator for "average per
//     occurrence" (e.g. average per Monday). Zero-order hours still have
//     occurrences, so the client can divide safely.

// Slices map onto the canonical fulfillment classifier
// (FULFILLMENT_SERIES_SQL_EXPR_SO → delivery_prepaid | delivery_cod |
// pickup | pickup_prepaid | kiosk | in_store). `delivery` folds both
// delivery variants together; the rest are 1:1. Mutually exclusive +
// exhaustive so a slice never double-counts an order.
export const TimeOfDayFulfillmentSliceSchema = z.enum([
  'all',
  'delivery',
  'pickup',
  'pickup_prepaid',
  'kiosk',
  'in_store',
])
export type TimeOfDayFulfillmentSlice = z.infer<typeof TimeOfDayFulfillmentSliceSchema>

export const TimeOfDayCellSchema = z.object({
  /** Postgres dow of the BUSINESS day: 0 = Sunday … 6 = Saturday. */
  weekday: z.number().int().min(0).max(6),
  /** Local (America/New_York) wall-clock hour of the sale, 0–23. */
  hour: z.number().int().min(0).max(23),
  grossSales: z.number(),
  netSales: z.number(),
  grossReceipts: z.number(),
  netReceipts: z.number(),
  margin: z.number(),
  orders: z.number().int().nonnegative(),
})
export type TimeOfDayCell = z.infer<typeof TimeOfDayCellSchema>

export const TimeOfDayResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  sites: z.array(z.string()),
  fulfillment: TimeOfDayFulfillmentSliceSchema,
  /** Indexed by Postgres dow (0–6): number of business-days of that
   *  weekday in [from, to). The "per occurrence" averaging denominator. */
  occurrencesByWeekday: z.array(z.number().int().nonnegative()).length(7),
  /** Only non-empty (weekday, hour) aggregates are returned; the client
   *  fills the full grid (and marks closed hours) itself. */
  cells: z.array(TimeOfDayCellSchema),
})
export type TimeOfDayResponse = z.infer<typeof TimeOfDayResponseSchema>
