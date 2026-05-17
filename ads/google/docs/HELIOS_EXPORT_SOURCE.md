# Google Ads export source for Helios

## Canonical Drive folder

All Google Ads Editor exports (tab-separated CSV form) live in this folder:

**https://drive.google.com/drive/folders/1zaGxH-nY1ARF9VyddDbs5oO7OUawaTbL**

The folder is shared "Anyone with the link can view" so we can pull
individual files via direct download without an OAuth flow. We do **not**
currently have Drive folder-listing credentials, so the operator must
hand the ingestion the specific file URL or ID (the helios `/ads` page
has an input field for this; see "How operators use it" below).

## Pipeline this feeds

```
Drive file ID
  → curl download → /tmp/google-ads-export-utf8.csv
    → ads/google/scripts/convert-csv-to-snapshot.py
      → ads/google/snapshots/ads-snapshot-live.jsonl
    → ads/google/scripts/build-experiments-viz.py
      → ads/google/outputs/experiments-viz.html (+ embedded ZIP bundle)
    → scripts/upload-to-mss
      → public oauth-proxied URL on vpn-helios.freshlybaked.us
```

## How operators use it

1. Drop a new export into the Drive folder above. Make sure the file
   is shared "Anyone with the link can view" (the folder-level share
   usually inherits to new uploads).
2. That's it. Helios polls the folder every ~30s, notices the new
   newest CSV, and runs the whole pipeline automatically.
3. The result page is at `https://vpn-helios.freshlybaked.us/ads` —
   it shows the current latest file, the last successful ingest, and
   a link to the current public experiments URL.

To force an immediate check, click **Ingest now** on the same page.

For CLI/host-side use, the same pipeline is exposed by:

```bash
ads/google/scripts/ingest-drive-export.sh <drive-file-url-or-id>
```

which prints a JSON object with the resulting public URL on stdout.

## One-time setup: Drive API key for auto-discovery

Listing the Drive folder needs a credential. Because the folder is
shared "Anyone with the link can view", a read-only **API key** is
sufficient (no OAuth flow, no refresh tokens, no service account).
Mint one once and Helios is hands-off forever.

1. Open https://console.cloud.google.com/apis/credentials in the
   `freshlybakedus` (or equivalent) GCP project.
2. **+ Create credentials → API key**. Copy the value.
3. Click the new key, **Restrict key**:
   - **API restrictions** → restrict to **Google Drive API**.
   - **Application restrictions** → optional but recommended:
     restrict by IP to the helios host's egress IP.
4. On the helios host:
   ```bash
   install -d -m 700 ~/.secret/google-drive
   printf '%s' '<API_KEY>' > ~/.secret/google-drive/api-key
   chmod 600 ~/.secret/google-drive/api-key
   ```
5. Rotation is one command: overwrite that file. No restart needed —
   the key is re-read from disk on every poll.

Until the key is in place, the helios `/ads` page surfaces a clear
"not configured" banner and the manual paste flow stays available
as a fallback.

## Why polling instead of webhooks

Drive push notifications (`files.watch`) require a public HTTPS
endpoint Google can reach and channels expire every ~7 days. For a
single human-scale folder, 30s polling is the right KISS trade-off:
~2,880 calls/day, well inside the Drive API free tier.

If we ever need sub-30s latency or the folder becomes private,
upgrade paths are:
- Service account at `~/.secret/google-drive/service-account.json`
  (share the folder with the SA email as viewer).
- `files.watch` push channel renewed by a periodic job.
