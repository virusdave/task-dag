import { bootstrapParserRegistry } from '../lib/parsekit/node/index.js'
import { runWorkerLoop } from './runtime/workerLoop.js'
import { triggerStaffPhotoFocalPointsRefresh } from './staff/refreshStaffPhotoFocalPoints.js'

// Initial parser-configs load + arm periodic refresh. Loud-but-non-fatal:
// if the helios-parser-configs repo is unreachable or any config fails
// validation we log and keep running with the legacy parser path.
await bootstrapParserRegistry()

// Compute focal points for any approved staff portraits we don't
// yet have a cached focal point for. Runs at every worker startup
// (including restart / reload, since systemd reload re-execs the
// worker process via ExecReload→SIGHUP→re-trigger; see SIGHUP
// handler below) so that:
//   * a brand-new approval picks up its focal point on the next
//     deploy/reload without needing a separate cron;
//   * a `helios startup / restart / reload / system reload` in the
//     nixos-sbc helios module re-runs the pass.
// Fire-and-forget; the trigger is single-flight and append-only so
// it's safe to call repeatedly.
triggerStaffPhotoFocalPointsRefresh('worker-startup')

// SIGHUP: re-trigger a focal-point refresh pass immediately, without
// restarting the worker process. nixos-sbc's helios-worker.service
// uses `ExecReload=/run/current-system/sw/bin/kill -HUP $MAINPID`
// so that `systemctl reload helios-worker` and the operator-facing
// `helios reload` / `system reload` paths all immediately requeue
// this work as the user explicitly required.
process.on('SIGHUP', () => {
  triggerStaffPhotoFocalPointsRefresh('SIGHUP')
})

await runWorkerLoop()
