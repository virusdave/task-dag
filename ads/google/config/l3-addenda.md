<!-- Seed addenda. Will be overwritten by run-l3-analysis.ts on its
     first successful daily run; until then these observations come
     from the operator's audit of the morning bundles produced
     before per-family LLM batching landed. Do not hand-edit. -->

### What we learned from the last batch of L2 runs

- The previous runs produced ~80% pause actions across the morning
  bundles. The operator's GOAL is to re-enable revenue, not to
  triage impaired ads into the trash. Default to `repair`; reserve
  `pause` for ads where you can name a specific unfixable policy
  violation in the justification (and even then the csv-generator
  caps pauses at 10% of family size, so pause-spam is wasted output).
- "Approved limited, but high number of disapprovals in family.
  Likely a subtle policy violation." was emitted as the justification
  for many pauses in a row. Each impaired ad has its own headlines,
  descriptions, and reason for being limited — write a per-ad
  justification grounded in the specific creative content, not a
  template that could apply to anything.
- Ad IDs sometimes carry the `csyn-` prefix (synthetic content-hash
  ids for ads where Google Ads Editor hasn't synced a numeric ID
  yet). These ARE valid ad_ids in the snapshot; do not strip or
  re-format the prefix. Match `impaired_ads[*].ad_id` verbatim.
