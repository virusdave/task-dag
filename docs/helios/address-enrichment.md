# Sweed address enrichment (FreshlyBakedNYC/automation#25)

Two-worker pipeline that resolves Sweed orders + customers to
geocoded postal addresses, backing the customer-origin map and
delivery-zone metrics on `/metrics`.

## Data flow

```
                       store.sale.invoice.get        store.customer.get
                                 │                            │
                                 ▼                            ▼
sweed_orders ──┬─→ A4: enrichDeliveryAddressJob    A5: enrichCustomerAddressJob ───┐
               │           │                                 │                       │
               │           ▼                                 ▼                       │
               │     addresses + sweed_orders.delivery_address_id                    │
               │     + sweed_customer_addresses (kind='delivery_seen')               │
               │                                                                     │
               │                                  sweed_customer_addresses           │
               │                                  (kind='primary'; "no-address"      │
               │                                   responses link to a shared        │
               │                                   sentinel addresses row so we      │
               │                                   never re-poll the same customer)  │
               ▼                                                                     │
        addresses (geocode_status='pending')                                         │
                                                                                     │
                                  ▼                                                  │
                            A4 geocode drain                                         │
                            (US Census, 1 RPS)                                       │
                                  │                                                  │
                                  ▼                                                  │
                       addresses with county, zip5,                                  │
                       state_code, latitude, longitude                               │
                                                                                     │
                                                                                     │
        A6 metric queries ◀──────────────────────────────────────────────────────────┘
        (customers.origin_map, delivery.order_count_by_zone)
```

## Components

| Layer                                  | File                                                                            |
|----------------------------------------|---------------------------------------------------------------------------------|
| Schema                                 | `helios/src/server/db/schema/addresses.sql`                                     |
| Migration 037 (addresses + linkage)    | `helios/src/server/db/migrations/037_addresses.sql`                             |
| Sweed RPC wrappers                     | `helios/src/worker/sweed/sales.ts`, `helios/src/worker/sweed/customers.ts`      |
| Geocoder + address upsert helpers      | `helios/src/worker/geocoder/`                                                   |
| Delivery enrichment worker (A4)        | `helios/src/worker/jobs/enrichDeliveryAddressJob.ts`                            |
| Customer enrichment worker (A5)        | `helios/src/worker/jobs/enrichCustomerAddressJob.ts`                            |
| Origin-map metric query (A6)           | `helios/src/server/metrics/_real/sweedOrdersQueries.ts` (`queryCustomerOriginMap`, `queryDeliveryOrderCountByZone`) |

## Scheduler

Both workers run on a 5-minute cadence by default via the existing
`/config/workers` surface:

- `workers.scheduling.enrich_delivery_address` — A4
- `workers.scheduling.enrich_customer_address` — A5

Each enqueues `batchSize=60` rows per tick. With ~1-2 s per Sweed
RPC + 1 RPS Census budget, one tick takes ~1-2 minutes of wall-clock
and well under any known Sweed rate ceiling.

## Operator runbook

1. Apply migration 037 on production via psql.
2. The two scheduler tasks materialise on first boot
   (`ensureDefaultConfigSchedules` seeds the 5-minute windows).
3. Watch `/config/workers` for the two new rows; pause / resume / edit
   schedule windows like any other background task.
4. The origin-map metric on `/metrics` populates from real addresses
   once both workers have made a pass through their respective candidate
   queues. The geocode-drain phase of A4 runs after the per-invoice
   pull so newly-upserted addresses get coordinates without a separate
   worker.
