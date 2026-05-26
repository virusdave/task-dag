// One-off backfill harness for the weather_daily ingest worker.
//
// Drives the same `runIngestWeatherDailyJob` entry point the worker
// uses on its 06:00 ET tick, but forces `backfillStartIsoDate` to
// "2024-01-01" (per the issue) so a fresh deploy can pull the full
// historical range in one call rather than waiting for the cold-
// start auto-derivation. Idempotent: re-runs against an already-
// populated `weather_daily` re-upsert the same rows.
//
// Usage:
//   DATABASE_URL=postgres://... \
//     npx tsx scripts/backfill-weather-daily.ts [--start=YYYY-MM-DD]

import { runIngestWeatherDailyJob } from '../src/worker/jobs/ingestWeatherDailyJob.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let start = '2024-01-01'
  for (const arg of args) {
    if (arg.startsWith('--start=')) {
      start = arg.slice('--start='.length)
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    throw new Error(`Invalid --start value: ${start}`)
  }

  // eslint-disable-next-line no-console
  console.log(`[backfill-weather-daily] forcing backfillStartIsoDate=${start}`)
  await runIngestWeatherDailyJob(
    {
      id: -1,
      jobType: 'config.workers.weather_daily_ingest',
      module: 'config',
      payload: {},
      scope: null,
    },
    {
      trigger: 'manual_run',
      trailingDays: 7,
      backfillStartIsoDate: start,
    },
  )
  // eslint-disable-next-line no-console
  console.log('[backfill-weather-daily] complete')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[backfill-weather-daily] FAILED:', err)
    process.exit(1)
  })
