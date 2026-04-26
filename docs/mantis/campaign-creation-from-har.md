# Mantis Campaign Creation From HAR

This note captures what was directly observable in the latest Mantis HAR from the advertiser campaign-creation flow.

The current source capture is [`../../ads/mantis/admin.mantisadnetwork.com_Archive [26-04-18 10-15-02].har`](../../ads/mantis/admin.mantisadnetwork.com_Archive%20%5B26-04-18%2010-15-02%5D.har).

For the shared private-LLM access policy that now governs Mantle, Oracle, Painter, and trial-scoped model use across the workspace, start with [`../../HOW_PRIVATE_LLM_ACCESS_WORKS.md`](../../HOW_PRIVATE_LLM_ACCESS_WORKS.md).

## Scope Of The Capture

- Logged-in advertiser session on `admin.mantisadnetwork.com`
- Creating a new banner or display campaign for advertiser `69e3902ab81635e40011a093` (`Freshly Baked NYC`)
- Moving through the wizard path `type -> settings -> budgeting -> creatives`
- The HAR reaches the creatives page, but no actual asset upload request was captured yet

## Session Model

- Authentication is cookie-backed. The captured create or update calls relied on the browser session cookie `connect.sid` rather than a bearer token.
- REST-style admin endpoints and support endpoints carried tracking query params such as `livesession`, `uuidc`, `uuidp`, and `timezone`. These looked auxiliary rather than part of the business payload.
- GraphQL calls went to `/graphql` with JSON bodies and the same ambient cookie session.
- No CSRF header or `Authorization` header was present in the captured write calls.

## High-Level Request Flow

1. Load advertiser or account state with GraphQL.
2. Create a draft campaign with a JSON `POST` to the advertiser campaign collection.
3. Rehydrate campaign state with GraphQL after each wizard step.
4. Populate geography selectors from `/support/country...` lookup endpoints.
5. Save settings with a JSON `POST` to the specific campaign resource.
6. Save budget or bid settings with another JSON `POST` to the same campaign resource.
7. Navigate to the creatives step, where the UI shows a dropzone, but the HAR ends before any upload request fires.

## GraphQL Reads Observed

### Advertiser Account

- Endpoint: `POST /graphql`
- Query head: `query AdvertiserAccount($advertiserId: ID!)`
- Variables:

```json
{
  "advertiserId": "69e3902ab81635e40011a093"
}
```

- Useful response fields in this HAR:
  - advertiser name and website
  - advertiser roles
  - seat and billing flags
  - `allowGeotargetingRegion`, `allowGeotargetingMetro`, `allowGeotargetingPostal`, `allowGeotargetingFull`
  - `allowRichMediaCreatives`

Observed value note: those `allowGeotargeting*` flags came back `false` in this capture even though the UI still let the advertiser save a postal or radius target. Treat them as advisory until proven otherwise.

### Campaign List

- Query head: `query AdvertiserCampaignList($advertiserId: ID!, $filter: AdvertiserCampaignFilter!)`
- Variables:

```json
{
  "advertiserId": "69e3902ab81635e40011a093",
  "filter": "UNARCHIVED"
}
```

- Response in this HAR was empty for wizard, submitted, and campaign lists before creation.

### Campaign Detail

- Query head: `query AdvertiserCampaign($campaignId: ID!, $advertiserId: ID!)`
- This is the main rehydration query after create and each save.
- It returns core campaign state, `version`, targeting fields, bid or budget fields, attached ads or creatives, and advertiser capability flags.

### Advertiser Steps

- Query head: `query AdvertiserSteps($advertiserId: ID!)`
- Response was an empty `steps` array in this capture.

## Create Campaign Draft

- Endpoint:

```text
POST /advertiser/69e3902ab81635e40011a093/campaign
```

- Captured request body:

```json
{
  "campaignType": "banner"
}
```

- Key response behavior:
  - returns the full new campaign object immediately
  - campaign type normalized to `DISPLAY`
  - returns the new campaign `id`
  - initial `version` was `1`
  - initial generated name was `New Campaign - April 18th, 2026`
  - returned defaults included `deviceTypes`, blank `locations`, default caps, and empty `ads`

In the captured draft response, Mantis also created backing or default structures such as `retargeting`, default US or CA location stubs, and bid minimums.

## Geography Lookup Endpoints

These drove the settings screen selectors and can be reused when building valid targeting payloads.

- `GET /support/country`
  - returns country list objects like `{ "id": "US", "name": "United States" }`
- `GET /support/country/US`
  - returns US states or regions like `{ "id": "NY", "name": "New York" }`
- `GET /support/country/US/NY/metro`
  - returns metro list including `501 New York, NY`
- `GET /support/country/US/NY/postal`
  - returns valid postals for the region, including `10020`

## Save Campaign Settings

- Endpoint:

```text
POST /advertiser/69e3902ab81635e40011a093/campaign/69e390693d52be001a3f99d3
```

- Captured request body:

```json
{
  "from": null,
  "priority": null,
  "multipleAdvertiser": null,
  "zones": [],
  "name": "2604 - Midtown Opening",
  "url": "https://freshlybaked.nyc/stores/midtown/shop/menu?modal=locations",
  "campaignGoal": "conversions",
  "locations": [
    {
      "metro": null,
      "country": "US",
      "region": "NY",
      "postal": "10020",
      "radius": "3"
    }
  ],
  "deviceTypes": ["PHONE", "TABLET", "DESKTOP"],
  "maxImpressions": null,
  "maxImpressionsNonViewable": null,
  "dailyImpressions": null,
  "end": "",
  "hours": null,
  "operatingSystems": null,
  "frequencyAmount": null,
  "start": "2026-04-18T04:00:00.000Z",
  "enable_end": false,
  "retargeting": {
    "trigger": null,
    "type": "any",
    "days": 30,
    "filters": []
  },
  "enable_time": false,
  "enable_operating_systems": false,
  "frequency": null,
  "impression": null
}
```

- Response was minimal:

```json
{
  "version": 2
}
```

Practical implication: treat the REST save as an optimistic write that only returns the bumped version, then fetch full state again with `AdvertiserCampaign`.

## Save Budgeting Step

- Same campaign-resource endpoint as above.
- Captured request body:

```json
{
  "campaignDailyBudget": "25",
  "maxDesktopCpc": null,
  "maxMobileCpc": null,
  "maxDesktopCpm": 10,
  "maxMobileCpm": 10,
  "maxNeDesktopCpm": null,
  "maxNeMobileCpm": null,
  "version": 2
}
```

- Response:

```json
{
  "version": 3
}
```

Version is clearly part of the write contract once the draft exists. If automating this, fetch or track the latest version before issuing the next save.

## Creative Step Findings

- The app navigated to the creatives step after the budget save.
- Intercom and LiveSession telemetry confirm the route was the creatives page.
- LiveSession DOM selectors show a drag or drop uploader `div.dropzone___DM-37` and side guidance panel.
- No asset upload request, multipart form, or creative-create API call was captured in this HAR.

Current conclusion: this HAR is enough to automate campaign draft creation, targeting save, and budget save, but not yet enough to automate the actual creative upload path.

## Useful Automation Notes

- Use GraphQL only for reads discovered so far. The writes in this capture were plain JSON POSTs.
- The campaign save endpoint is reused across steps; the meaning changes based on payload shape.
- The server accepted string values for some numeric-looking fields in the UI payload such as `campaignDailyBudget` and `radius`.
- The write endpoints appear tolerant of many explicit `null` fields; the browser sent a broad shape instead of a sparse patch.
- A safe automation loop for this flow is:

```text
AdvertiserAccount -> Create draft -> AdvertiserCampaign -> support lookups -> Save settings -> AdvertiserCampaign -> Save budget -> AdvertiserCampaign
```

## Still Missing

- Creative upload endpoint and payload shape
- Whether static images, hosted URLs, or both are supported by the same uploader
- Whether ad names or sizes are inferred from image dimensions or explicitly provided in a follow-up request
- Submission or approval endpoint after creatives are attached

## Recommended Next Capture

Capture one clean HAR that starts on the creatives step and includes:

1. one successful static image upload
2. any per-creative metadata entry
3. the final submit or launch action if available

That should expose the remaining asset-side contract cleanly.
