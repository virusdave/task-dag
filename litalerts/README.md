# litalerts/

Tooling for talking to Lit Alerts from the FreshlyBakedNYC automation
stack.

## Two distinct APIs — do not confuse them

| Surface | Host | Auth | Used by |
|---------|------|------|---------|
| **Partner API** (official) | `https://partnerapi.litalerts.com` | Long-lived JWT API token issued by Lit Alerts (`Authorization: Bearer <token>`) | New code: anything in this directory, plus future migrations |
| **Brands console / public-api** (consumer/internal) | `https://public-api.litalerts.com` (called from `brands.litalerts.com`) | Short-lived (~24 h) Cognito access token from an operator's personal Lit Alerts account | Legacy: [`helios/src/worker/pricing/litAlertsMarket.ts`](../helios/src/worker/pricing/litAlertsMarket.ts) — `/Manufacturers/real`, `/Dispensaries/alllocations`, `/Products/menulistings` |

The partner API is the supported, contract-stable surface. Always
prefer it over the consumer endpoints. The brands-console flow is
kept alive only because the partner API does not (yet) expose the
menu-listing / dispensary-directory endpoints that the Helios pricing
flow depends on. **Do not write new code against the consumer
endpoints.** The personal-account auth scripts that used to live in
this directory (`authenticate_with_password.py`, `auth_step1_initiate.py`,
`auth_step2_complete.py`, `refresh_bearer_token.py`) are kept only for
emergency rotation of the legacy Helios bearer; nothing else should
call them.

## Partner API

- **Swagger UI**: <https://partnerapi.litalerts.com/swagger/index.html>
- **OpenAPI JSON**: <https://partnerapi.litalerts.com/swagger/v1/swagger.json>
- **Auth scheme**: HTTP Bearer, JWT format. Set
  `Authorization: Bearer <token>` on every request. No other headers
  are required.
- **How to obtain a token**: email `support@litalerts.com` and request
  a partner API token. The token is long-lived; treat it like any
  other long-lived API credential.

### Endpoints (v1)

All requests are `GET` and return JSON. `state` is a USPS abbreviation
(`NY`, `NJ`, `CT`, etc.); dates are formatted `MM-dd-yyyy`.

| Tag | Method | Path | Purpose |
|-----|--------|------|---------|
| Analytics | GET | `/v1/market/brands` | Brand-level market summary for a date range |
| Analytics | GET | `/v1/market/categories` | Category-level market summary |
| Analytics | GET | `/v1/market/retailers` | Retailer-level market summary |
| Analytics | GET | `/v1/market/trend` | Time-series market trend |
| Analytics | GET | `/v1/brand/{brandId}/categories` | Per-brand category breakdown |
| Analytics | GET | `/v1/brand/{brandId}/retailers` | Per-brand retailer breakdown |
| Analytics | GET | `/v1/brand/{brandId}/trend` | Per-brand time-series |
| Analytics | GET | `/v1/retailer/{retailerId}/brands` | Per-retailer brand breakdown |
| Analytics | GET | `/v1/retailer/{retailerId}/categories` | Per-retailer category breakdown |
| Analytics | GET | `/v1/retailer/{retailerId}/trend` | Per-retailer time-series |
| Brands | GET | `/v1/brands` | List brands |
| Brands | GET | `/v1/brands/{brandId}/products` | Products for one brand |
| Brands | GET | `/v1/brands/{brandId}/inventorychanges` | Inventory changes for one brand |
| Retailers | GET | `/v1/retailers` | List retailers |
| Retailers | GET | `/v1/retailers/{retailerId}/products` | Products for one retailer |
| Retailers | GET | `/v1/retailers/{retailerId}/inventorychanges` | Inventory changes for one retailer |
| Events | GET | `/v1/events/eventsforbrand/{brandid}` | Brand events feed |
| System | GET | `/v1/categories` | Category dictionary |
| System | GET | `/v1/subcategories` | Subcategory dictionary |
| System | GET | `/v1/weights` | Valid weight filter values |

### Where the token lives

On `vps-nixos-3`, the token is materialised by agenix (see
[nixos-sbc](https://github.com/Nicponskis/nixos-sbc) →
`hosts/per-host/vps-nixos-3.nix`, secret
`litalerts-partner-api-token`) to:

```
~amp-local/.secret/litalerts/partner-api-token
```

(mode `0400`, owned by `amp-local`, no trailing newline.)

The encrypted source lives at
`secrets/vps-nixos-3/litalerts-partner-api-token.age` in the
nixos-sbc repo. The operator-facing rotation runbook is at
`docs/helios-token-rotation/litalerts-partner-api-token.md` (also
shipped to the host under `/etc/helios-token-rotation/`).

### Sample request

```bash
TOKEN=$(cat ~amp-local/.secret/litalerts/partner-api-token)

# List brands the token has access to.
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://partnerapi.litalerts.com/v1/brands | jq '. | length'

# Market-level brand summary for NY for the trailing 7 days.
END=$(date +%m-%d-%Y)
BEGIN=$(date -d '7 days ago' +%m-%d-%Y)
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://partnerapi.litalerts.com/v1/market/brands?state=NY&beginDate=${BEGIN}&endDate=${END}" \
  | jq '.summaryValues | length'
```

A `401` means the token is missing, malformed, or revoked — request a
fresh one from `support@litalerts.com` and follow the rotation doc.

## Legacy personal-account scripts (do not use for new work)

These remain only because the Helios pricing flow still needs a
brands-console bearer until the partner API exposes equivalent
endpoints:

- [`authenticate_with_password.py`](./authenticate_with_password.py)
- [`auth_step1_initiate.py`](./auth_step1_initiate.py)
- [`auth_step2_complete.py`](./auth_step2_complete.py)
- [`refresh_bearer_token.py`](./refresh_bearer_token.py)

They write to `~amp-local/.secret/litalerts/bearer-token` (note the
distinct filename from the partner token). See
[`docs/helios-token-rotation/litalerts-bearer-token.md`](https://github.com/Nicponskis/nixos-sbc/blob/master/docs/helios-token-rotation/litalerts-bearer-token.md)
in nixos-sbc for the rotation procedure they support.
