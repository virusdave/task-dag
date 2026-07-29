# Authenticated Helios page captures without Playwright

Use Chrome DevTools Protocol (CDP) directly when an agent needs real desktop
and mobile render evidence but Playwright is unavailable. This workflow needs
no operator login or interaction: it serves the current local build on
loopback, reads production data through Helios, signs a local-only session
cookie, and asks headless Chromium for a full-page screenshot.

## Safety and resource boundaries

- Build and serve only from an ephemeral checkout. Bind the capture server to
  `127.0.0.1` on a non-production port; never restart a production service.
- Set `NODE_ENV=test`, a one-use `SESSION_COOKIE_SECRET`, and
  `PGOPTIONS='-c default_transaction_read_only=on'`. The last setting makes the
  database reject writes even if rendered JavaScript unexpectedly attempts a
  mutation. Do not click controls or invoke page JavaScript from the capture
  controller.
- Treat the production database URL and signed cookie as secrets. Never print
  either. Remove the Chromium profile and temporary controller afterward.
- Chromium is a large action. Wrap the entire server/browser/capture lifecycle
  in `large-action-lock --name chromium-capture`, not only browser startup.
- The named lock is currently the tested resource control: it prevents several
  agents from launching Chromium concurrently. A transient user-systemd cgroup
  was tested, but Chromium 148's zygote repeatedly crashed before opening its
  debugging port, including with single-process flags. Do not copy that broken
  setup or claim cgroup coverage. If capture concurrency is ever desired,
  investigate and validate a cgroup-compatible launch separately first.

## Procedure

1. Build once under the normal heavy-action lock:

   ```sh
   cd helios
   large-action-lock --name helios-build --ttl 300 \
     --label 'rendered page capture' -- \
     env NODE_OPTIONS=--max-old-space-size=8192 npm run build
   ```

2. Run the remaining lifecycle from a temporary shell script under one lock:

   ```sh
   large-action-lock --name chromium-capture --ttl 600 \
     --label 'authenticated Helios captures' -- /tmp/run-helios-captures.sh
   ```

   The script should use `trap` to stop its loopback Helios process, terminate
   every Chromium child carrying its unique `--user-data-dir` argument, wait,
   and remove its temporary profile. Killing only the wrapper PID can leave
   Chromium children writing into the profile. Start Helios from the compiled
   checkout with the sanctioned production `DATABASE_URL`, these additional
   variables, and an unused loopback port:

   ```sh
   export NODE_ENV=test
   export APP_BASE_URL=http://127.0.0.1:4355
   export PORT=4355
   export SESSION_COOKIE_SECRET="$(openssl rand -hex 32)"
   export PGOPTIONS='-c default_transaction_read_only=on'
   node --input-type=module -e \
     "import('./dist/server/server/app/buildServer.js').then(async ({buildServer}) => { const server=await buildServer(); await server.listen({host:'127.0.0.1',port:4355}); })" &
   ```

3. Start headless Chromium inside the already-held lifecycle lock. Use a unique
   profile and debug port when another capture could plausibly exist. On NixOS,
   resolve the current Chromium store binary rather than assuming it is linked
   into PATH:

   ```sh
   CHROMIUM=$(find /nix/store -maxdepth 4 -type f -path '*/bin/chromium' -print -quit)
   test -n "$CHROMIUM"
   "$CHROMIUM" --headless=new --no-sandbox --disable-gpu \
     --remote-debugging-port=9223 \
     --user-data-dir="/tmp/helios-capture-profile-$$" \
     --no-first-run --noerrdialogs --ozone-platform=headless \
     --ozone-override-screen-size=800,600 --use-angle=swiftshader-webgl \
     about:blank &
   ```

4. A small Node controller can use the built-in `fetch` and `WebSocket` APIs;
   no browser automation package is required. Its CDP sequence is:

   1. `PUT http://127.0.0.1:9223/json/new?about%3Ablank` and connect to the
      returned `webSocketDebuggerUrl`.
   2. Sign an existing active user's numeric ID with
      `new cookieSigner.Signer(process.env.SESSION_COOKIE_SECRET)` from
      `@fastify/cookie`, then call `Network.setCookie` for the loopback URL.
      Use the least-privileged user that can render the target state.
   3. Call `Emulation.setDeviceMetricsOverride` with desktop or mobile width,
      `Page.navigate`, and wait for the page's
      `data-helios-capture-ready="true"` marker or a bounded settling delay.
   4. Read `Page.getLayoutMetrics().cssContentSize.height`, cap it at 40,000
      pixels, apply that height, and call `Page.captureScreenshot` with
      `captureBeyondViewport: true` and `fromSurface: true`.
   5. Decode the returned base64 data to PNG, or request JPEG with an explicit
      quality for very tall evidence captures.
   6. Close the CDP target through `/json/close/<target-id>`.

5. Inspect every output with `view_media` before treating it as evidence. Local
   test-mode renders can show OAuth, Sweed, worker, or configuration warnings
   because the harness intentionally lacks production service credentials.
   Do not report those as production defects without corroboration.

   Do **not** hand several tall, full-page captures to Oracle with an open-ended
   request to inspect them. Oracle may launch highly parallel Tesseract OCR;
   one such review saturated the host and risked OOM reaping other workers.
   First crop or downscale evidence under `large-action-lock`, then tell Oracle
   explicitly not to launch OCR-heavy subprocesses. If OCR is actually needed,
   run it directly under the same named lock and a bounded systemd unit rather
   than delegating it to an unconstrained review process.

6. For operator review, do not link directly to `upload-to-mss` image objects:
   that service can return them as binary downloads. Upload an HTML index that
   embeds each object with `<img src="…">`, and share the index URL. Verify the
   index is reachable after upload.

## What this proves

The screenshot is a real Chromium rendering of the checkout's built client and
server against real database rows at the chosen viewport. It does **not** prove
that production has the same environment configuration, nor does it replace a
post-deploy health check. Record the source commit, viewport, target URL, and
whether the capture occurred before or after deployment with the evidence.
