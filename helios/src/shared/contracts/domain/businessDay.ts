// ============================================================================
// Retail "business day" definition — the single source of truth for every
// aggregate / bucketing surface in helios (server SQL, server JS bucket
// walker, client tick alignment, and the Essentials "today" summary).
//
// Operator rule (Dave, 2026-06-05): a business day runs **8:00am → 4:00am
// the next calendar day**, in America/New_York. Every transaction whose ET
// wall-clock time is in `[08:00 day D, 04:00 day D+1)` belongs to business
// day D. The store is closed 04:00–08:00, so the rollover point is anchored
// at **08:00 ET** — equivalently:
//
//     business_date(t) = date( (t AT TIME ZONE 'America/New_York')
//                                - interval '8 hours' )
//
// and the canonical bucket-start instant for business day D is **08:00 ET on
// date D** (a real, DST-aware UTC instant: 12:00Z under EDT, 13:00Z under
// EST).
//
// Why this matters: bucketing at calendar midnight (or the previous 04:00
// convention) lumped pre-open prepaid pickup/preorders placed between
// midnight and 08:00 into "today", so the Essentials banner showed sales
// before the business had opened for the day. Anchoring at 08:00 rolls
// those pre-open orders back into the previous business day.
//
// NOTE — `hour`-grain bucketing is intentionally NOT shifted; it stays at
// UTC top-of-hour (NY's whole-hour offset keeps UTC and NY hour boundaries
// aligned, and UTC hour stepping avoids the fall-back-Sunday ambiguity where
// 01:00 ET happens twice). The business-day shift applies only to the
// day / week / month / total grains.
// ============================================================================

/** IANA timezone every helios store operates in (all NYC). */
export const HELIOS_RETAIL_TZ = 'America/New_York'

/**
 * Hour (NY-local) at which the retail business day rolls over. A
 * transaction at or after 08:00 ET belongs to that calendar date's
 * business day; one before 08:00 ET belongs to the previous business day.
 */
export const HELIOS_BUSINESS_DAY_START_HOUR = 8
