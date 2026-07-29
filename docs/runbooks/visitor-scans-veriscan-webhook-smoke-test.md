# VeriScan webhook smoke test

> Smoke-test for the live VeriScan webhook handler installed by
> [FreshlyBakedNYC/automation#31](https://github.com/FreshlyBakedNYC/automation/issues/31)
> phase A1 (parent epic
> [virusdave/top-level#9](https://github.com/virusdave/top-level/issues/9)).
>
> Asserts:
>
>   1. POST to `/wh/bx/veriscan/checkin` (or `/wh/mh/...`) with the
>      correct `Authorization: Bearer <token>` returns **200** and
>      writes one row to `visitor_scans`.
>   2. The same POST without the bearer returns **401** and writes
>      no row.
>   3. The same POST replayed inserts no additional row and still
>      returns **200** (idempotency via the
>      `(provider, hash_id)` unique constraint).

## Pre-reqs

You'll need:

* a synthetic VeriScan envelope with a freshly-rolled `HashId` (UUID);
* the bearer token from the helios-server process env (on
  `vps-nixos-3` it's exposed to `helios-server` via the agenix
  secret installed by `Nicponskis/nixos-sbc` N1);
* `psql` access to the helios database so you can confirm the row.

## Synthetic envelope

```bash
HASH_ID="$(uuidgen | tr 'A-Z' 'a-z')"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > /tmp/veriscan-smoke.json <<EOF
{
  "Type": "CreateCard",
  "EventId": 1,
  "WebHookId": 1,
  "WebHookTypeId": 1,
  "Created": "${NOW}",
  "Sent":    "${NOW}",
  "Data": {
    "HashId": "${HASH_ID}",
    "Scanned": "${NOW}",
    "FirstName": "Smoke",
    "LastName":  "Test",
    "Address":   "123 Main St",
    "City":      "Bronx",
    "State":     "NY",
    "PostalCode": "10451",
    "Country":   "United States",
    "CountryCode": "US",
    "DocumentType": "DL",
    "AuthenticationStatus": "Pass",
    "ScanStatus":  "OK"
  }
}
EOF
echo "synthetic HashId=${HASH_ID}"
```

## Run against a local helios-server

```bash
HELIOS_URL="${HELIOS_URL:-http://127.0.0.1:3001}"
TOKEN="${VERISCAN_WEBHOOK_TOKEN:?set me first}"

# 1) Accepted request
curl -i -sS \
  -X POST "${HELIOS_URL}/wh/bx/veriscan/checkin" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  --data-binary @/tmp/veriscan-smoke.json \
  | head -1
# expect: HTTP/1.1 200 OK

# 2) Missing bearer
curl -i -sS \
  -X POST "${HELIOS_URL}/wh/bx/veriscan/checkin" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/veriscan-smoke.json \
  | head -1
# expect: HTTP/1.1 401 Unauthorized

# 3) Replay (idempotent)
curl -i -sS \
  -X POST "${HELIOS_URL}/wh/bx/veriscan/checkin" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  --data-binary @/tmp/veriscan-smoke.json \
  | head -1
# expect: HTTP/1.1 200 OK
```

## DB assertion

```bash
READONLY_DATABASE_URL="$(cat "$HOME/.secret/tigerdata/helios-readonly-url")"
psql "$READONLY_DATABASE_URL" -c "
  select id, site_slug, ingest_source, first_name, last_name, state, postal_code
    from visitor_scans
    where hash_id = '${HASH_ID}'
    order by id;
"
# expect: exactly one row, site_slug='bx', ingest_source='webhook'.
```

The row will also be visible in the Helios UI at
[/admin/visitors/scans](https://helios.freshlybaked.us/admin/visitors/scans).

## Production verification on `vps-nixos-3`

Run the same `curl` snippets against
`https://helios.freshlybaked.us`. The bearer is sourced from the
agenix-encrypted secret `veriscan/webhook-token` and exposed to
`helios-server` via its systemd `EnvironmentFile` as
`VERISCAN_WEBHOOK_TOKEN` (see
[Nicponskis/nixos-sbc#4](https://github.com/Nicponskis/nixos-sbc/issues/4)).
