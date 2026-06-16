import { describe } from 'vitest'

// Opt-in gate for tests that boot the FULL Fastify app via buildServer().
//
// buildServer() does not just register routes: it starts live background
// DB machinery — the visitor-scans LISTEN/NOTIFY listener and the ads
// drive poller — which open Postgres connections and RETRY on timers. With
// no reachable test Postgres those retries fire ECONNREFUSED repeatedly,
// including AFTER a test has torn its server down, surfacing as
// "unhandled error outside of a test" and failing the run. The heavy
// app-boot also straddles vitest's timeout on our small, swap-bound
// agent hosts. None of that is a real product failure — it is just the
// app running without its database — but it makes a no-DB run flaky and
// noisy.
//
// These are genuine full-server integration smokes, so we gate rather
// than delete them:
//
//   • Default (no DB): the suite SKIPS deterministically, so a clean
//     checkout / parallel-agent run is green, fast, and quiet.
//   • With a provisioned test Postgres: export HELIOS_TEST_DB=1 (the DB
//     must match the DATABASE_URL the suites set,
//     postgres://helios:helios@127.0.0.1:5432/helios_test) — e.g.
//     `npm run test:db` — and they run at full strength and gate.
//
// CI / a DB-provisioned runner MUST run `npm run test:db` so this
// integration coverage (auth gate, OAuth redirect handling, webhook
// auth, CSRF/origin validation) is exercised somewhere on every change.
//
// This module is NOT a test file (no *.test.ts suffix) and lives under
// __tests__/, so the server/client tsconfigs exclude it from the build
// and vitest never collects it as a suite — it is only imported by the
// gated test files.

/** True when a test Postgres is available and the DB suites should run. */
export const hasTestDatabase = process.env.HELIOS_TEST_DB === '1'

/**
 * `describe` that runs only when a test Postgres is available
 * (`HELIOS_TEST_DB=1`); otherwise the whole suite is skipped cleanly.
 * Skipped suites show as "skipped" in the report — visible, not silently
 * dropped.
 */
export const describeRequiresTestDb = describe.skipIf(!hasTestDatabase)
