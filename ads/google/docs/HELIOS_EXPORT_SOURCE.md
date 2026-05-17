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

1. In the Drive folder above, open the latest Ads Editor export, click
   **Share** → make sure "Anyone with the link can view" is set.
2. Copy the file URL (or just the file ID — the part after `/file/d/`
   or `?id=`).
3. Visit `https://vpn-helios.freshlybaked.us/ads` (the helios "Ads
   ingest" page).
4. Paste the URL/ID into the input, click **Ingest latest from Google
   Drive**.
5. The page shows the new public URL when the pipeline finishes.

For CLI/host-side use, the same pipeline is exposed by:

```bash
ads/google/scripts/ingest-drive-export.sh <drive-file-url-or-id>
```

which prints a JSON object with the resulting public URL on stdout.

## Why we don't auto-pick "latest"

Listing a Drive folder requires either an API key or an OAuth token
with `drive.readonly` (or stricter) scope. The repo's existing
`~/.secret/google-ads` refresh token is for the Google Ads API only
and currently returns `invalid_grant` anyway. Adding a Drive OAuth
flow + refresh-token storage is a separate project; until then,
operator-selected file ID is the reliable minimum.

When the manual paste becomes friction, the upgrade path is:
- add a server-side Drive API client (`googleapis` is already a
  transitive dep via `google-auth-library`),
- list the folder by `modifiedTime desc`,
- pick the newest CSV automatically.
