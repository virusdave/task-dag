# Review Packets

This doc captures the reusable reviewer-packet pattern now used by the Midtown conquest creative review flow.

## Reference Implementation

- Builder: `ads/google/build_midtown_conquest_creative_review.py`
- Served packet: `ads/google/midtown_conquest_creative_review_<date>/index.html`
- Packet client: `ads/google/midtown_conquest_creative_review_<date>/review-client.js`
- Local save service: `ads/google/serve_midtown_conquest_creative_review.py`
- Midtown brands-conquest variant: `ads/google/prepare_midtown_brands_conquest_attach_plan.py` writing `ads/google/midtown_brands_conquest_review_<date>/`
- Midtown brands-conquest save service: `ads/google/serve_midtown_brands_conquest_review.py`
- Policy-limited asset replacement variant: static packet at `ads/google/policy/asset_policy_limited_replacement_plan_<date>_<hhmmss>.{html,json}`. The canonical reviewer surface is the Helios `communications` module at `/communications/policy-replacements/<packetId>`, backed by `helios/src/server/routes/communications.ts`; `ads/google/serve_asset_policy_limited_replacement_review.py` is retained only as an offline fallback when Helios is unavailable. The packet keeps four reviewable item kinds (`visual-N`, `headline-N`, `long-headline-N`, `description-N`, `template-family-N`) plus mapping rows (`text-map-N`) that bind a limited current text to a chosen replacement category and source asset. Edits to a source asset cascade into every mapping row whose selected source matches; mapping rows visually inherit the source asset's accept/reject/hold state.

## Requirements

- Keep the packet reviewer-first and local-first. The packet can save reviewer state locally, but it must not mutate Google Ads as part of normal review.
- Treat Google Ads UI exports such as the asset-association report as planning inputs, not apply-ready source of truth. The export can identify limited asset text/URLs and status counts, but it does not include enough live owner/resource-name detail to mutate safely, so any apply runner must do a narrow post-review resolver pass before validate-only/live mutate.
- Keep blocked competitors visible in the same packet instead of silently omitting them. The nav must expose those entries under a separate blocked/source-gap branch.
- Use a left sidebar tree instead of a flat jump list when the packet contains many competitors and many per-competitor sections.
- When the packet includes conquest tone review, keep a dedicated section that shows grounded slogan or About-page evidence and a supplemental competitor-specific humor bank so reviewers can compare the safe core slate against sharper name or slogan riffs.
- The tree must support three hierarchy levels: top-level status groups, per-competitor nodes, and leaf anchor links for section jumps.
- Group nodes and competitor nodes must collapse independently. Do not force a single-open accordion because reviewers often compare multiple nearby competitors in parallel.
- The whole sidebar must also have a separate hide/show control so reviewers can reclaim horizontal space while editing assets.
- Each leaf link must target a stable, deterministic section id derived from packet ids rather than display strings, so regenerated packets keep the same deep links.
- Direct hash loads must reveal the correct location in the tree. If the URL lands on a deep section, the client must expand the matching group and competitor ancestors automatically.
- The active nav leaf should be visually highlighted so the reviewer can tell which section is currently targeted.
- Nav state and review state must stay separate. Tree open/closed state belongs in local browser storage; review decisions and notes belong in the packet's normal review-state flow.
- Mobile layout must fall back to a single-column flow without dropping the tree or the deep-link anchors.
- When the packet includes reusable fallback text families, expose packet-level mass approve / mass reject controls for those families separately from the per-asset review state.
- The Midtown brands-conquest lane uses `unreviewed / accepted / rejected` for both per-asset review and fallback-family review, while still keeping those review decisions separate from the tree-nav persistence state.
- In the Midtown brands-conquest packet, fallback-family cards should also expose editable template-row text with a reusable placeholder such as `{brand}` so reviewers can correct regeneration copy without editing every current asset by hand.
- Keep low-value asset support copy collapsed by default when the packet is text-heavy. The primary visible surface should be the review decision control and the editable copy textarea, with notes and explanatory metadata tucked under a details panel.
- Any live-apply runner fed by a served review packet must reconcile the saved review-state ledger before mutating Google Ads. Do not trust the pre-review packet JSON alone once reviewers can edit text or change decisions in the served UI.
- Live apply should ship only accepted current asset text. If a requested brand no longer has at least the minimum valid RSA after rejected and unreviewed rows are filtered out, hold that brand back explicitly in the artifact instead of silently falling through to stale packet copy.

## Implementation

- The Midtown builder keeps the nav section list in one source of truth: `NAV_SECTION_SPECS` in `build_midtown_conquest_creative_review.py`.
- The Midtown conquest packet's tone-and-humor section now has two jobs: surface grounded source material such as slogans and highlighted claims, then surface a supplemental bank of competitor-specific humor assets derived from that raw material.
- Each competitor gets a stable base anchor in the form `entry-<packetId>`, and each section anchor extends that base, for example `entry-sofaclub-overview` or `entry-sofaclub-review`.
- The generated sidebar uses native HTML `details`/`summary` elements for both status groups and competitor nodes. This keeps the markup simple, accessible, and easy to persist.
- Each collapsible tree node gets a `data-nav-key` attribute. The client uses that key as the persistence handle in `localStorage`.
- Each leaf anchor gets `data-nav-link` plus `data-target-id`. The client uses those attributes to expand ancestors, restore visibility after direct hash navigation, and mark the active link.
- Whole-sidebar visibility is stored separately from node state. In the Midtown packet, the sidebar toggle persists under `midtown-conquest-creative-review-sidebar`, while node open/closed state persists under `midtown-conquest-creative-review-nav`.
- The client should do four nav-specific jobs:
  - restore saved open/closed state for each `details[data-nav-key]`
  - persist each `toggle` event back to local storage
  - expand matching ancestors when a leaf link is activated or when the page loads with a hash
  - highlight the active leaf based on `window.location.hash`
- The sidebar toggle should not interfere with the persisted tree state. Reopening the sidebar should reveal the same tree state the reviewer left behind.
- Nav behavior must not depend on network access. The tree should still work when the review service is offline and the browser is using only the packet HTML plus local browser state.
- In the Midtown brands-conquest packet, fallback-family controls are global packet sections rather than per-brand widgets so a single family decision can suppress or approve all current matching assets and persist separately for future regeneration.
- If a served packet hydrates review state from the save service after the client has already attached handlers, those handlers must re-resolve the current asset or family state on each interaction instead of closing over the pre-hydration object references. Otherwise textarea edits and decision clicks can snap back to default values as soon as the hydrated state replaces the original in-memory maps.
- The same saved review-state reconciliation must happen in the outbound apply path: accepted `editedFields.text` values override the original packet rows, and the apply artifact should record any brands blocked because the accepted subset fell below the lane minimum such as `3` headlines and `2` descriptions for Search RSA creation.

## Reuse Checklist

- Define a stable packet-level id and stable per-entry ids first.
- Decide the section taxonomy up front and encode it in a single section-spec constant instead of duplicating labels and ids across template branches.
- Generate both the sidebar links and the section `id` attributes from that same spec.
- Persist sidebar visibility separately from tree-node state.
- Keep nav persistence keys packet-specific so two different review tools do not overwrite each other's tree state.
- Add an in-packet note that explains the nav model briefly, but keep the full design rationale here in docs.
- If the packet also has durable review-state persistence, keep that storage path and schema independent from the nav-state keys.
- If the packet mixes per-asset review with reusable-family review, store both ledgers under the same saved draft payload but keep them as separate collections so regeneration logic can consume family decisions without inferring them back from asset rows.

## Server-Persisted Draft Endpoints

- The policy-limited asset replacement review has been folded into the Helios `communications` module. Helios is now the canonical reviewer surface and persisted draft store for that packet:
  - `GET /api/communications/policy-replacements/<packetId>/summary` returns the per-category item id counts.
  - `GET /api/communications/policy-replacements/<packetId>/draft` returns the saved draft (`404` when no draft exists yet).
  - `POST /api/communications/policy-replacements/<packetId>/draft` persists a normalized draft. The body must include `packetId`; mismatches are rejected with `409`. `submit: true` stamps `submittedAt` and emits a `communications.policy_replacement_review.submitted` audit event under `module = communications`. Saves emit `communications.policy_replacement_review.draft_saved`.
  - Drafts persist to `communications_policy_replacement_drafts` (one row per `packet_id`); audit fan-out lives in `communications_policy_replacement_audit` and the global `audit_events` table so events show up in `/history` with `module = communications`.
  - The Helios route NEVER mutates Google Ads from review submission alone. The narrow post-review Google Ads resolver pass (validate-only, then live apply, then narrow readback) remains a separate explicit job; only items with `decision == accepted` flow into it.
- All other served review packets in this workspace still expose the legacy minimal endpoint shape so the same Helios fold-in path can wrap them next:
  - `GET /api/<review-name>/draft/latest` returns the saved state (`404` when nothing has been saved yet).
  - `POST /api/<review-name>/draft` writes a normalized state payload. The body must include `packetId`, and the server must reject mismatches with `409`.
  - The state schema is `{version, packetId, savedAt, items}` for review-item-keyed packets such as the policy-limited asset replacement packet, or `{version, packetId, savedAt, assets, templateFamilies}` for asset/family-keyed packets such as the Midtown brands-conquest packet.
  - The policy-limited replacement packet adds a `submit: true` POST flag that stamps a `submittedAt` timestamp on the persisted state file so a reviewer can mark the draft as final without copy/paste.
- The server must validate every inbound id against the loaded packet before persisting and must drop unknown ids. Decision strings, field keys, and replacement-category values must be range-checked rather than trusted from the body.
- Server-persisted submission is necessary precisely because the page must react to form submission (mark submitted, drive a downstream apply step). It is not a substitute for the narrow post-review Google Ads resolver pass: the resolver still has to map current asset text/URLs to live owners, run validate-only, then live apply, then a narrow readback.
- The static HTML packet should keep `localStorage` as an offline fallback so reviewers can still draft state when the backing service is not running, but the server-persisted JSON file is the source of truth for the apply path.
