# Catalog image uploads — durable icebox staging in /cloud

Epic plan for moving Helios catalog-maintenance image uploads off
ephemeral local disk and onto the shared `/cloud` storage box so that
**every** captured image is durably archived from the moment the
operator's phone uploads it.

## Why

Today the staging path
(`HELIOS_PENDING_UPLOAD_DIR=/var/lib/helios/pending-image-uploads/`)
exists only as a transient handoff between the Fastify route and the
worker job. As soon as the Sweed upload succeeds the bytes are
deleted. We keep no original of what the operator captured.

The operator wants **an icebox**:

* Bytes are durable from the instant POST returns 202.
* Easy to recover the original file if Sweed loses it or we need to
  re-derive a different rendition later.
* A trivial swap-out for a real S3 bucket later.

`/cloud` is sshfs-mounted to a 1 TB Hetzner storage box on every host
that runs Helios, so it works for the server (writing the bytes) and
for the worker (reading them back). No new infra.

## Layout

```
/cloud/data/fbnyc/icebox/sweed/images/
  <YYYY>/<MM>/<DD>/<HH>/<MM>-<uuid>.<ext>
  <YYYY>/<MM>/<DD>/<HH>/<MM>-<uuid>.<ext>.meta.json
```

Example:

```
/cloud/data/fbnyc/icebox/sweed/images/2026/05/18/14/07-9b0a…f7.jpg
/cloud/data/fbnyc/icebox/sweed/images/2026/05/18/14/07-9b0a…f7.jpg.meta.json
```

The minute-prefix-then-uuid scheme keeps the file listings sortable
chronologically at every depth, and the directory fan-out keeps any
single directory comfortably small even at several uploads per minute.

## Behavioural change

* `LocalFsPendingImageUploadStore.put()` writes to the date-partitioned
  path above. `stagedRef` is now a relative path like
  `2026/05/18/14/07-9b0a…f7.jpg` rather than a flat
  `<uuid>.<ext>`.
* `read()` and `delete()` resolve the ref against the base dir with a
  hardened `assertSafeRef` that tolerates `/` but still rejects `..`
  and absolute paths.
* `delete()` becomes a **no-op** — the icebox is forever. The existing
  worker-job call to `store.delete(stagedRef)` is kept (and now does
  nothing) so we don't have to thread "completed" status into the
  store API just to satisfy archival semantics.
* `listOlderThan()` walks the date tree recursively (still correct for
  any external cleanup tooling that might want it, even though we
  don't run cleanup on the icebox).
* The default `HELIOS_PENDING_UPLOAD_DIR` becomes
  `/cloud/data/fbnyc/icebox/sweed/images`. Hosts that want the old
  ephemeral location can keep setting the env var explicitly.

## Future S3 swap

`HELIOS_PENDING_UPLOAD_BACKEND=s3` is already a designed knob in
`getPendingImageUploadStore()`. When we cut over, the new
`S3PendingImageUploadStore` lands behind the same `stagedRef` →
date-prefixed-key contract and the rest of the system is unchanged.

## Task breakdown

1. **icebox-store** — switch `LocalFsPendingImageUploadStore` to the
   date-partitioned layout above; turn `delete()` into a no-op;
   recursively-walk `listOlderThan()`; relax `assertSafeRef` to
   allow `/` separators while still blocking traversal.
2. **icebox-default-dir** — default `HELIOS_PENDING_UPLOAD_DIR` to
   `/cloud/data/fbnyc/icebox/sweed/images`.
3. **deploy + verify** — push, redeploy on prod, capture a phone
   upload, confirm bytes land at the icebox path and survive after
   the worker job succeeds.
